/**
 * The `anima` service: behavior registry with tool scoping, the policy gate on
 * `tools/pre-execute`, the pause switch, her clock and self state, daily
 * budgets, goals, the session and channel resolver slots that `anima-life`
 * fills, and the `/anima` subcommand table.
 * @module @anima/core/service
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool, type PreToolDecision, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ActivityLog, summarize, type DaySummary, type NewActivity, type OwnerSource } from './activity.ts'
import { ApprovalBroker, parseOwnerReply, type ApprovalAnswer, type OwnerLine, type OwnerReply } from './approvals.ts'
import { AnimaClock, formatLocal, parseWhen } from './clock.ts'
import { SubcommandTable, type Subcommand } from './commands.ts'
import type { ModeConfig, ResolvedConfig } from './config.ts'
import { decide, GateCode, QuotaBook, quotaExempt, visibleIn, type GateCall, type GateMoment } from './gate.ts'
import { describeGoal, GoalStore, type Goal } from './goals.ts'
import { optionalStringArg, OwnerRegistry, stringArg, type OwnerAction, type OwnerView, type PlatformProvider, type PlatformView, type ViewParams } from './owner.ts'
import { SELF_SECTIONS, SelfModelStore, type SelfDiff, type SelfSection } from './selfmodel.ts'
import { billableTokens, Ledger, readJson, writeJson, type DayLedger } from './ledger.ts'
import { dayKey, inWindow, modeAt, phaseAt, type Mode, type Phase } from './rhythm.ts'
import { advance, describeNeeds, feel, initialState, satisfy, spendTurn, type SelfState, type StateModel } from './state.ts'
import type { PlaceFacts } from './primer.ts'
import { AnimaError, closesTurn, costOf, type BehaviorMeta, type SessionInfo, type SessionKind } from './types.ts'

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
    /** The owner saved a new constitution; persona rows re-read it. */
    'anima/constitution'(text: string): void
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

/** What core knows about a channel: owner or not (gate), display name and an adapter's note (primer). */
export interface ChannelInfo {
  readonly isOwner: boolean
  readonly display?: string | undefined
  /** A fact line about this channel for the environment primer (Chinese), set by its adapter. */
  readonly note?: string | undefined
}

/** What the gate needs to know about a channel; provided by `anima-life`. */
export type ChannelResolver = (channelKey: string) => ChannelInfo | undefined

/**
 * Handles an owner reply command (`cancel o2`, …) that approvals do not.
 * @returns the confirmation to send back, or undefined when the id is not its own.
 */
export type OwnerReplyHandler = (reply: OwnerReply) => string | undefined

/** Whether a channel key is on its platform's allowlist. */
export type ChannelAllowlist = (channelKey: string) => boolean

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
  /** Quota counters, so daily limits survive a restart. */
  quotas?: Record<string, { at: number; amount: number }[]>
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
  private readonly state: { paused: boolean; resolver: SessionResolver | undefined; channels: ChannelResolver | undefined; channelList: (() => readonly string[]) | undefined; ownerLine: OwnerLine | undefined } = {
    paused: false, resolver: undefined, channels: undefined, channelList: undefined, ownerLine: undefined,
  }
  private readonly allowlists = new Map<string, ChannelAllowlist>()
  private readonly ownerReplies = new Set<OwnerReplyHandler>()
  /** Pending owner approvals. */
  readonly approvals: ApprovalBroker
  private constitutionCache: { mtimeMs: number; text: string }
  private readonly constitutionPath: string
  private readonly statePath: string
  /** Activity log (gate decisions, wakes, owner actions). */
  readonly activity: ActivityLog
  /** Her self-model. */
  readonly selfModel: SelfModelStore
  private readonly owner = new OwnerRegistry()
  private readonly platforms = new Map<string, PlatformProvider>()
  private readonly statusParts = new Map<string, () => unknown>()
  private self: SelfState
  private readonly ledger: Ledger

  /**
   * @param ctx - root context with `tools`.
   * @param config - resolved core config.
   */
  constructor(ctx: Context, readonly config: ResolvedConfig) {
    super(ctx, 'anima')
    this.constitutionPath = join(config.dataDir, 'constitution.md')
    this.constitutionCache = loadConstitution(config)
    this.activity = new ActivityLog(join(config.dataDir, 'activity'))
    this.selfModel = new SelfModelStore(join(config.dataDir, 'self-model.json'), join(config.dataDir, 'self-model-log.jsonl'), config.selfModel)
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
    // Two weeks of day counters: enough for the formal test's whole week.
    this.ledger = new Ledger(saved?.days ?? {}, 14)
    this.quota.load(saved?.quotas)
    // Ids keep counting across restarts, so a late "yes a3" never approves a newer request.
    const approvalsPath = join(config.dataDir, 'approvals.json')
    const approvalSeq = { seq: readJson<{ seq: number }>(approvalsPath)?.seq ?? 0 }
    this.approvals = new ApprovalBroker(() => {
      approvalSeq.seq += 1
      writeJson(approvalsPath, approvalSeq)
      return approvalSeq.seq
    }, config.approvals.timeoutSeconds * 1000)
    ctx.effect(() => () => this.approvals.denyAll(), 'anima.approvals')

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const meta = this.behaviorTable.get(exec.name)
      if (meta === undefined) return next()
      const sessionId = exec.agent?.id
      const sessionKind = sessionId === undefined ? undefined : this.describeSession(sessionId)?.kind
      const record = (decision: 'allowed' | 'refused' | 'approved' | 'denied', code?: string, hint?: string) => this.recordActivity({
        type: 'gate', behavior: exec.name, decision,
        ...sessionKind === undefined ? {} : { session: sessionKind },
        ...sessionId === undefined ? {} : { sessionId },
        ...code === undefined ? {} : { code },
        ...hint === undefined ? {} : { hint },
      })
      const refuse = (code: string, hint: string) => {
        record('refused', code, hint)
        return refusal(code, hint)
      }
      // A pause refuses everything except closing a turn: end_turn and friends act on nothing
      // outside her, and refusing them would leave the turn unclosed (a false lost reply).
      if (this.state.paused && !quotaExempt(meta)) return refuse(GateCode.paused, PAUSED_HINT)
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {}
      let facts: Readonly<Record<string, number>> | undefined
      if (meta.facts !== undefined) {
        try {
          facts = await meta.facts(args)
        } catch (error: unknown) {
          const code = error instanceof AnimaError ? error.code : 'anima/facts-failed'
          const text = error instanceof Error ? error.message.replace(/^[a-z]+\/[a-z-]+:\s*/, '') : String(error)
          return refuse(code, text)
        }
      }
      const call: GateCall = {
        name: exec.name,
        meta,
        session: exec.agent === undefined ? undefined : this.describeSession(exec.agent.id),
        now: this.clock.now(),
        args,
        ...facts === undefined ? {} : { facts },
      }
      const verdict = decide(call, this.policy(), this.quota, this.moment(call.now))
      if (!verdict.allowed) return refuse(verdict.code, verdict.hint)
      if (verdict.approval !== undefined) {
        const answer = await this.requestApproval(`She wants to call ${exec.name}${describeArgs(args)} (${verdict.approval}).`, { signal: exec.signal })
        if (answer !== 'approved') {
          const hint = deniedHint(exec.name, answer)
          record('denied', GateCode.denied, hint)
          return refusal(GateCode.denied, hint)
        }
        if (this.state.paused && !quotaExempt(meta)) return refuse(GateCode.paused, PAUSED_HINT)
      }
      const decision = await next()
      if (decision.kind === 'allow') {
        this.quota.record(call, config.quotas)
        this.save()
        record(verdict.approval === undefined ? 'allowed' : 'approved')
      } else if (decision.kind === 'deny') {
        record('refused', decision.info?.code ?? 'dsh/denied', decision.reason)
      }
      return decision
    }, { prepend: true })

    // Monotonic final denial: nothing later in the pipeline can lift a pause (turn closers excepted).
    ctx.tools.guard(exec => {
      const meta = this.behaviorTable.get(exec.name)
      return this.state.paused && meta !== undefined && !quotaExempt(meta) ? `${GateCode.paused}: ${PAUSED_HINT}` : undefined
    })

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
      { name: 'pause', usage: 'pause — refuse every Anima behavior and stop heartbeats until resumed', run: async () => { await this.ownerAction('pause', {}, 'command'); return { kind: 'success', text: 'Anima paused. Every behavior is refused and heartbeats stop until /anima resume.' } } },
      { name: 'resume', usage: 'resume — lift a pause', run: async () => { await this.ownerAction('resume', {}, 'command'); return { kind: 'success', text: 'Anima resumed.' } } },
      { name: 'approve', usage: 'approve <id> — allow a pending approval request (same as replying "yes <id>" on the owner line)', run: args => this.answerCommand(args, true) },
      { name: 'deny', usage: 'deny <id> — deny a pending approval request', run: args => this.answerCommand(args, false) },
      { name: 'goal', usage: 'goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason] — owner goals', run: args => this.goalCommand(args) },
      { name: 'selfmodel', usage: 'selfmodel [list] | selfmodel revert <dId> [reason] — her self-model notes and recent changes', run: args => this.selfModelCommand(args) },
    ]
    for (const sub of core) this.subcommands.add(sub)
    this.registerOwnSurface()
  }

  /** Whether the pause switch is on. */
  get paused(): boolean {
    return this.state.paused
  }

  /** Pin the clock to a function (tests). */
  setClock(now: () => number): void {
    this.clock.setOverride(now)
  }

  /** The constitution text, re-read when the file changes. */
  constitution(): string {
    try {
      const { mtimeMs } = statSync(this.constitutionPath)
      if (mtimeMs !== this.constitutionCache.mtimeMs) {
        const text = readFileSync(this.constitutionPath, 'utf8')
        // An emptied file keeps the last good text; saving empty text is refused.
        if (text.trim() !== '') this.constitutionCache = { mtimeMs, text }
      }
    } catch {
      // A missing file keeps the last good text.
    }
    return this.constitutionCache.text
  }

  /**
   * Save a new constitution (owner). Keeps the previous text in `constitution.md.bak`
   * and tells persona rows, so running sessions get it on their next request.
   * @throws {AnimaError} `anima/constitution-empty`.
   */
  saveConstitution(text: string): { chars: number } {
    if (text.trim() === '') throw new AnimaError('anima/constitution-empty', 'the constitution cannot be empty.')
    const previous = this.constitution()
    writeFileSync(`${this.constitutionPath}.bak`, previous)
    const normalized = text.endsWith('\n') ? text : `${text}\n`
    writeFileSync(`${this.constitutionPath}.tmp`, normalized)
    renameSync(`${this.constitutionPath}.tmp`, this.constitutionPath)
    this.constitutionCache = { mtimeMs: statSync(this.constitutionPath).mtimeMs, text: normalized }
    this.ctx.emit('anima/constitution', normalized)
    return { chars: normalized.length }
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
      approve: this.config.approve,
      limits: this.config.limits,
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
      ownerLine: this.state.ownerLine !== undefined,
      channelAllowed: key => this.channelAllowed(key),
      // Default deny: without a channel resolver no target is known.
      channelKnown: key => this.state.channels?.(key) !== undefined,
      ownerChannel: key => this.state.channels?.(key)?.isOwner === true,
      // Only keys she may actually reach are offered in refusals.
      knownChannels: () => (this.state.channelList?.() ?? []).filter(key => this.channelAllowed(key) !== false),
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
    writeJson(this.statePath, { self: this.self, days: this.ledger.toJSON(), quotas: this.quota.toJSON() } satisfies StateFile)
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
        // A closing behavior ends the turn only once it succeeded (DESIGN §6, Turn shape).
        if (closesTurn(meta, args as Record<string, unknown>)) exec.concludeTurn()
        // A started conversation counts only once it really started; a refused or failed call does not.
        if (meta.effect === 'initiate') this.today(this.clock.now()).initiates += costOf(meta, args as Record<string, unknown>)
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

  /**
   * Ask the gate whether code may do something on her behalf that is not a
   * tool call (DESIGN §6: a group attention-window wake). Only the pause switch
   * and the quotas of `name` apply; an allowed admission is counted, and every
   * decision goes to the activity log like a behavior call.
   * @param name - pseudo-behavior name quota rules match, e.g. `group_attention`.
   * @param channelKey - the channel it is for, the counter of `per: channel` rules.
   * @returns whether it may happen now.
   */
  admit(name: string, channelKey: string): boolean {
    const meta: BehaviorMeta = { effect: 'internal', sessions: ['conversation'], target: () => channelKey }
    const now = this.clock.now()
    const call: GateCall = { name, meta, session: undefined, now, args: {} }
    const record = (decision: 'allowed' | 'refused', code?: string, hint?: string) => this.recordActivity({
      type: 'gate', behavior: name, decision, session: 'conversation', channel: channelKey,
      ...code === undefined ? {} : { code }, ...hint === undefined ? {} : { hint },
    })
    if (this.state.paused) {
      record('refused', GateCode.paused, PAUSED_HINT)
      return false
    }
    // Only rules that name it: an admission is not a behavior call, so the global ceiling does not count it.
    const own = (rule: { behavior?: string | undefined }) => rule.behavior === name
    const over = this.quota.exceeded(call, this.config.quotas, own)
    if (over !== undefined) {
      record('refused', GateCode.overQuota, `limit of ${over.rule.limit} per ${over.rule.windowMinutes} min reached for ${name} in ${channelKey}.`)
      return false
    }
    this.quota.record(call, this.config.quotas, own)
    this.save()
    record('allowed')
    return true
  }

  /**
   * Facts of a session for the environment primer (DESIGN §9): its channel, the
   * behaviors visible there in any mode, and the quotas and limits that can apply.
   * @param sessionId - the session, when known at assembly time.
   * @param kind - the preset's session kind, used when the id is not an Anima session yet.
   */
  placeFacts(sessionId: string | undefined, kind: SessionKind): PlaceFacts {
    const described = sessionId === undefined ? undefined : this.describeSession(sessionId)
    // A conversation is known only with its channel; other kinds are known from the preset alone.
    const session: SessionInfo | undefined = described ?? (kind === 'conversation' ? undefined : { kind } as SessionInfo)
    const tools = session === undefined ? [] : [...this.behaviorTable].filter(([, meta]) => visibleIn(meta, session)).map(([name, meta]) => ({ name, meta }))
    const base = { kind, tools, quotas: this.config.quotas, limits: this.config.limits }
    if (session?.kind === 'conversation') {
      const info = this.channelInfo(session.channelKey)
      return { ...base, channel: { platform: session.channel.platform, kind: session.channel.kind, key: session.channelKey, display: info?.display, isOwner: info?.isOwner === true, note: info?.note } }
    }
    if (kind === 'self') {
      const counts = new Map<string, number>()
      for (const key of this.state.channelList?.() ?? []) {
        if (this.channelAllowed(key) === false) continue
        const platform = key.split(':')[0]!
        counts.set(platform, (counts.get(platform) ?? 0) + 1)
      }
      return { ...base, reach: [...counts].map(([platform, channels]) => ({ platform, channels })), initiatePerDay: this.config.initiate.perDay }
    }
    return base
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

    this.registerBehavior(defineTool({
      name: 'self_note',
      description: 'Change your self-model: short notes about your own tastes, habits and opinions that you want to keep. Give `text` to add a note; `replaces` with a note id and `text` to change one; `replaces` without `text` to remove one. Your self-model changes slowly: only a few edits a day, so note only what feels lasting. Your constitution always wins over it.',
      parameters: {
        section: { type: 'string', enum: [...SELF_SECTIONS], required: true, description: 'tastes, habits, opinions or other.' },
        text: { type: 'string', description: 'The note, in your own words, one or two sentences.' },
        replaces: { type: 'string', description: 'Id of the note to change or remove, e.g. n3.' },
        reason: { type: 'string', required: true, description: 'What made you notice this about yourself.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { change: { type: 'string', required: true, description: 'The change, one line.' } } },
        render: (_args, value) => [{ type: 'text', text: value.change }],
      },
      execute: async (args, exec) => {
        const diff = this.selfModel.note({
          section: args.section as SelfSection,
          text: args.text,
          replaces: args.replaces,
          reason: args.reason,
          at: this.clock.now(),
          real: Date.now(),
          sessionId: exec.agent?.id,
        })
        return { change: describeDiff(diff) }
      },
    }), { effect: 'internal', sessions: ['self', 'conversation', 'consolidation'] })
  }

  private async goalCommand(args: string): Promise<CommandResult> {
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
        const goal = await this.ownerAction('goal.add', { text: body, ...dueAt === undefined ? {} : { dueAt } }, 'command') as Goal
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
        const goal = await this.ownerAction('goal.close', { id, ...reason === '' ? {} : { reason } }, 'command') as Goal
        return { kind: 'success', text: `Closed ${describeGoal(goal)}` }
      }
      default:
        return { kind: 'error', text: 'Usage: /anima goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason]' }
    }
  }

  // ---- allowlists, owner line and approvals ----

  /**
   * Restrict a platform to an allowlist of channels (DESIGN §10): the gate then
   * refuses that platform's behaviors in other channels and initiating there.
   * Owned by the calling plugin.
   * @param platform - platform id, the first part of its channel keys.
   * @param allowed - whether a channel key is allowed.
   */
  restrictChannels(platform: string, allowed: ChannelAllowlist): () => void {
    return this.ctx.effect(() => {
      if (this.allowlists.has(platform)) throw new AnimaError('anima/allowlist-duplicate', `platform "${platform}" already has an allowlist.`)
      this.allowlists.set(platform, allowed)
      return () => {
        if (this.allowlists.get(platform) === allowed) this.allowlists.delete(platform)
      }
    }, `anima.restrictChannels(${platform})`)
  }

  /**
   * Whether a channel is allowed by its platform's allowlist.
   * @param channelKey - `platform:account:kind:id`.
   * @returns undefined when the platform has no allowlist.
   */
  channelAllowed(channelKey: string): boolean | undefined {
    const platform = channelKey.split(':', 1)[0] ?? ''
    return this.allowlists.get(platform)?.(channelKey)
  }

  /**
   * Provide the owner line approvals are asked on (one at a time). Owned by the calling plugin.
   * @param line - sends plain text to the owner.
   */
  provideOwnerLine(line: OwnerLine): () => void {
    return this.ctx.effect(() => {
      if (this.state.ownerLine !== undefined) throw new AnimaError('anima/owner-line-duplicate', `an owner line (${this.state.ownerLine.name}) is already provided; enable owner approvals in one adapter only.`)
      this.state.ownerLine = line
      return () => {
        if (this.state.ownerLine === line) {
          this.state.ownerLine = undefined
          this.approvals.denyAll()
        }
      }
    }, 'anima.provideOwnerLine()')
  }

  /** The current owner line, if an adapter provides one. */
  get ownerLine(): OwnerLine | undefined {
    return this.state.ownerLine
  }

  /**
   * Ask the owner over the owner line and wait for the answer.
   * @param summary - what she wants, one or two lines.
   */
  requestApproval(summary: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ApprovalAnswer> {
    return this.approvals.request(this.state.ownerLine, summary, {
      ...options,
      onAsked: id => this.ctx.logger.info(`anima: approval ${id} asked: ${summary}`),
    })
  }

  /** Handle owner reply commands other than approvals (e.g. outbox cancel). Owned by the calling plugin. */
  addOwnerReply(handler: OwnerReplyHandler): () => void {
    return this.ctx.effect(() => {
      this.ownerReplies.add(handler)
      return () => { this.ownerReplies.delete(handler) }
    }, 'anima.addOwnerReply()')
  }

  /**
   * A message the owner sent on the owner line. Reply commands (`yes a3`,
   * `no a3`, `cancel o2`) are consumed here and never reach her sessions.
   * @param text - the message text.
   * @returns the confirmation to send back, or undefined when it is ordinary chat.
   */
  handleOwnerReply(text: string): string | undefined {
    const reply = parseOwnerReply(text)
    if (reply === undefined) return undefined
    if (reply.verb !== 'cancel' && reply.id.startsWith('a')) {
      return this.approvals.answer(reply.id, reply.verb === 'yes')
        ? `${reply.verb === 'yes' ? 'Allowed' : 'Denied'} ${reply.id}.`
        : `No pending request ${reply.id} (already answered or timed out).`
    }
    for (const handler of this.ownerReplies) {
      const answer = handler(reply)
      if (answer !== undefined) return answer
    }
    return `No pending request ${reply.id}.`
  }

  private async answerCommand(args: string, approve: boolean): Promise<CommandResult> {
    const id = args.trim().toLowerCase()
    if (!/^a\d+$/.test(id)) return { kind: 'error', text: `Usage: /anima ${approve ? 'approve' : 'deny'} <id>, e.g. a3. Pending: ${this.approvals.list().map(p => p.id).join(', ') || 'none'}` }
    const { answered } = await this.ownerAction(approve ? 'approve' : 'deny', { id }, 'command') as { answered: boolean }
    return answered
      ? { kind: 'success', text: `${approve ? 'Allowed' : 'Denied'} ${id}.` }
      : { kind: 'error', text: `No pending request ${id}.` }
  }

  private async selfModelCommand(args: string): Promise<CommandResult> {
    const [verb = 'list', id, ...rest] = args.split(/\s+/).filter(word => word !== '')
    if (verb === 'list') {
      const entries = this.selfModel.entries()
      const diffs = this.selfModel.diffs().slice(-10)
      return {
        kind: 'success',
        text: [
          `Self-model notes (${entries.length}):`,
          ...entries.length === 0 ? ['  none yet'] : entries.map(e => `  ${e.id} [${e.section}] ${e.text}`),
          'Recent changes:',
          ...diffs.length === 0 ? ['  none yet'] : diffs.map(d => `  ${describeDiff(d)} — ${formatLocal(d.at)}, ${d.by}: ${d.reason}`),
        ].join('\n'),
      }
    }
    if (verb === 'revert' && id !== undefined) {
      const diff = await this.ownerAction('selfmodel.revert', { id, reason: rest.join(' ') || 'reverted by the owner' }, 'command') as SelfDiff
      return { kind: 'success', text: `Reverted: ${describeDiff(diff)}` }
    }
    return { kind: 'error', text: 'Usage: /anima selfmodel [list] | selfmodel revert <dId> [reason]' }
  }

  // ---- owner surface (commands and the Anima page) ----

  /** Add an owner view (a read the page and commands share). Owned by the calling plugin. */
  addOwnerView(name: string, view: OwnerView): () => void {
    return this.ctx.effect(() => this.owner.addView(name, view), `anima.addOwnerView(${name})`)
  }

  /** Add an owner action (a write the page and commands share). Owned by the calling plugin. */
  addOwnerAction(name: string, action: OwnerAction): () => void {
    return this.ctx.effect(() => this.owner.addAction(name, action), `anima.addOwnerAction(${name})`)
  }

  /** Read an owner view. */
  ownerView(name: string, params: ViewParams = {}): Promise<unknown> {
    return this.owner.view(name, params)
  }

  /**
   * Run an owner action and log it with its source.
   * @param name - action name.
   * @param args - JSON arguments.
   * @param source - `command` or `page`.
   */
  async ownerAction(name: string, args: Readonly<Record<string, unknown>>, source: OwnerSource): Promise<unknown> {
    try {
      const result = await this.owner.run(name, args, source)
      this.recordActivity({ type: 'owner', action: name, source, args, ok: true })
      return result
    } catch (error: unknown) {
      this.recordActivity({ type: 'owner', action: name, source, args, ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /** Registered owner view and action names. */
  ownerNames(): { views: string[]; actions: string[] } {
    return this.owner.names()
  }

  /**
   * Provide a platform's owner surface (health for Status, details and actions
   * for Platforms). Owned by the calling plugin.
   */
  providePlatform(provider: PlatformProvider): () => void {
    return this.ctx.effect(() => {
      if (this.platforms.has(provider.platform)) throw new AnimaError('anima/platform-duplicate', `platform "${provider.platform}" already has an owner surface.`)
      this.platforms.set(provider.platform, provider)
      const disposers = Object.entries(provider.actions ?? {}).map(([name, action]) => this.owner.addAction(`${provider.platform}.${name}`, action))
      return () => {
        for (const dispose of disposers) dispose()
        if (this.platforms.get(provider.platform) === provider) this.platforms.delete(provider.platform)
      }
    }, `anima.providePlatform(${provider.platform})`)
  }

  /** Add a named part to the structured status view (e.g. `life`). Owned by the calling plugin. */
  addStatusPart(name: string, part: () => unknown): () => void {
    return this.ctx.effect(() => {
      if (this.statusParts.has(name)) throw new AnimaError('anima/status-duplicate', `status part "${name}" is already registered.`)
      this.statusParts.set(name, part)
      return () => {
        if (this.statusParts.get(name) === part) this.statusParts.delete(name)
      }
    }, `anima.addStatusPart(${name})`)
  }

  /**
   * Record one activity on her current day. Never throws: a full disk must not stop her.
   * @param record - the record without timestamps.
   */
  recordActivity(record: NewActivity): void {
    const at = this.clock.now()
    try {
      this.activity.append(this.dayKey(at), { ...record, at, real: Date.now() } as Parameters<ActivityLog['append']>[1])
    } catch (error: unknown) {
      this.ctx.logger.warn(`anima: activity log write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One factual line about her self-model for the situation report (DESIGN §9):
   * how many notes she keeps and when it last changed. It states what exists;
   * it never suggests what to note.
   */
  selfModelReportLine(): string {
    const notes = this.selfModel.entries().length
    const last = this.selfModel.diffs().at(-1)
    return `Your self-model: ${notes === 0 ? 'no notes yet' : `${notes} note${notes === 1 ? '' : 's'}`}${last === undefined ? '' : `, last changed ${formatLocal(last.at)}`}. self_note keeps what you learn about your own tastes, habits and opinions; only a few changes a day.`
  }

  /** Summary of one of her days (default today). */
  daySummary(day = this.dayKey()): DaySummary {
    return summarize(day, this.activity.read(day), this.ledger.peek(day))
  }

  /** Structured status: what `/anima status` shows, as data. */
  statusView(): Record<string, unknown> {
    const now = this.clock.now()
    const state = this.selfState()
    const day = this.todayLedger(now)
    const mode = this.mode(now)
    const parts: Record<string, unknown> = {}
    for (const [name, part] of this.statusParts) {
      try {
        parts[name] = part()
      } catch (error: unknown) {
        parts[name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      character: { id: this.config.characterId, name: this.config.name, dataDir: this.config.dataDir },
      paused: this.state.paused,
      clock: { now, text: formatLocal(now), speed: this.clock.speed, phase: this.phase(now), mode, day: this.dayKey(now) },
      energy: state.energy,
      mood: state.mood,
      needs: this.model.needs.map(need => ({ name: need.name, description: need.description, value: state.needs[need.name] ?? 0 })),
      budgets: {
        tokens: { day: day.tokens.day, night: day.tokens.night, dayBudget: this.config.modes.day.tokenBudget, nightBudget: this.config.modes.night.tokenBudget },
        initiates: { used: day.initiates, perDay: this.config.initiate.perDay },
        nightWakesLeft: this.nightWakesLeft(now),
        overBudget: this.overBudget(now),
      },
      goals: this.goals.open().length,
      approvals: this.approvals.list().length,
      ownerLine: this.state.ownerLine?.name ?? null,
      selfModel: { notes: this.selfModel.entries().length },
      // Turns that ended without a say or end_turn today (DESIGN §6): the page warns on any.
      speech: this.daySummary(this.dayKey(now)).speech,
      quotas: this.quota.usage(this.config.quotas, now),
      parts,
    }
  }

  private async platformViews(): Promise<{ platform: string; title: string; view: PlatformView }[]> {
    const views = []
    for (const provider of this.platforms.values()) {
      let view: PlatformView
      try {
        view = await provider.view()
      } catch (error: unknown) {
        view = { health: 'down', summary: `status failed: ${error instanceof Error ? error.message : String(error)}`, details: {} }
      }
      views.push({ platform: provider.platform, title: provider.title, view })
    }
    return views
  }

  private registerOwnSurface(): void {
    const owner = this.owner
    const add = (dispose: () => void) => this.ctx.effect(() => dispose, 'anima.ownerSurface')
    add(owner.addView('status', () => this.statusView()))
    add(owner.addView('platforms', () => this.platformViews()))
    add(owner.addView('goals', () => ({ goals: this.goals.all() })))
    add(owner.addView('approvals', () => ({
      ownerLine: this.state.ownerLine?.name ?? null,
      pending: this.approvals.list().map(p => ({ id: p.id, summary: p.summary })),
    })))
    add(owner.addView('selfmodel', () => ({ entries: this.selfModel.entries(), diffs: this.selfModel.diffs().reverse() })))
    add(owner.addView('constitution', () => ({ text: this.constitution(), path: this.constitutionPath })))
    add(owner.addView('activity', (params) => {
      const days = this.activity.days()
      const day = params.day ?? this.dayKey()
      return { day, days, summary: this.daySummary(day), records: this.activity.read(day) }
    }))
    add(owner.addView('owner', () => this.owner.names()))

    add(owner.addAction('pause', () => { this.state.paused = true; return { paused: true } }))
    add(owner.addAction('resume', () => { this.state.paused = false; return { paused: false } }))
    add(owner.addAction('approve', args => ({ answered: this.approvals.answer(stringArg(args, 'id').toLowerCase(), true) })))
    add(owner.addAction('deny', args => ({ answered: this.approvals.answer(stringArg(args, 'id').toLowerCase(), false) })))
    add(owner.addAction('goal.add', (args) => {
      const now = this.clock.now()
      const dueText = optionalStringArg(args, 'due')
      let due = typeof args.dueAt === 'number' ? args.dueAt : undefined
      if (dueText !== undefined) {
        due = parseWhen(dueText, now)
        if (due === undefined) throw new AnimaError('anima/bad-time', `"${dueText}" is not a time like 2026-11-10 21:00 or 21:00.`)
      }
      return this.goals.add({ text: stringArg(args, 'text'), owner: 'owner', due, now })
    }))
    add(owner.addAction('goal.close', args => this.goals.close(stringArg(args, 'id'), {
      status: args.status === 'dropped' ? 'dropped' : 'done',
      reason: optionalStringArg(args, 'reason'),
      by: 'owner',
      now: this.clock.now(),
    })))
    add(owner.addAction('selfmodel.revert', args => this.selfModel.revert(stringArg(args, 'id'), optionalStringArg(args, 'reason') ?? 'reverted by the owner', this.clock.now(), Date.now())))
    add(owner.addAction('constitution.save', (args) => {
      const text = args.text
      if (typeof text !== 'string') throw new AnimaError('anima/bad-args', '"text" must be a string.')
      return this.saveConstitution(text)
    }))
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
   * @param list - every known channel key, for refusals of unknown targets.
   */
  provideChannels(resolver: ChannelResolver, list?: () => readonly string[]): () => void {
    return this.ctx.effect(() => {
      if (this.state.channels !== undefined) throw new AnimaError('anima/resolver-duplicate', 'a channel resolver is already provided; load only one anima-life.')
      this.state.channels = resolver
      this.state.channelList = list
      return () => {
        if (this.state.channels === resolver) {
          this.state.channels = undefined
          this.state.channelList = undefined
        }
      }
    }, 'anima.provideChannels()')
  }

  /**
   * What the channel resolver knows about a channel (e.g. whether it is the owner's).
   * @param channelKey - `platform:account:kind:id`.
   */
  channelInfo(channelKey: string): ChannelInfo | undefined {
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
    const speech = this.daySummary(this.dayKey(now)).speech
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
      `Owner line: ${this.state.ownerLine?.name ?? 'none (approval-class behaviors are refused)'}`,
      `Pending approvals: ${this.approvals.list().map(p => `${p.id} ${p.summary}`).join('; ') || 'none'}`,
      `Speech today: ${speech.lostReplies} lost replies, ${speech.reminders} close reminders`,
    ]
    for (const provider of this.statusProviders) lines.push(...provider())
    lines.push('Quotas:', ...this.quota.usage(this.config.quotas, now).map(line => `  ${line}`))
    return lines.join('\n')
  }
}

/** Short argument summary for an approval request. */
function describeArgs(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args)
  if (text === '{}') return ''
  return ` with ${text.length > 800 ? `${text.slice(0, 800)}…` : text}`
}

/**
 * One-line description of a self-model change.
 * @param diff - the change.
 */
export function describeDiff(diff: SelfDiff): string {
  const quote = (text: string | undefined) => text === undefined ? '' : `"${text}"`
  switch (diff.op) {
    case 'add': return `${diff.id}: added ${diff.entryId} [${diff.section}] ${quote(diff.after)}`
    case 'remove': return `${diff.id}: removed ${diff.entryId} [${diff.section}] ${quote(diff.before)}`
    case 'change': return `${diff.id}: changed ${diff.entryId} [${diff.section}] ${quote(diff.before)} → ${quote(diff.after)}`
    default: return `${diff.id}: reverted ${diff.revertOf ?? '?'} on ${diff.entryId} [${diff.section}] ${diff.after === undefined ? `(removed ${quote(diff.before)})` : `→ ${quote(diff.after)}`}`
  }
}

function deniedHint(name: string, answer: ApprovalAnswer): string {
  switch (answer) {
    case 'denied': return `the owner said no to ${name}. Do not ask again for the same thing now.`
    case 'timeout': return `the owner did not answer in time, so ${name} was not allowed. You can mention it to the owner later.`
    default: return `the owner could not be asked, so ${name} was not allowed.`
  }
}

function refusal(code: string, hint: string): PreToolDecision {
  return { kind: 'deny', reason: `${code}: ${hint}`, info: { name: GATE_INFO_NAME, code, reason: hint } }
}

/** Read `<dataDir>/constitution.md`, writing the default first if it is missing. */
function loadConstitution(config: ResolvedConfig): { mtimeMs: number; text: string } {
  mkdirSync(config.dataDir, { recursive: true })
  const path = join(config.dataDir, 'constitution.md')
  if (!existsSync(path)) writeFileSync(path, `${defaultConstitution(config.name)}\n`, { flag: 'wx' })
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '') throw new AnimaError('anima/constitution-empty', `${path} is empty. Write her constitution there, or delete the file to restore the default.`)
  return { mtimeMs: statSync(path).mtimeMs, text }
}
