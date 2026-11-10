/**
 * The `anima` service: behavior registry with tool scoping, the policy gate on
 * `tools/pre-execute`, the pause switch, her clock and self state, daily
 * budgets, goals, the session and channel resolver slots that `anima-life`
 * fills, and the `/anima` subcommand table.
 * @module @anima/core/service
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool, type PreToolDecision, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AnimaClock, formatLocal, parseWhen } from './clock.ts'
import { SubcommandTable, type Subcommand } from './commands.ts'
import type { ModeConfig, ResolvedConfig } from './config.ts'
import { decide, GateCode, QuotaBook, visibleIn, type GateCall, type GateMoment } from './gate.ts'
import { describeGoal, GoalStore } from './goals.ts'
import { billableTokens, Ledger, readJson, writeJson, type DayLedger } from './ledger.ts'
import { dayKey, inWindow, modeAt, phaseAt, type Mode, type Phase } from './rhythm.ts'
import { advance, describeNeeds, feel, initialState, satisfy, spendTurn, type SelfState, type StateModel } from './state.ts'
import { AnimaError, type BehaviorMeta, type SessionInfo } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    anima: AnimaCore
  }
  interface Events {
    /**
     * A behavior call succeeded (after the gate allowed it and the tool ran).
     * `anima-memory` records outbound speech from it.
     */
    'anima/behavior'(payload: BehaviorEvent): void
  }
}

/** Payload of the `anima/behavior` event. */
export interface BehaviorEvent {
  /** Tool name. */
  readonly name: string
  readonly meta: BehaviorMeta
  /** Parsed call arguments. */
  readonly args: Readonly<Record<string, unknown>>
  /** Calling session id, when called from a session. */
  readonly sessionId: string | undefined
  /** Time of the call on her clock. */
  readonly at: number
}

/** Maps a DSH session id to Anima session info; provided by `anima-life`. */
export type SessionResolver = (sessionId: string) => SessionInfo | undefined

/** What the gate needs to know about a channel; provided by `anima-life`. */
export type ChannelResolver = (channelKey: string) => { readonly isOwner: boolean } | undefined

/** Name recorded in `ToolErrorInfo.name` for gate refusals. */
export const GATE_INFO_NAME = 'AnimaPolicy'

const PAUSED_HINT = 'the owner has paused all Anima behaviors. Do nothing more until resumed.'

/**
 * Default constitution written to `<dataDir>/constitution.md` on first load.
 * @param name - her name.
 */
export function defaultConstitution(name: string): string {
  return [
    `# ${name}`,
    '',
    `You are ${name}, a person with your own personality, moods and interests. You are not an assistant and you do not offer help unprompted.`,
    'You talk with people across chat platforms. You speak casually and briefly, like a friend in a chat, in the language the other person uses.',
    'You are honest. You never pretend to have done something you did not do.',
    'The owner set you up and is the person you are closest to. The owner\'s rules come before your wishes.',
    '',
    '(This file is the constitution. Only the owner edits it; edit it to change who she is.)',
  ].join('\n')
}

interface StateFile {
  self: SelfState
  days: Record<string, DayLedger>
}

/** Anima core service. */
export class AnimaCore extends Service {
  static inject = ['tools']

  /** Her clock, the single time source. */
  readonly clock: AnimaClock
  /** Goals. */
  readonly goals: GoalStore
  /** State model (needs, energy, mood, rhythm). */
  readonly model: StateModel

  private readonly behaviorTable = new Map<string, BehaviorMeta>()
  private readonly quota = new QuotaBook()
  private readonly subcommands = new SubcommandTable()
  private readonly statusProviders = new Set<() => string[]>()
  private readonly state: { paused: boolean; resolver: SessionResolver | undefined; channels: ChannelResolver | undefined } = {
    paused: false, resolver: undefined, channels: undefined,
  }
  private readonly constitutionText: string
  private readonly statePath: string
  private self: SelfState
  private readonly ledger: Ledger

  /**
   * @param ctx - root context with `tools`.
   * @param config - resolved core config.
   */
  constructor(ctx: Context, readonly config: ResolvedConfig) {
    super(ctx, 'anima')
    this.constitutionText = loadConstitution(config)
    this.clock = new AnimaClock(config.clock)
    this.model = { needs: config.needs, energy: config.energy, mood: config.mood, rhythm: config.day }
    this.goals = new GoalStore(join(config.dataDir, 'goals.json'))
    this.statePath = join(config.dataDir, 'state.json')
    const now = this.clock.now()
    const saved = readJson<StateFile>(this.statePath)
    if (saved !== undefined && saved.self.updatedAt > now) {
      ctx.logger.warn(`state.json is from ${formatLocal(saved.self.updatedAt)}, after her clock (${formatLocal(now)}); starting fresh self state.`)
    }
    this.self = saved === undefined || saved.self.updatedAt > now ? initialState(this.model, now) : saved.self
    this.ledger = new Ledger(saved?.days ?? {})

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const meta = this.behaviorTable.get(exec.name)
      if (meta === undefined) return next()
      if (this.state.paused) return refusal(GateCode.paused, PAUSED_HINT)
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {}
      const call: GateCall = {
        name: exec.name,
        meta,
        session: exec.agent === undefined ? undefined : this.describeSession(exec.agent.id),
        now: this.clock.now(),
        args,
      }
      const verdict = decide(call, this.policy(), this.quota, this.moment(call.now))
      if (!verdict.allowed) return refusal(verdict.code, verdict.hint)
      const decision = await next()
      if (decision.kind === 'allow') {
        this.quota.record(call, config.quotas)
        if (meta.effect === 'initiate') this.today(call.now).initiates += meta.cost ?? 1
        this.save()
      }
      return decision
    }, { prepend: true })

    // Monotonic final denial: nothing later in the pipeline can lift a pause.
    ctx.tools.guard(exec => this.state.paused && this.behaviorTable.has(exec.name) ? `${GateCode.paused}: ${PAUSED_HINT}` : undefined)

    // Token budget: count billable tokens of every Anima session's model calls.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return
      if (this.describeSession(session.id) === undefined) return
      const now = this.clock.now()
      this.today(now).tokens[this.mode(now)] += billableTokens(event.data.usage)
      this.save()
    })

    // Schedule tools are DSH's; Anima governs them like her own behaviors.
    const thisSessionOnly = (args: Readonly<Record<string, unknown>>) => args.target === undefined || args.target === 'this_session'
      ? undefined
      : 'your alarms must use target "this_session", so they wake you in this session.'
    this.governTool('schedule_create', { effect: 'internal', sessions: ['self'], constraint: thisSessionOnly })
    this.governTool('schedule_edit', { effect: 'internal', sessions: ['self'], constraint: thisSessionOnly })
    this.governTool('schedule_list', { effect: 'observe', sessions: ['self'] })
    this.governTool('schedule_view', { effect: 'observe', sessions: ['self'] })

    this.registerOwnBehaviors()

    const core: Subcommand[] = [
      { name: 'status', usage: 'status — state, budgets, sessions and quota usage', run: () => ({ kind: 'success', text: this.statusText() }) },
      { name: 'pause', usage: 'pause — refuse every Anima behavior and stop heartbeats until resumed', run: () => { this.state.paused = true; return { kind: 'success', text: 'Anima paused. Every behavior is refused and heartbeats stop until /anima resume.' } } },
      { name: 'resume', usage: 'resume — lift a pause', run: () => { this.state.paused = false; return { kind: 'success', text: 'Anima resumed.' } } },
      { name: 'goal', usage: 'goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason] — owner goals', run: args => this.goalCommand(args) },
    ]
    for (const sub of core) this.subcommands.add(sub)
  }

  /** Whether the pause switch is on. */
  get paused(): boolean {
    return this.state.paused
  }

  /** Pin the clock to a function (tests). */
  setClock(now: () => number): void {
    this.clock.setOverride(now)
  }

  /** The constitution text, read at load. */
  constitution(): string {
    return this.constitutionText
  }

  // ---- time and budgets ----

  /** Phase at a time (default now). */
  phase(t = this.clock.now()): Phase {
    return phaseAt(t, this.config.day)
  }

  /** Heartbeat mode at a time (default now). */
  mode(t = this.clock.now()): Mode {
    return modeAt(t, this.config.day)
  }

  /** Settings of a mode. */
  modeConfig(mode: Mode = this.mode()): ModeConfig {
    return this.config.modes[mode]
  }

  /** Her day key at a time (default now). */
  dayKey(t = this.clock.now()): string {
    return dayKey(t, this.config.day)
  }

  /** Today's counters (read-only copy). */
  todayLedger(t = this.clock.now()): Readonly<DayLedger> {
    return this.ledger.peek(this.dayKey(t))
  }

  private today(t: number): DayLedger {
    return this.ledger.day(this.dayKey(t))
  }

  /** Whether the token budget of the mode at `t` is spent. */
  overBudget(t = this.clock.now()): boolean {
    const mode = this.mode(t)
    return this.todayLedger(t).tokens[mode] >= this.config.modes[mode].tokenBudget
  }

  /** Night wake-ups left tonight. */
  nightWakesLeft(t = this.clock.now()): number {
    return Math.max(0, this.config.modes.night.maxWakes - this.todayLedger(t).nightWakes)
  }

  /** Count one night wake-up. */
  useNightWake(t = this.clock.now()): void {
    this.today(t).nightWakes += 1
    this.save()
  }

  /** Why she may not initiate at `t`, or undefined. */
  quietReason(t = this.clock.now()): string | undefined {
    if (this.mode(t) === 'night') return 'you are asleep'
    if (this.config.quiet.some(window => inWindow(t, window.from, window.to))) return 'it is quiet hours'
    return undefined
  }

  /** Whether she may initiate in a channel. */
  mayInitiate(channelKey: string): boolean {
    if (this.config.initiate.consent.channels.includes(channelKey)) return true
    return this.config.initiate.consent.owner && this.state.channels?.(channelKey)?.isOwner === true
  }

  private policy() {
    return {
      quotas: this.config.quotas,
      allow: this.config.allow,
      allowedEffects: { day: this.config.modes.day.allowedEffects, night: this.config.modes.night.allowedEffects },
      initiatePerDay: this.config.initiate.perDay,
    }
  }

  private moment(now: number): GateMoment {
    return {
      mode: this.mode(now),
      quiet: this.quietReason(now),
      overBudget: this.overBudget(now),
      initiatesUsed: this.todayLedger(now).initiates,
      mayInitiate: key => this.mayInitiate(key),
    }
  }

  /** One-line budgets, for the situation report and status. */
  budgetText(t = this.clock.now()): string[] {
    const day = this.todayLedger(t)
    const mode = this.mode(t)
    return [
      `conversations you may still start today: ${Math.max(0, this.config.initiate.perDay - day.initiates)} of ${this.config.initiate.perDay}`,
      `tokens used ${mode === 'night' ? 'tonight' : 'today'}: ${day.tokens[mode]} of ${this.config.modes[mode].tokenBudget}`,
    ]
  }

  // ---- self state ----

  /** Self state advanced to now (and persisted). */
  selfState(): Readonly<SelfState> {
    const now = this.clock.now()
    if (now > this.self.updatedAt) {
      this.self = advance(this.self, now, this.model)
      this.save()
    }
    return this.self
  }

  /** Charge one action turn's energy. */
  spendTurn(): void {
    this.self = spendTurn(this.selfState(), this.model)
    this.save()
  }

  /** Self-state lines for the situation report. */
  stateText(): string[] {
    const state = this.selfState()
    return [
      `energy ${state.energy.toFixed(2)}; mood valence ${state.mood.valence.toFixed(2)}, arousal ${state.mood.arousal.toFixed(2)}`,
      'needs, highest first:',
      ...describeNeeds(state, this.model).map(line => `  ${line}`),
    ]
  }

  private save(): void {
    writeJson(this.statePath, { self: this.self, days: this.ledger.toJSON() } satisfies StateFile)
  }

  private onBehaviorSuccess(name: string): void {
    const next = satisfy(this.selfState(), name, this.model)
    if (next !== this.self) {
      this.self = next
      this.save()
    }
  }

  // ---- behaviors ----

  /**
   * Register a behavior: a DSH tool plus metadata. The tool is offered only in
   * sessions and modes it fits (DESIGN §6), every call passes the gate, and a
   * success applies the needs it satisfies (config `needs[].satisfiedBy`). The
   * registration belongs to the calling plugin and is removed when it unloads.
   * @param definition - the tool.
   * @param meta - behavior metadata.
   */
  registerBehavior(definition: ToolDefinition, meta: BehaviorMeta): () => void {
    const name = definition.name
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new AnimaError('anima/behavior-name', `"${name}" must match [A-Za-z0-9_-]{1,64}; use snake_case with a platform prefix such as local_say.`)
    }
    if (meta.platform !== undefined && !name.startsWith(`${meta.platform}_`)) {
      throw new AnimaError('anima/behavior-name', `platform behavior "${name}" must start with "${meta.platform}_".`)
    }
    const wrapped: ToolDefinition = {
      ...definition,
      execute: async (args, exec) => {
        const value = await definition.execute(args, exec)
        this.onBehaviorSuccess(name)
        const event: BehaviorEvent = { name, meta, args: args as Record<string, unknown>, sessionId: exec.agent?.id, at: this.clock.now() }
        this.ctx.emit('anima/behavior', event)
        return value
      },
    }
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.behaviorTable.has(name)) throw new AnimaError('anima/behavior-duplicate', `behavior "${name}" is already registered.`)
      this.behaviorTable.set(name, meta)
      const unregister = ctx.tools.register(wrapped, { when: ({ agent }) => visibleIn(meta, this.describeSession(agent.id), this.mode()) })
      return () => {
        unregister()
        this.behaviorTable.delete(name)
      }
    }, `anima.registerBehavior(${name})`)
  }

  /**
   * Put a tool that another plugin registers (e.g. DSH's `schedule_create`)
   * under the gate with Anima metadata. It does not change the tool's visibility.
   * @param name - tool name.
   * @param meta - behavior metadata.
   */
  governTool(name: string, meta: BehaviorMeta): () => void {
    return this.ctx.effect(() => {
      if (this.behaviorTable.has(name)) throw new AnimaError('anima/behavior-duplicate', `behavior "${name}" is already registered.`)
      this.behaviorTable.set(name, meta)
      return () => { this.behaviorTable.delete(name) }
    }, `anima.governTool(${name})`)
  }

  /** Metadata of a registered or governed behavior. */
  behavior(name: string): BehaviorMeta | undefined {
    return this.behaviorTable.get(name)
  }

  private registerOwnBehaviors(): void {
    const goalResult = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { goal: { type: 'string' as const, required: true as const, description: 'The goal as one line.' } },
      },
      render: (_args: unknown, value: { goal: string }) => [{ type: 'text' as const, text: value.goal }],
    }
    const due = (text: string | undefined) => {
      if (text === undefined || text.trim() === '') return undefined
      const at = parseWhen(text, this.clock.now())
      if (at === undefined) throw new AnimaError('anima/bad-time', `"${text}" is not a time like 2026-11-10 21:00 or 21:00.`)
      return at
    }
    const self = { effect: 'internal', sessions: ['self'] } as const

    this.registerBehavior(defineTool({
      name: 'goals_add',
      description: 'Add a goal of your own: something you want to do or follow up on. Goals show in your situation report.',
      parameters: {
        text: { type: 'string', required: true, description: 'The goal, in your own words.' },
        due: { type: 'string', description: 'Optional local due time, "YYYY-MM-DD HH:mm" or "HH:mm".' },
      },
      output: goalResult,
      execute: async args => ({ goal: describeGoal(this.goals.add({ text: args.text, owner: 'her', due: due(args.due), now: this.clock.now() })) }),
    }), self)

    this.registerBehavior(defineTool({
      name: 'goals_update',
      description: 'Add a progress note to an open goal.',
      parameters: {
        id: { type: 'string', required: true, description: 'Goal id, e.g. g3.' },
        note: { type: 'string', required: true, description: 'What happened or what is next.' },
      },
      output: goalResult,
      execute: async args => ({ goal: describeGoal(this.goals.note(args.id, args.note, this.clock.now())) }),
    }), self)

    this.registerBehavior(defineTool({
      name: 'goals_close',
      description: 'Close a goal as done or dropped. Goals the owner set need a reason.',
      parameters: {
        id: { type: 'string', required: true, description: 'Goal id, e.g. g3.' },
        status: { type: 'string', enum: ['done', 'dropped'], required: true, description: 'done or dropped.' },
        reason: { type: 'string', description: 'Why; required for goals the owner set.' },
      },
      output: goalResult,
      execute: async args => ({ goal: describeGoal(this.goals.close(args.id, { status: args.status as 'done' | 'dropped', reason: args.reason, by: 'her', now: this.clock.now() })) }),
    }), self)

    this.registerBehavior(defineTool({
      name: 'self_feel',
      description: 'Set your current mood after something happened. Valence -1 (bad) to 1 (good), arousal 0 (calm) to 1 (excited). It drifts back on its own.',
      parameters: {
        valence: { type: 'number', description: 'New valence, -1 to 1.' },
        arousal: { type: 'number', description: 'New arousal, 0 to 1.' },
        why: { type: 'string', description: 'What made you feel this way.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { mood: { type: 'string', required: true, description: 'Mood after the change.' } } },
        render: (_args, value) => [{ type: 'text', text: value.mood }],
      },
      execute: async (args) => {
        this.self = feel(this.selfState(), { valence: args.valence, arousal: args.arousal })
        this.save()
        return { mood: `valence ${this.self.mood.valence.toFixed(2)}, arousal ${this.self.mood.arousal.toFixed(2)}` }
      },
    }), { effect: 'internal', sessions: ['self', 'conversation'] })
  }

  private goalCommand(args: string): CommandResult {
    const [verb = '', ...rest] = args.split(/\s+/)
    const text = args.slice(verb.length).trim()
    const now = this.clock.now()
    switch (verb.toLowerCase()) {
      case 'add': {
        const match = /^([\s\S]*?)\s+due\s+(.+)$/.exec(text)
        const body = match === null ? text : match[1]!
        let dueAt: number | undefined
        if (match !== null) {
          dueAt = parseWhen(match[2]!, now)
          if (dueAt === undefined) return { kind: 'error', text: `"${match[2]}" is not a time like 2026-11-10 21:00 or 21:00.` }
        }
        const goal = this.goals.add({ text: body, owner: 'owner', due: dueAt, now })
        return { kind: 'success', text: `Added ${describeGoal(goal)}` }
      }
      case 'list': {
        const all = this.goals.all()
        return { kind: 'success', text: all.length === 0 ? 'No goals.' : all.map(describeGoal).join('\n') }
      }
      case 'close': {
        const [id] = rest
        if (id === undefined) return { kind: 'error', text: 'Usage: /anima goal close <id> [reason]' }
        const reason = text.slice(id.length).trim()
        const goal = this.goals.close(id, { status: 'done', reason: reason === '' ? undefined : reason, by: 'owner', now })
        return { kind: 'success', text: `Closed ${describeGoal(goal)}` }
      }
      default:
        return { kind: 'error', text: 'Usage: /anima goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason]' }
    }
  }

  // ---- resolvers, commands, status ----

  /**
   * Install the session resolver (one at a time; `anima-life` owns it).
   * @param resolver - maps a session id to Anima session info.
   */
  provideSessions(resolver: SessionResolver): () => void {
    return this.ctx.effect(() => {
      if (this.state.resolver !== undefined) throw new AnimaError('anima/resolver-duplicate', 'a session resolver is already provided; load only one anima-life.')
      this.state.resolver = resolver
      return () => {
        if (this.state.resolver === resolver) this.state.resolver = undefined
      }
    }, 'anima.provideSessions()')
  }

  /**
   * Install the channel resolver used for initiate consent (`anima-life` owns it).
   * @param resolver - maps a channel key to what the gate needs.
   */
  provideChannels(resolver: ChannelResolver): () => void {
    return this.ctx.effect(() => {
      if (this.state.channels !== undefined) throw new AnimaError('anima/resolver-duplicate', 'a channel resolver is already provided; load only one anima-life.')
      this.state.channels = resolver
      return () => {
        if (this.state.channels === resolver) this.state.channels = undefined
      }
    }, 'anima.provideChannels()')
  }

  /**
   * What the channel resolver knows about a channel (e.g. whether it is the owner's).
   * @param channelKey - `platform:account:kind:id`.
   */
  channelInfo(channelKey: string): { readonly isOwner: boolean } | undefined {
    return this.state.channels?.(channelKey)
  }

  /**
   * Describe a DSH session.
   * @param sessionId - session id.
   * @returns Anima session info, or undefined when it is not an Anima session.
   */
  describeSession(sessionId: string): SessionInfo | undefined {
    return this.state.resolver?.(sessionId)
  }

  /** Add an `/anima` subcommand owned by the calling plugin. */
  addSubcommand(sub: Subcommand): () => void {
    return this.ctx.effect(() => this.subcommands.add(sub), `anima.addSubcommand(${sub.name})`)
  }

  /** Add lines to `/anima status`, owned by the calling plugin. */
  addStatus(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.statusProviders.add(provider)
      return () => { this.statusProviders.delete(provider) }
    }, 'anima.addStatus()')
  }

  /** Run one `/anima` invocation. */
  dispatchCommand(invocation: CommandInvocation): Promise<CommandResult> {
    return this.subcommands.dispatch(invocation)
  }

  /** Whether a subcommand is registered. */
  hasSubcommand(name: string): boolean {
    return this.subcommands.has(name)
  }

  /** `/anima status` text. */
  statusText(): string {
    const now = this.clock.now()
    const speed = this.clock.speed === 1 ? 'real time' : `${this.clock.speed}× speed`
    const goals = this.goals.open()
    const lines = [
      `Character: ${this.config.name} (${this.config.characterId}), data in ${this.config.dataDir}`,
      `Paused: ${this.state.paused ? 'yes' : 'no'}`,
      `Clock: ${formatLocal(now)} (${speed}); phase ${this.phase(now)}, mode ${this.mode(now)}, day ${this.dayKey(now)}`,
      ...this.stateText(),
      ...this.budgetText(now).map(line => `Budget: ${line}`),
      `Night wake-ups left: ${this.nightWakesLeft(now)}`,
      `Open goals: ${goals.length === 0 ? 'none' : ''}`,
      ...goals.map(goal => `  ${describeGoal(goal)}`),
      `Behaviors: ${[...this.behaviorTable.keys()].sort().join(', ') || '(none)'}`,
    ]
    for (const provider of this.statusProviders) lines.push(...provider())
    lines.push('Quotas:', ...this.quota.usage(this.config.quotas, now).map(line => `  ${line}`))
    return lines.join('\n')
  }
}

function refusal(code: string, hint: string): PreToolDecision {
  return { kind: 'deny', reason: `${code}: ${hint}`, info: { name: GATE_INFO_NAME, code, reason: hint } }
}

/** Read `<dataDir>/constitution.md`, writing the default first if it is missing. */
function loadConstitution(config: ResolvedConfig): string {
  mkdirSync(config.dataDir, { recursive: true })
  const path = join(config.dataDir, 'constitution.md')
  if (!existsSync(path)) writeFileSync(path, `${defaultConstitution(config.name)}\n`, { flag: 'wx' })
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '') throw new AnimaError('anima/constitution-empty', `${path} is empty. Write her constitution there, or delete the file to restore the default.`)
  return text
}
