/**
 * The `anima` service: her body. Behavior registry with tool scoping, the body
 * check on `tools/pre-execute` (physiology and plumbing only), her clock and
 * self state, sleep, goals, the self-model, and the session and channel
 * resolver slots that `anima-life` fills. Safety and management are outside
 * (`anima-guard`): the persona only offers hooks (`anima/admit`, events) and
 * read access, and never imports what is outside.
 * @module @anima/core/service
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool, type PreToolDecision, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AnimaClock, formatLocal, parseWhen } from './clock.ts'
import type { ModeConfig, ResolvedConfig } from './config.ts'
import { bodyCheck, visibleIn, type BodyMoment, type BodyVerdict } from './gate.ts'
import { describeGoal, GoalStore } from './goals.ts'
import type { PlatformProvider } from './owner.ts'
import type { NewActivity } from './records.ts'
import { SELF_SECTIONS, SelfModelStore, type SelfDiff, type SelfSection } from './selfmodel.ts'
import { Ledger, readJson, writeJson, type DayLedger } from './ledger.ts'
import { asleepAt, dayKey, dayStart, earliestBedtime, latestBedtime, modeAt, phaseAt, wokenUntil, type Mode, type Phase, type SleepRecord } from './rhythm.ts'
import { advance, describeNeeds, feel, initialState, satisfy, spendTurn, type SelfState, type StateModel } from './state.ts'
import type { PlaceFacts } from './primer.ts'
import { AnimaError, closesTurn, type AdmitRefusal, type AdmitRequest, type BehaviorMeta, type FriendRequest, type OutgoingHeld, type OwnerLine, type SessionInfo, type SessionKind } from './types.ts'

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
    /** She fell asleep: by `sleep`, or at the latest bedtime (Phase 9). */
    'anima/sleep'(payload: { readonly by: 'her' | 'latest'; readonly at: number; readonly note?: string | undefined; readonly sessionId?: string | undefined }): void
    /** The owner woke her on purpose (Phase 9). */
    'anima/woken'(payload: { readonly at: number; readonly until: number }): void
    /** The outside paused or resumed her (emitted by `anima-guard`). */
    'anima/paused'(paused: boolean): void
    /**
     * Something the persona did or that happened to her, for whoever keeps a
     * log outside. The persona only emits it; nothing inside listens.
     */
    'anima/record'(record: NewActivity & { readonly at: number; readonly real: number; readonly day: string }): void
    /**
     * May this happen now? A listener outside the persona returns a refusal to
     * stop it; without one (or with none refusing), it happens.
     */
    'anima/admit'(request: AdmitRequest): AdmitRefusal | undefined
    /**
     * The owner wrote on an owner line. A listener outside that consumes it
     * (an approval answer) returns the confirmation to send back; then it never reaches her.
     */
    'anima/owner-message'(text: string): string | undefined
    /** A friend request arrived; a listener outside that takes it returns true and answers it. */
    'anima/friend-request'(request: FriendRequest): boolean | undefined
    /** The outside holds one of her messages before it goes out (an adapter may show typing). */
    'anima/outgoing-held'(held: OutgoingHeld): void
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

/** Bedtime facts at a time (Phase 9), on her clock. */
export interface BedtimeInfo {
  readonly earliest: number
  readonly latest: number
  readonly asleep: boolean
  /** Asleep: since when, and how. */
  readonly since?: number | undefined
  readonly by?: 'her' | 'latest' | undefined
  /** A deliberate wake today. */
  readonly wokenAt?: number | undefined
  readonly wokenUntil?: number | undefined
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

/** Name recorded in `ToolErrorInfo.name` for body refusals. */
export const GATE_INFO_NAME = 'AnimaBody'

/** Real ms between checks for the latest bedtime passing (a poll, not a tunable: one check is cheap). */
const BEDTIME_CHECK_MS = 10_000

/** Minutes after midnight as `HH:mm`. */
function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

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
  /** When she went to sleep and when the owner woke her (Phase 9). */
  sleep?: SleepRecord
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
  private readonly statusProviders = new Set<() => string[]>()
  private readonly placeProviders = new Set<(facts: PlaceFacts) => readonly string[]>()
  private readonly state: { resolver: SessionResolver | undefined; channels: ChannelResolver | undefined; channelList: (() => readonly string[]) | undefined; ownerLine: OwnerLine | undefined } = {
    resolver: undefined, channels: undefined, channelList: undefined, ownerLine: undefined,
  }
  private constitutionCache: { mtimeMs: number; text: string }
  /** Path of her persona file (`constitution.md`). */
  readonly constitutionPath: string
  private readonly statePath: string
  /** Her self-model. */
  readonly selfModel: SelfModelStore
  private readonly platformTable = new Map<string, PlatformProvider>()
  private readonly statusPartTable = new Map<string, () => unknown>()
  private self: SelfState
  private readonly ledger: Ledger
  /** When she went to sleep and when the owner woke her (Phase 9). */
  private sleepRecord: SleepRecord = {}
  /** Whether the last bedtime check saw her asleep, so falling asleep is noticed once. */
  private sleptSeen: boolean | undefined

  /**
   * @param ctx - root context with `tools`.
   * @param config - resolved core config.
   */
  constructor(ctx: Context, readonly config: ResolvedConfig) {
    super(ctx, 'anima')
    this.constitutionPath = join(config.dataDir, 'constitution.md')
    this.constitutionCache = loadConstitution(config)
    this.selfModel = new SelfModelStore(join(config.dataDir, 'self-model.json'), join(config.dataDir, 'self-model-log.jsonl'), config.selfModel)
    this.clock = new AnimaClock(config.clock)
    this.model = { needs: config.needs, energy: config.energy, mood: config.mood, rhythm: config.day, asleep: t => asleepAt(t, config.day, this.sleepRecord) }
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
    this.sleepRecord = saved?.sleep ?? {}
    // The body check: what her body cannot do here, now (physiology and plumbing). Safety is outside.
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const meta = this.behaviorTable.get(exec.name)
      if (meta === undefined) return next()
      const sessionId = exec.agent?.id
      const verdict = this.check(exec.name, exec.arguments, sessionId)
      if (!verdict.allowed) {
        const session = sessionId === undefined ? undefined : this.describeSession(sessionId)?.kind
        this.recordActivity({
          type: 'gate', behavior: exec.name, decision: 'refused', code: verdict.code, hint: verdict.hint,
          ...session === undefined ? {} : { session }, ...sessionId === undefined ? {} : { sessionId },
        })
        return refusal(verdict.code, verdict.hint)
      }
      return next()
    }, { prepend: true })

    // Schedule tools are DSH's; Anima governs them like her own behaviors.
    const thisSessionOnly = (args: Readonly<Record<string, unknown>>) => args.target === undefined || args.target === 'this_session'
      ? undefined
      : 'your alarms must use target "this_session", so they wake you in this session.'
    this.governTool('schedule_create', { effect: 'internal', sessions: ['self'], constraint: thisSessionOnly })
    this.governTool('schedule_edit', { effect: 'internal', sessions: ['self'], constraint: thisSessionOnly })
    this.governTool('schedule_list', { effect: 'observe', sessions: ['self'] })
    this.governTool('schedule_view', { effect: 'observe', sessions: ['self'] })

    this.registerOwnBehaviors()

    // The latest bedtime, and the end of a deliberate wake, pass on her clock (Phase 9).
    this.sleptSeen = this.asleep()
    ctx.effect(() => {
      const timer = setInterval(() => this.checkBedtime(), BEDTIME_CHECK_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'anima.bedtime')

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
    return phaseAt(t, this.config.day, this.sleepRecord)
  }

  /** Heartbeat mode at a time (default now). */
  mode(t = this.clock.now()): Mode {
    return modeAt(t, this.config.day, this.sleepRecord)
  }

  /** Whether she is asleep at a time (default now): she went to sleep, or the latest bedtime passed (Phase 9). */
  asleep(t = this.clock.now()): boolean {
    return this.mode(t) === 'night'
  }

  /** The sleep record (read-only copy). */
  sleepInfo(): Readonly<SleepRecord> {
    return { ...this.sleepRecord }
  }

  /** Bedtime facts for her report and status (Phase 9), at `t`. */
  bedtimeInfo(t = this.clock.now()): BedtimeInfo {
    const asleep = this.asleep(t)
    const start = this.dayStartOf(t)
    const record = this.sleepRecord
    const today = (at: number | undefined): at is number => at !== undefined && at >= start && at <= t
    const latest = latestBedtime(t, this.config.day)
    const chosen = today(record.since) && (!today(record.wokenAt) || record.since > record.wokenAt)
    return {
      earliest: earliestBedtime(t, this.config.day),
      latest,
      asleep,
      ...asleep ? (chosen ? { since: record.since, by: record.by ?? 'her' } : { since: Math.max(latest, today(record.wokenAt) ? record.wokenUntil ?? latest : latest), by: 'latest' as const }) : {},
      ...today(record.wokenAt) ? { wokenAt: record.wokenAt, wokenUntil: record.wokenUntil } : {},
    }
  }

  /** One status line on sleep (Phase 9). */
  private sleepLine(now: number): string {
    const info = this.bedtimeInfo(now)
    const window = `bedtime ${formatLocal(info.earliest).slice(11)}–${formatLocal(info.latest).slice(11)}`
    const woken = info.wokenAt === undefined ? '' : `; woken by the owner at ${formatLocal(info.wokenAt)}${info.wokenUntil === undefined ? '' : ` until ${formatLocal(info.wokenUntil)}`}`
    return info.asleep ? `Asleep since ${formatLocal(info.since!)} (${info.by === 'her' ? 'she chose it' : 'latest bedtime'}); ${window}${woken}` : `Awake; ${window}${woken}`
  }

  private dayStartOf(t: number): number {
    return dayStart(t, this.config.day)
  }

  /**
   * She goes to sleep now (Phase 9): by `sleep`, or at the latest bedtime.
   * Night mode and the night budget start here; life holds chats in her inbox.
   */
  goToSleep(by: 'her' | 'latest', options: { note?: string | undefined; sessionId?: string | undefined; at?: number } = {}): void {
    const at = options.at ?? this.clock.now()
    this.selfState()
    this.sleepRecord = { ...this.sleepRecord, since: at, by }
    this.sleptSeen = true
    this.save()
    this.recordActivity({ type: 'sleep', by, ...options.note === undefined ? {} : { note: options.note }, ...options.sessionId === undefined ? {} : { sessionId: options.sessionId } })
    this.ctx.emit('anima/sleep', { by, at, ...options.note === undefined ? {} : { note: options.note }, ...options.sessionId === undefined ? {} : { sessionId: options.sessionId } })
  }

  /**
   * The owner wakes her on purpose (Phase 9): awake until she sleeps again or,
   * past the latest bedtime, for `bedtime.wokenMinutes`.
   * @returns whether she was asleep.
   */
  wakeByOwner(): { woken: boolean; until?: number } {
    const now = this.clock.now()
    if (!this.asleep(now)) return { woken: false }
    this.selfState()
    const until = wokenUntil(now, this.config.day)
    this.sleepRecord = { ...this.sleepRecord, wokenAt: now, wokenUntil: until }
    this.sleptSeen = false
    this.save()
    this.ctx.emit('anima/woken', { at: now, until })
    return { woken: true, until }
  }

  /**
   * Notice the latest bedtime (or the end of a deliberate wake) passing: record
   * it once and tell life (Phase 9). Called on a short real-time interval.
   */
  checkBedtime(): void {
    const now = this.clock.now()
    const asleep = this.asleep(now)
    const was = this.sleptSeen
    this.sleptSeen = asleep
    if (!asleep || was !== false) return
    const record = this.sleepRecord
    // Already recorded (she chose it): nothing to do.
    if (record.since !== undefined && record.since <= now && record.since >= this.dayStartOf(now)) {
      if (record.wokenAt === undefined || record.since > record.wokenAt) return
    }
    this.goToSleep('latest', { at: now })
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

  /** Night wake-ups left tonight. */
  nightWakesLeft(t = this.clock.now()): number {
    return Math.max(0, this.config.modes.night.maxWakes - this.todayLedger(t).nightWakes)
  }

  /** Count one night wake-up. */
  useNightWake(t = this.clock.now()): void {
    this.today(t).nightWakes += 1
    this.save()
  }

  /**
   * Ask the outside whether something may happen now (`anima/admit`). The
   * persona never decides this itself: without a listener, it is admitted.
   * @returns the refusal, or undefined when admitted.
   */
  admit(request: AdmitRequest): AdmitRefusal | undefined {
    return this.ctx.bail('anima/admit', request) ?? undefined
  }

  /**
   * Check one call against her body (physiology and plumbing), as the body
   * check on `tools/pre-execute` does. The outside uses it to leave what her
   * body refuses to the body.
   * @param name - tool name.
   * @param args - call arguments.
   * @param sessionId - calling session.
   */
  check(name: string, args: unknown, sessionId: string | undefined): BodyVerdict {
    const meta = this.behaviorTable.get(name)
    if (meta === undefined) return { allowed: true }
    const parsed = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {}
    return bodyCheck({ name, meta, session: sessionId === undefined ? undefined : this.describeSession(sessionId), args: parsed }, this.bodyMoment(this.clock.now()))
  }

  private bodyMoment(now: number): BodyMoment {
    return {
      mode: this.mode(now),
      allowedEffects: { day: this.config.modes.day.allowedEffects, night: this.config.modes.night.allowedEffects },
      // Default deny: without a channel resolver no target is known.
      channelKnown: key => this.state.channels?.(key) !== undefined,
      knownChannels: () => this.state.channelList?.() ?? [],
      beforeBedtime: now < earliestBedtime(now, this.config.day) ? { woke: formatClock(this.config.day.wake), earliest: formatClock(this.config.day.earliest) } : undefined,
    }
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
    writeJson(this.statePath, { self: this.self, days: this.ledger.toJSON(), sleep: this.sleepRecord } satisfies StateFile)
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
   * sessions and modes it fits, every call passes the body check, and a
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
   * under the body check with Anima metadata. It does not change the tool's visibility.
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
   * Facts of a session for the environment primer: its channel, the behaviors
   * visible there in any mode, and lines from outside on what may be stopped there.
   * @param sessionId - the session, when known at assembly time.
   * @param kind - the preset's session kind, used when the id is not an Anima session yet.
   */
  placeFacts(sessionId: string | undefined, kind: SessionKind): PlaceFacts {
    const described = sessionId === undefined ? undefined : this.describeSession(sessionId)
    // A conversation is known only with its channel; other kinds are known from the preset alone.
    const session: SessionInfo | undefined = described ?? (kind === 'conversation' ? undefined : { kind } as SessionInfo)
    const tools = session === undefined ? [] : [...this.behaviorTable].filter(([, meta]) => visibleIn(meta, session)).map(([name, meta]) => ({ name, meta }))
    let facts: PlaceFacts = { kind, tools }
    if (session?.kind === 'conversation') {
      const info = this.channelInfo(session.channelKey)
      facts = { ...facts, channel: { platform: session.channel.platform, kind: session.channel.kind, key: session.channelKey, display: info?.display, isOwner: info?.isOwner === true, note: info?.note } }
    } else if (kind === 'self') {
      const counts = new Map<string, number>()
      for (const key of this.state.channelList?.() ?? []) {
        const platform = key.split(':')[0]!
        counts.set(platform, (counts.get(platform) ?? 0) + 1)
      }
      facts = { ...facts, reach: [...counts].map(([platform, channels]) => ({ platform, channels })) }
    }
    const outside = [...this.placeProviders].flatMap(provider => provider(facts))
    return outside.length === 0 ? facts : { ...facts, outside }
  }

  /**
   * Add fact lines to "this place" in her prompt from outside the persona (what
   * owner rules may stop there). Owned by the calling plugin.
   */
  addPlaceLines(provider: (facts: PlaceFacts) => readonly string[]): () => void {
    return this.ctx.effect(() => {
      this.placeProviders.add(provider)
      return () => { this.placeProviders.delete(provider) }
    }, 'anima.addPlaceLines()')
  }

  /** Metadata of a registered or governed behavior. */
  behavior(name: string): BehaviorMeta | undefined {
    return this.behaviorTable.get(name)
  }

  /** Names of every registered or governed behavior, sorted. */
  behaviorNames(): string[] {
    return [...this.behaviorTable.keys()].sort()
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

    // Bedtime (DESIGN §7, Phase 9): she chooses when to sleep inside the owner's window.
    this.registerBehavior(defineTool({
      name: 'sleep',
      description: 'Go to sleep now. Works from your earliest bedtime on; at your latest bedtime you fall asleep anyway. While you sleep nothing reaches you: messages wait in your inbox until you wake. It ends this turn, so in a chat say goodnight first (say with more: true).',
      parameters: {
        note: { type: 'string', description: 'Optional note to yourself about the day or why now.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { asleep: { type: 'boolean', required: true, description: 'Whether you are asleep now.' } } },
        render: () => [{ type: 'text', text: '你睡着了。' }],
      },
      execute: async (args, exec) => {
        if (!this.asleep()) this.goToSleep('her', { note: args.note, sessionId: exec.agent?.id })
        return { asleep: true }
      },
    }), { effect: 'internal', sessions: ['self', 'conversation'], closes: true, bedtime: true })

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
      description: 'Close a goal as done or dropped.',
      parameters: {
        id: { type: 'string', required: true, description: 'Goal id, e.g. g3.' },
        status: { type: 'string', enum: ['done', 'dropped'], required: true, description: 'done or dropped.' },
        reason: { type: 'string', description: 'Why, in a few words.' },
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

  // ---- owner line and platform self-descriptions (read by the outside) ----

  /**
   * Provide an owner line: a way for the outside to write to the owner (one at a time). Owned by the calling plugin.
   * @param line - sends plain text to the owner.
   */
  provideOwnerLine(line: OwnerLine): () => void {
    return this.ctx.effect(() => {
      if (this.state.ownerLine !== undefined) throw new AnimaError('anima/owner-line-duplicate', `an owner line (${this.state.ownerLine.name}) is already provided; enable owner approvals in one adapter only.`)
      this.state.ownerLine = line
      return () => {
        if (this.state.ownerLine === line) this.state.ownerLine = undefined
      }
    }, 'anima.provideOwnerLine()')
  }

  /** The current owner line, if an adapter provides one. */
  get ownerLine(): OwnerLine | undefined {
    return this.state.ownerLine
  }

  /**
   * Describe a platform for the outside: health, details, and the owner actions
   * and subcommands it offers. The outside registers those. Owned by the calling plugin.
   */
  providePlatform(provider: PlatformProvider): () => void {
    return this.ctx.effect(() => {
      if (this.platformTable.has(provider.platform)) throw new AnimaError('anima/platform-duplicate', `platform "${provider.platform}" already has an owner surface.`)
      this.platformTable.set(provider.platform, provider)
      return () => {
        if (this.platformTable.get(provider.platform) === provider) this.platformTable.delete(provider.platform)
      }
    }, `anima.providePlatform(${provider.platform})`)
  }

  /** Platforms that described themselves. */
  platforms(): readonly PlatformProvider[] {
    return [...this.platformTable.values()]
  }

  /** Add a named part to the structured status the outside reads (e.g. `life`). Owned by the calling plugin. */
  addStatusPart(name: string, part: () => unknown): () => void {
    return this.ctx.effect(() => {
      if (this.statusPartTable.has(name)) throw new AnimaError('anima/status-duplicate', `status part "${name}" is already registered.`)
      this.statusPartTable.set(name, part)
      return () => {
        if (this.statusPartTable.get(name) === part) this.statusPartTable.delete(name)
      }
    }, `anima.addStatusPart(${name})`)
  }

  /**
   * Report one activity of her day (`anima/record`) to whoever keeps a log
   * outside. Never throws.
   * @param record - the record without timestamps.
   */
  recordActivity(record: NewActivity): void {
    const at = this.clock.now()
    try {
      this.ctx.emit('anima/record', { ...record, at, real: Date.now(), day: this.dayKey(at) } as NewActivity & { at: number; real: number; day: string })
    } catch (error: unknown) {
      this.ctx.logger.warn(`anima: activity record failed: ${error instanceof Error ? error.message : String(error)}`)
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

  /** Named status parts other packages added, evaluated now. */
  statusParts(): Record<string, unknown> {
    const parts: Record<string, unknown> = {}
    for (const [name, part] of this.statusPartTable) {
      try {
        parts[name] = part()
      } catch (error: unknown) {
        parts[name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return parts
  }

  /** Her body's state as data: character, sleep, clock, energy, mood, needs, goals, self-model. */
  bodyView(): Record<string, unknown> {
    const now = this.clock.now()
    const state = this.selfState()
    return {
      character: { id: this.config.characterId, name: this.config.name, dataDir: this.config.dataDir },
      sleep: this.bedtimeInfo(now),
      clock: { now, text: formatLocal(now), speed: this.clock.speed, phase: this.phase(now), mode: this.mode(now), day: this.dayKey(now) },
      energy: state.energy,
      mood: state.mood,
      needs: this.model.needs.map(need => ({ name: need.name, description: need.description, value: state.needs[need.name] ?? 0 })),
      nightWakesLeft: this.nightWakesLeft(now),
      goals: this.goals.open().length,
      selfModel: { notes: this.selfModel.entries().length },
    }
  }

  // ---- resolvers and status ----

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
   * Install the channel resolver (`anima-life` owns it).
   * @param resolver - maps a channel key to what is known about it.
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

  /** Every channel key that exists. */
  channelKeys(): readonly string[] {
    return this.state.channelList?.() ?? []
  }

  /** Add status lines the outside shows (`/anima status`), owned by the calling plugin. */
  addStatus(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.statusProviders.add(provider)
      return () => { this.statusProviders.delete(provider) }
    }, 'anima.addStatus()')
  }

  /** Her body's status lines, then every added status line. */
  statusLines(): string[] {
    const now = this.clock.now()
    const speed = this.clock.speed === 1 ? 'real time' : `${this.clock.speed}× speed`
    const goals = this.goals.open()
    const lines = [
      `Character: ${this.config.name} (${this.config.characterId}), data in ${this.config.dataDir}`,
      this.sleepLine(now),
      `Clock: ${formatLocal(now)} (${speed}); phase ${this.phase(now)}, mode ${this.mode(now)}, day ${this.dayKey(now)}`,
      ...this.stateText(),
      `Night wake-ups left: ${this.nightWakesLeft(now)}`,
      `Open goals: ${goals.length === 0 ? 'none' : ''}`,
      ...goals.map(goal => `  ${describeGoal(goal)}`),
      `Behaviors: ${this.behaviorNames().join(', ') || '(none)'}`,
      `Owner line: ${this.state.ownerLine?.name ?? 'none'}`,
    ]
    for (const provider of this.statusProviders) lines.push(...provider())
    return lines
  }
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
