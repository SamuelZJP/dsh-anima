/**
 * The `animaLife` service: channel publication, stimulus delivery, the Self and
 * triage sessions, the heartbeat loop (DESIGN §7), `open_conversation` with
 * intent outcomes (DESIGN §5), and the session and channel resolvers it
 * provides to the core gate.
 * @module @anima/life/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, channelKey, type ChannelRef, closesTurn, describeGoal, formatLocal, formatStamp, nextWake, parseWhen, readJson, writeJson, type AdmitRefusal } from '@anima/core'
import type {} from '@anima/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { reminderText, TurnCloser } from './closer.ts'
import { groupTriageModel, resolveLifeConfig, type Config as LifeConfig } from './config.ts'
import { batchText, GroupTriage, type Batch, type MessageStimulus } from './group-triage.ts'
import { nextHeartbeat } from './heartbeat.ts'
import { answeringIntent, describeOutcome, IntentTracker, type Outcome, type TrackerState } from './intent.ts'
import { buildReport, type ChannelLine } from './report.ts'
import { Inbox, inboxSummary } from './inbox.ts'
import { SessionRouter, type ModelChoice, type SessionHost } from './router.ts'
import { senderLabel, wakes, type ExtraBlock, type PublishedChannel, type Stimulus } from './stimulus.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaLife: AnimaLife
  }
  interface Events {
    /** A stimulus was delivered to one of her sessions. `anima-memory` records channel messages from it. */
    'anima/stimulus'(payload: StimulusEvent): void
    /** A chat woke her: she reads it, so its adapter may mark it read (Phase 9). */
    'anima/read'(payload: { readonly channel: ChannelRef }): void
  }
}

/** Payload of the `anima/stimulus` event. */
export interface StimulusEvent {
  readonly stimulus: Stimulus
  /** The session it was routed to (for `record`, the session it would have gone to). */
  readonly sessionId: string
  /**
   * `wake`: delivered as a waking message; `context`: joined the session's next
   * turn without waking; `record`: kept only in her transcript (group triage "remember").
   */
  readonly delivery: 'wake' | 'context' | 'record'
}

/** A chat's messages waiting to settle (DESIGN §6, message timing). */
interface SettleEntry {
  messages: MessageStimulus[]
  timer: ReturnType<typeof setTimeout> | undefined
  /** Opened by an unaddressed message in the attention window. */
  attention: boolean
  /** Real time of the first message: the cap counts from here. */
  first: number
  /** Typing notices seen while waiting. */
  typing: number
}

/** Options of the life service. */
export interface LifeOptions {
  /** Session host; DSH's by default (tests pass a fake). */
  readonly host?: SessionHost<Agent>
  readonly config?: Partial<LifeConfig>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A stimulus Anima delivered into one of her sessions. */
    'anima-stimulus': { kind: 'anima-stimulus'; stimulus: string; ref?: string; wake?: true } & ContextFormed
  }
}

/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_MS = 2_147_483_647
const MIN = 60_000
/** Real time a heartbeat delivery may take before the loop gives up and reschedules. */
const DELIVERY_TIMEOUT_MS = 120_000

/** Reject when a promise does not settle in time, so a stuck delivery cannot stall the loop. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnimaError('anima/delivery-timeout', `${what} did not finish within ${ms / 1000} s; check the DSH log for a preset or plugin that failed to load.`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** {@link SessionHost} over DSH's session controller, title and workspace services. */
export class DshSessionHost implements SessionHost<Agent> {
  constructor(private readonly ctx: Context) {}

  private controller() {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new AnimaError('anima/no-session-controller', 'DSH has no session controller; run Anima in a profile with the web app.')
    return controller
  }

  async resolve(sessionId: string): Promise<Agent | undefined> {
    const result = await this.controller().resolveAgent(sessionId as SessionId)
    if ('agent' in result) return result.agent
    if (result.error.code === 'session/not-found') return undefined
    throw new AnimaError('anima/session-resolve', `cannot resolve session ${sessionId}: ${result.error.message}`)
  }

  async create(sessionId: string, spec: { agentPreset: string; cwd: string }): Promise<string> {
    const value = await this.controller().create({ sessionId: sessionId as SessionId, cwd: spec.cwd, agentPreset: spec.agentPreset })
    return value.sessionId
  }

  isArchived(sessionId: string): boolean {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return false
    return (registry.archivedSessionIds as readonly string[]).includes(sessionId)
  }

  rename(agent: Agent, title: string): void {
    this.ctx.get('sessionTitle')?.rename(agent.session, title)
  }

  private message(text: string, summary: string, stimulus: string, ref?: string, extra: readonly ExtraBlock[] = [], wake = false) {
    return createUserMessage({
      content: [{ type: 'text', text }, ...extra],
      source: { kind: 'anima-stimulus', stimulus, form: 'notice', summary: boundContextSummary(summary), ...ref === undefined ? {} : { ref }, ...wake ? { wake: true as const } : {} },
    })
  }

  private async flush(agent: Agent): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new AnimaError('anima/no-sessions', 'DSH session service is missing.')
    if (!(await sessions.flush(agent.session))) {
      throw new AnimaError('anima/delivery-not-durable', `session ${agent.id} did not accept the message durably.`)
    }
  }

  async deliver(agent: Agent, text: string, summary: string, stimulus: string, ref?: string, extra?: readonly ExtraBlock[]): Promise<void> {
    const message = this.message(text, summary, stimulus, ref, extra, true)
    // A chat message joins a running turn as its next step, or starts one when
    // idle (DESIGN §6, message timing); everything else gets its own turn.
    if (stimulus === 'message' || stimulus === 'burst') agent.steer(message)
    else agent.followup(message)
    await this.flush(agent)
  }

  steer(agent: Agent, text: string, summary: string, stimulus: string): void {
    agent.steer(this.message(text, summary, stimulus))
  }

  async inject(agent: Agent, text: string, summary: string, stimulus: string): Promise<void> {
    agent.inject(this.message(text, summary, stimulus))
    await this.flush(agent)
  }

  selectModel(agent: Agent, choice: ModelChoice): void {
    agent.model.select({ provider: choice.provider, model: choice.model })
  }

  isBusy(agent: Agent): boolean {
    return agent.status === 'running'
  }
}

/** A close view to run in its own viewing session (DESIGN §11). */
export interface ViewRequest {
  /** Viewing key, unique per viewing (e.g. `bili:BV1xx:3`); names the session. */
  readonly key: string
  /** Title shown in the sidebar. */
  readonly title: string
  /** What she is looking at and why. */
  readonly text: string
  /** Frames with captions, in time order. */
  readonly parts: readonly ExtraBlock[]
  /** Vision-capable model of the viewing turn. */
  readonly model?: ModelChoice
  /** Real seconds the viewing may take. */
  readonly timeoutSeconds: number
  readonly signal?: AbortSignal
}

/** A viewing waiting for its note. */
interface ViewWaiter {
  resolve(note: string): void
  reject(error: Error): void
  /** Last assistant text, the fallback note. */
  lastText: string
}

/** Durable life-loop state, `<dataDir>/life.json`. */
interface LifeFile {
  nextHeartbeatAt?: number
  lastHeartbeatAt?: number
  /** Events since the last heartbeat, as report lines. */
  events: string[]
  /** Last message per channel key (either direction). */
  lastContact: Record<string, number>
  intents: TrackerState
  intentSeq: number
  /** Self was woken by a heartbeat and has not called rest yet. */
  awaitingSelfRest: boolean
  /** Counters for status and evidence. */
  counts: { heartbeats: number; acts: number; rests: number; intents: number }
  /** When she last spoke per channel key. */
  lastSpoke: Record<string, number>
  batchSeq: number
  outboxSeq: number
  /** Per her day and group channel: wakes and triage outcomes (evidence for runaway wakes). */
  groups: Record<string, Record<string, GroupDay>>
  /** Send time of the newest inbox message Self was last shown (Phase 9). */
  inboxSeen?: number
}

/** Health of one platform, as its adapter reported it. */
interface PlatformHealth {
  online: boolean
  /** When it last changed, on her clock. */
  since: number
  reason?: string | undefined
  /** Her Self session was told it went offline. */
  notified: boolean
  timer?: ReturnType<typeof setTimeout> | undefined
}

/** One group's counters for one of her days. */
interface GroupDay {
  /** Wakes from messages that addressed her or came from the owner. */
  direct: number
  /** Wakes in the attention window after she spoke (absent in files from before Phase 8). */
  attention?: number
  /** Wakes she chose in group triage. */
  triage: number
  batches: number
  remember: number
  ignore: number
  /** Batches settled by a fallback (timeout, turn end, skipped). */
  fallback: number
}

/** Days of group counters kept in life.json. */
const GROUP_DAYS = 14

function emptyFile(): LifeFile {
  return {
    events: [], lastContact: {}, intents: { pending: [], active: [], awaitingReply: [] }, intentSeq: 0, awaitingSelfRest: false,
    counts: { heartbeats: 0, acts: 0, rests: 0, intents: 0 }, lastSpoke: {}, batchSeq: 0, outboxSeq: 0, groups: {},
  }
}

/** Anima life service. */
export class AnimaLife extends Service {
  static inject = ['anima']

  /** Routing and session identity. */
  readonly router: SessionRouter<Agent>
  private readonly host: SessionHost<Agent>
  private readonly path: string
  private readonly file: LifeFile
  private readonly tracker: IntentTracker
  private timer: ReturnType<typeof setTimeout> | undefined
  private beating = false
  private triageDecided = true
  private lastReport = ''
  private disposed = false
  private readonly reportLines = new Set<() => string[]>()
  private readonly budgetLines = new Set<() => string[]>()
  /** Life config. */
  readonly config: Readonly<LifeConfig>
  /** Group triage buffers and batches. */
  readonly triage: GroupTriage
  /** Her initiated messages waiting to go out. */
  /** Seconds the outside holds a message she starts, for her intent arrival; none when nothing holds it. */
  private holdSeconds: () => number | undefined = () => undefined
  /** Batch whose turn is running in the group-triage session. */
  private triageTurn: string | undefined
  /** Viewing sessions waiting for their note, by session id. */
  private readonly views = new Map<string, ViewWaiter>()
  /** Health of each platform as its adapter reports it (DESIGN §11). */
  private readonly platforms = new Map<string, PlatformHealth>()
  /** Pending express calls in conversation sessions, by `session|callId`. */
  private readonly expressCalls = new Map<string, string>()
  /** Whether each conversation turn closed by an action (DESIGN §6, Turn shape). */
  private readonly closer: TurnCloser
  /** Chat messages waiting for their chat to settle, by channel key (DESIGN §6, message timing). */
  private readonly settling = new Map<string, SettleEntry>()
  /** Her inbox: chat messages held while she slept or was paused (Phase 9). */
  readonly inbox: Inbox
  /** Groups in their attention window after she spoke: channel key → real time it ends. */
  private readonly attention = new Map<string, number>()

  /**
   * @param ctx - root context.
   * @param options - a session host (tests), or `{ host?, config? }`.
   */
  constructor(ctx: Context, options?: SessionHost<Agent> | LifeOptions) {
    super(ctx, 'animaLife')
    const core = ctx.anima
    const { characterId, selfGeneration, conversationGeneration, dataDir } = core.config
    const opts: LifeOptions = options !== undefined && 'resolve' in options ? { host: options } : options ?? {}
    this.config = resolveLifeConfig(opts.config)
    const host = opts.host
    this.host = host ?? new DshSessionHost(ctx)
    this.router = new SessionRouter(this.host, {
      characterId, selfGeneration, conversationGeneration, dataDir, stamp: () => formatStamp(core.clock.now()),
      answerTools: (channel) => {
        const say = `${channel.platform}_say`
        return { say: core.behavior(say) === undefined ? undefined : say, ender: core.behavior('end_turn') === undefined ? undefined : 'end_turn' }
      },
    })
    this.path = join(dataDir, 'life.json')
    this.inbox = new Inbox(join(dataDir, 'inbox.json'))
    this.file = { ...emptyFile(), ...readJson<LifeFile>(this.path) }
    this.tracker = new IntentTracker(this.file.intents, name => core.behavior(name)?.effect === 'express')
    this.closer = new TurnCloser(this.config.conversation.closeReminders)
    const { groupTriage } = this.config
    this.triage = new GroupTriage(
      { windowMs: groupTriage.windowSeconds * 1000, maxBatch: groupTriage.maxBatch, timeoutMs: groupTriage.timeoutSeconds * 1000 },
      {
        nextId: () => { this.file.batchSeq += 1; this.save(); return this.file.batchSeq },
        classify: batch => this.classify(batch),
        settle: batch => this.settle(batch),
      },
      error => ctx.logger.warn(`anima group triage: ${error instanceof Error ? error.message : String(error)}`),
    )
    ctx.effect(() => () => this.triage.dispose(), 'animaLife.groupTriage')
    ctx.effect(() => () => {
      for (const health of this.platforms.values()) clearTimeout(health.timer)
      for (const entry of this.settling.values()) clearTimeout(entry.timer)
      this.settling.clear()
    }, 'animaLife.timers')

    core.provideSessions(id => this.router.describe(id))
    core.provideChannels(key => {
      const channel = this.router.channel(key)
      return channel === undefined ? undefined : { isOwner: channel.isOwner === true, display: channel.display, note: channel.note }
    }, () => this.router.known().map(({ channel }) => channelKey(channel)))
    core.addStatus(() => this.statusLines())
    core.addStatusPart('life', () => this.statusPart())

    this.registerBehaviors()

    // Sleep and wakes (Phase 9): what settles while she falls asleep goes to the inbox; a
    // deliberate wake or a resume shows her the inbox in Self.
    ctx.on('anima/sleep', () => {
      for (const key of [...this.settling.keys()]) this.flushSettled(key)
      const next = this.file.nextHeartbeatAt
      const now = core.clock.now()
      if (next !== undefined && core.mode(next) === 'night') this.schedule(nextHeartbeat(this.scheduleInput(now, undefined)).at)
    })
    ctx.on('anima/woken', () => {
      void this.wakeSelf('[被叫醒] 主人把你叫醒了。').catch((error: unknown) => ctx.logger.warn(`anima: could not wake Self: ${String(error)}`))
    })
    ctx.on('anima/paused', (paused) => {
      if (paused || this.inbox.size() === 0 || core.asleep()) return
      void this.wakeSelf('[继续] 主人让你继续了。').catch((error: unknown) => ctx.logger.warn(`anima: could not wake Self: ${String(error)}`))
    })

    ctx.on('session/event', (session, event) => this.onSessionEvent(session.id, event))
    ctx.on('agent/turn-stopping', ({ agent }) => this.onStopping(agent))

    ctx.effect(() => {
      this.disposed = false
      if (this.file.nextHeartbeatAt === undefined) {
        const now = core.clock.now()
        this.schedule(core.mode(now) === 'night' ? nextWakeOf(core, now) : now + MIN)
      } else {
        this.arm()
      }
      return () => {
        this.disposed = true
        clearTimeout(this.timer)
      }
    }, 'animaLife.heartbeat')
  }

  /**
   * Publish an adapter's channels, owned by the calling plugin.
   * @param channels - channels she can talk in.
   */
  publish(channels: readonly PublishedChannel[]): () => void {
    return this.ctx.effect(() => {
      const forget = channels.map(channel => this.router.know(channel))
      return () => { for (const off of forget) off() }
    }, 'animaLife.publish()')
  }

  /**
   * Add lines to every situation report, owned by the calling plugin. Lines
   * state facts; they never suggest what to do.
   * @param provider - returns the lines at report time.
   */
  addReportLine(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.reportLines.add(provider)
      return () => { this.reportLines.delete(provider) }
    }, 'animaLife.addReportLine()')
  }

  /**
   * Add budget lines to every situation report (what is left of what the
   * outside allows), owned by the calling plugin. Facts only.
   */
  addBudgetLine(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.budgetLines.add(provider)
      return () => { this.budgetLines.delete(provider) }
    }, 'animaLife.addBudgetLine()')
  }

  /**
   * Route and deliver one stimulus. A group message that does not address her
   * and is not from the owner goes to group triage first (DESIGN §5), unless the
   * group is in its attention window after she spoke there. Every other chat
   * message waits for its chat to settle (`conversation.settleSeconds` of quiet,
   * at most `settleMaxSeconds`), so a burst is one arrival (DESIGN §6); an
   * addressed group message takes the group's buffered messages into its burst.
   * While she is asleep or paused, chat messages that would wake her go to her
   * inbox instead (Phase 9). While the outside holds her (a pause), the same.
   * @param options.model - model to select on the target session before delivery.
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus, options: { model?: ModelChoice } = {}): Promise<string> {
    if (stimulus.type === 'message' || stimulus.type === 'channel-event' || stimulus.type === 'intent' || stimulus.type === 'burst') {
      const key = channelKey(stimulus.channel)
      if (stimulus.type === 'message') {
        // Known without replacing the adapter's own entry, so unloading the adapter still forgets it.
        if (this.router.channel(key) === undefined) this.router.know(stimulus.channel)
        const group = stimulus.channel.kind === 'group'
        if (group && !wakes(stimulus)) {
          if (this.attentive(key) && !this.unreachable()) return this.settleLater(stimulus, true)
          this.triage.add(stimulus)
          return this.router.conversationId(stimulus.channel)
        }
        if (this.unreachable()) return this.hold(stimulus)
        if (this.config.conversation.settleSeconds > 0) return this.settleLater(stimulus, false)
        return this.deliverBurst(key, [stimulus], false)
      }
      if (stimulus.type === 'intent') {
        // Held messages of that chat go with the intent, as context before it (DESIGN §5).
        const heldWhy = this.inbox.why(key)
        const held = this.inbox.take(key)
        if (held.length > 0) {
          this.ctx.anima.recordActivity({ type: 'inbox-release', channel: key, reason: 'intent', count: held.length })
          await this.deliverOne({ type: 'burst', channel: stimulus.channel, messages: held, held: held.length, heldWhy, ts: stimulus.ts }, {}, false)
        }
      }
    }
    if (stimulus.type === 'notice' && this.unreachable()) {
      // A notice for Self waits for her first report after she wakes (Phase 9).
      this.note(stimulus.text)
      return this.router.selfId
    }
    return this.deliverOne(stimulus, options)
  }

  /** Whether she cannot be reached now: asleep (outside a deliberate wake), or held from outside (a pause). */
  private unreachable(): boolean {
    return this.ctx.anima.asleep() || this.heldBy() !== undefined
  }

  /** Why the outside holds her now, if it does (`anima/admit` reach). */
  private heldBy(): AdmitRefusal | undefined {
    return this.ctx.anima.admit({ kind: 'reach' })
  }

  /** Hold a chat message in her inbox (Phase 9); its platform does not mark it read. */
  private hold(stimulus: MessageStimulus): string {
    const reason: 'asleep' | 'paused' = this.ctx.anima.asleep() || this.heldBy() === undefined ? 'asleep' : 'paused'
    this.inbox.hold(stimulus, reason)
    this.file.lastContact[channelKey(stimulus.channel)] = stimulus.ts
    this.save()
    this.ctx.anima.recordActivity({ type: 'inbox-held', channel: channelKey(stimulus.channel), reason })
    // The transcript still records it, so consolidation sees what came in.
    this.ctx.emit('anima/stimulus', { stimulus, sessionId: this.router.conversationId(stimulus.channel), delivery: 'record' })
    return this.router.conversationId(stimulus.channel)
  }

  /**
   * The other person is typing in a chat (where the platform reports it, Phase 9):
   * a burst waiting there keeps waiting, within `settleMaxSeconds`.
   * @param channel - the chat.
   */
  typing(channel: ChannelRef): void {
    const key = channelKey(channel)
    const entry = this.settling.get(key)
    if (entry === undefined) return
    entry.typing += 1
    this.armSettle(key, entry)
  }

  /** Channel keys whose messages wait for their chat to settle (status and scripted checks). */
  settlingChannels(): string[] {
    return [...this.settling.keys()]
  }

  /** Whether a group is in its attention window (DESIGN §6). */
  private attentive(key: string): boolean {
    return (this.attention.get(key) ?? 0) > Date.now()
  }

  /** Hold a chat message until its chat settles; each new one restarts the quiet wait, within the cap. */
  private settleLater(stimulus: MessageStimulus, attention: boolean): string {
    const key = channelKey(stimulus.channel)
    const entry = this.settling.get(key) ?? { messages: [], timer: undefined, attention, first: Date.now(), typing: 0 }
    entry.messages.push(stimulus)
    this.settling.set(key, entry)
    this.armSettle(key, entry)
    return this.router.conversationId(stimulus.channel)
  }

  private armSettle(key: string, entry: SettleEntry): void {
    clearTimeout(entry.timer)
    const { settleSeconds, settleMaxSeconds } = this.config.conversation
    const quiet = settleSeconds * 1000
    const cap = entry.first + Math.max(settleMaxSeconds, settleSeconds) * 1000 - Date.now()
    entry.timer = setTimeout(() => this.flushSettled(key), Math.max(0, Math.min(quiet, cap)))
  }

  /** Messages waiting to settle in a chat, taken out of the wait. */
  private takeSettling(key: string): MessageStimulus[] {
    const entry = this.settling.get(key)
    if (entry === undefined) return []
    clearTimeout(entry.timer)
    this.settling.delete(key)
    return entry.messages
  }

  /**
   * A chat settled: its messages go to her as one burst. A burst of only
   * unaddressed attention-window messages first asks the outside (`group_attention`
   * wake); refused, it goes to group triage like any other chatter. If she fell
   * asleep (or was paused) meanwhile, waking messages go to her inbox.
   */
  private flushSettled(key: string): void {
    const entry = this.settling.get(key)
    const messages = this.takeSettling(key)
    if (entry === undefined || messages.length === 0) return
    const waking = messages.some(message => wakes(message))
    if (this.unreachable()) {
      for (const message of messages) {
        if (wakes(message)) this.hold(message)
        else this.triage.add(message)
      }
      return
    }
    if (!waking) {
      if (this.ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: key }) !== undefined) {
        for (const message of messages) this.triage.add(message)
        return
      }
      const stats = this.groupDay(key)
      stats.attention = (stats.attention ?? 0) + 1
      this.save()
    }
    void this.deliverBurst(key, messages, !waking)
      .catch((error: unknown) => this.ctx.logger.warn(`anima: could not deliver to ${messages[0]!.channel.display}: ${error instanceof Error ? error.message : String(error)}`))
  }

  /**
   * Deliver settled messages as one arrival (DESIGN §5, bursts): an addressed
   * group burst takes the group's buffered messages before it, and the chat's
   * held inbox messages go first, marked with their times. A lone message keeps
   * the single-message format. Every message is still recorded on its own.
   */
  private async deliverBurst(key: string, settled: readonly MessageStimulus[], attention: boolean): Promise<string> {
    const channel = settled[0]!.channel
    const heldWhy = this.inbox.why(key)
    const held = this.inbox.take(key)
    if (held.length > 0) this.ctx.anima.recordActivity({ type: 'inbox-release', channel: key, reason: 'wake', count: held.length })
    const buffered = channel.kind === 'group' && !attention ? this.triage.take(key) : []
    if (channel.kind === 'group' && !attention) {
      this.groupDay(key).direct += 1
      this.save()
    }
    const messages = [...held, ...[...buffered, ...settled].sort((a, b) => a.ts - b.ts)]
    if (messages.length === 1) {
      const only = messages[0]!
      return this.deliverOne(attention ? { ...only, via: { kind: 'attention' } } : only, {}, true)
    }
    return this.deliverOne({
      type: 'burst', channel, messages,
      ...held.length > 0 ? { held: held.length, heldWhy } : {},
      ...attention ? { via: { kind: 'attention' as const } } : {},
      ts: messages.at(-1)!.ts,
    }, {}, true)
  }

  private async deliverOne(stimulus: Stimulus, options: { model?: ModelChoice }, wake = wakes(stimulus)): Promise<string> {
    const sessionId = await this.deliverNow(stimulus, options, wake)
    if (stimulus.type === 'burst') {
      // The transcript records each message on its own; held ones were recorded when they arrived.
      for (const [index, message] of stimulus.messages.entries()) {
        if (index < (stimulus.held ?? 0)) continue
        this.ctx.emit('anima/stimulus', { stimulus: message, sessionId, delivery: wake && index === stimulus.messages.length - 1 ? 'wake' : 'context' })
      }
    } else {
      this.ctx.emit('anima/stimulus', { stimulus, sessionId, delivery: wake ? 'wake' : 'context' })
    }
    // A chat she is woken by is read, like a person opening it (Phase 9).
    if (wake && (stimulus.type === 'message' || stimulus.type === 'burst')) this.ctx.emit('anima/read', { channel: stimulus.channel })
    return sessionId
  }

  private async deliverNow(stimulus: Stimulus, options: { model?: ModelChoice }, wake: boolean): Promise<string> {
    const model = options.model
    const before = model === undefined ? undefined : (agent: Agent) => this.host.selectModel(agent, model)
    if (stimulus.type === 'message' || stimulus.type === 'burst') {
      const key = channelKey(stimulus.channel)
      const messages = stimulus.type === 'burst' ? stimulus.messages : [stimulus]
      const last = messages.at(-1)!
      this.file.lastContact[key] = Math.max(this.file.lastContact[key] ?? 0, last.ts)
      if (wake) {
        const senders = [...new Set(messages.filter(m => wakes(m)).map(m => `${m.sender.displayName}${m.sender.isOwner ? ' (owner)' : ''}`))]
        if (senders.length > 0) this.file.events.push(`${senders.join(', ')} wrote to you in ${stimulus.channel.display} at ${formatLocal(last.ts)}.`)
      }
      if (messages.some(m => m.sender.isOwner)) this.report(this.tracker.onOwnerMessage(key))
      this.save()
    }
    return this.routed(stimulus, before, wake)
  }

  /** Deliver through the router and record each wake in the activity log (DESIGN §12). */
  private async routed(stimulus: Stimulus, before?: (agent: Agent) => void, wake = wakes(stimulus)): Promise<string> {
    const sessionId = await this.router.deliver(stimulus, before, wake)
    if (wake) {
      const core = this.ctx.anima
      const channel = 'channel' in stimulus && stimulus.channel !== undefined ? channelKey(stimulus.channel) : undefined
      core.recordActivity({
        type: 'wake',
        stimulus: stimulus.type === 'heartbeat' ? `heartbeat-${stimulus.to}` : stimulus.type,
        session: core.describeSession(sessionId)?.kind ?? 'unknown',
        sessionId,
        ...channel === undefined ? {} : { channel },
      })
    }
    return sessionId
  }

  /**
   * Add an event line to her next situation report (a platform event such as
   * a friend request), without waking anyone (DESIGN §5, batched at the next heartbeat).
   */
  note(text: string): void {
    this.file.events.push(text)
    this.save()
  }

  // ---- viewing ----

  /**
   * Look closely at frames in a short viewing session of their own, on a
   * vision model, and return her note (DESIGN §11). Only the note goes back to
   * the caller, so the Self session stays text-only. Waits for `viewing_note`;
   * a turn that ends without it yields its last text.
   * @returns the viewing note.
   */
  async view(request: ViewRequest): Promise<string> {
    const sessionId = this.router.viewingId(request.key)
    if (this.views.has(sessionId)) throw new AnimaError('anima/view-busy', `viewing ${request.key} is already running.`)
    let waiter!: ViewWaiter
    const done = new Promise<string>((resolve, reject) => {
      waiter = { resolve, reject, lastText: '' }
    })
    const onAbort = () => waiter.reject(new AnimaError('anima/view-aborted', 'the viewing was stopped.'))
    this.views.set(sessionId, waiter)
    const timer = setTimeout(() => waiter.reject(new AnimaError('anima/view-timeout', `the viewing did not finish within ${request.timeoutSeconds} s.`)), request.timeoutSeconds * 1000)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.deliver({ type: 'view', key: request.key, title: request.title, text: request.text, parts: request.parts, ts: this.ctx.anima.clock.now() }, request.model === undefined ? {} : { model: request.model })
      return await done
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      this.views.delete(sessionId)
    }
  }

  // ---- group triage ----

  private groupDay(key: string, t = this.ctx.anima.clock.now()): GroupDay {
    const day = this.ctx.anima.dayKey(t)
    const days = this.file.groups
    days[day] ??= {}
    for (const old of Object.keys(days).sort().slice(0, -GROUP_DAYS)) delete days[old]
    return days[day][key] ??= { direct: 0, triage: 0, batches: 0, remember: 0, ignore: 0, fallback: 0 }
  }

  /** Deliver a closed batch to the group-triage session; false when triage cannot run now. */
  private async classify(batch: Batch): Promise<boolean> {
    const core = this.ctx.anima
    const now = core.clock.now()
    this.groupDay(batch.channelKey, now).batches += 1
    this.save()
    if (core.mode(now) === 'night' || core.admit({ kind: 'turn', purpose: 'group-triage' }) !== undefined) return false
    const day = core.dayKey(now)
    this.router.groupTriageId(day)
    const lines = batch.messages.map(m => `${formatLocal(m.ts).slice(11)} ${senderLabel(m)}: ${m.text}`)
    const spoke = this.file.lastSpoke[batch.channelKey]
    const text = batchText(batch, lines, spoke === undefined ? undefined : formatLocal(spoke))
    const model = groupTriageModel(this.config) ?? core.modeConfig('day').triageModel
    await withTimeout(this.routed({ type: 'group-batch', day, batch: batch.id, channel: batch.channel, text, ts: now }, agent => {
      this.host.selectModel(agent, model)
    }), DELIVERY_TIMEOUT_MS, 'batch delivery to the group-triage session')
    return true
  }

  /** Apply a settled batch. */
  private settle(batch: Batch): void {
    const stats = this.groupDay(batch.channelKey)
    if (batch.by !== 'her') stats.fallback += 1
    const messages: readonly MessageStimulus[] = batch.messages
    switch (batch.decision) {
      case 'wake': {
        stats.triage += 1
        // The waking message states that nobody addressed her and why she chose to look (DESIGN §5).
        const via = { kind: 'triage' as const, reason: batch.reason ?? '' }
        void (async () => {
          for (const [index, message] of messages.entries()) {
            const last = index === messages.length - 1
            await this.deliverOne(last ? { ...message, via } : message, {}, last)
          }
        })().catch((error: unknown) => this.ctx.logger.warn(`anima: could not wake ${batch.channel.display}: ${String(error)}`))
        break
      }
      case 'remember': {
        stats.remember += 1
        const sessionId = this.router.conversationId(batch.channel)
        for (const stimulus of messages) this.ctx.emit('anima/stimulus', { stimulus, sessionId, delivery: 'record' })
        break
      }
      case 'ignore':
        stats.ignore += 1
        break
    }
    this.save()
  }

  // ---- her own initiations (read by the outside) ----

  /**
   * The intent a conversation turn is answering, if the session is answering
   * one: she started this conversation herself. The outside may hold such a
   * message before it goes out.
   * @param sessionId - the calling conversation session.
   */
  answering(sessionId: string): { readonly intentId: string; readonly channelKey: string; readonly display: string } | undefined {
    const intent = answeringIntent(this.file.intents, sessionId)
    return intent === undefined ? undefined : { intentId: intent.id, channelKey: intent.channelKey, display: intent.display }
  }

  /**
   * Tell her intent arrivals how long the outside holds what she starts
   * (arrival facts only). Owned by the calling plugin.
   */
  provideHoldSeconds(seconds: () => number | undefined): () => void {
    return this.ctx.effect(() => {
      this.holdSeconds = seconds
      return () => {
        if (this.holdSeconds === seconds) this.holdSeconds = () => undefined
      }
    }, 'animaLife.provideHoldSeconds()')
  }

  // ---- platform health ----

  /** Whether a platform is online as far as its adapter said; true when it never said. */
  platformOnline(platform: string): boolean {
    return this.platforms.get(platform)?.online !== false
  }

  /**
   * An adapter reports its platform's health (DESIGN §11). Going offline, her
   * Self session gets a notice once it has lasted `platforms.noticeAfterSeconds`;
   * coming back, she is told it is back if she was told it went down. Recorded
   * (`anima/record`); never alerts anyone.
   * @param platform - platform id, e.g. `qq`.
   * @param online - whether the account can send and receive now.
   * @param reason - why it is offline, in a few words.
   */
  platformStatus(platform: string, online: boolean, reason?: string): void {
    const core = this.ctx.anima
    const health = this.platforms.get(platform) ?? { online: true, since: core.clock.now(), notified: false }
    this.platforms.set(platform, health)
    if (health.online === online) {
      if (!online && reason !== undefined) health.reason = reason
      return
    }
    health.online = online
    health.since = core.clock.now()
    clearTimeout(health.timer)
    health.timer = undefined
    const name = platform.toUpperCase()
    core.recordActivity({ type: 'platform', platform, online, ...online || reason === undefined ? {} : { reason } })
    if (!online) {
      health.reason = reason
      this.ctx.logger.warn(`anima: ${name} offline: ${reason ?? 'unknown reason'}`)
      const since = health.since
      const tell = () => {
        if (health.online || health.since !== since) return
        health.notified = true
        this.tellSelf(`${name} went offline at ${formatLocal(since)}${health.reason === undefined ? '' : ` (${health.reason})`}. Nobody there can reach you, and you cannot reach anyone there until it is back; you will get a notice then.`, `${name} offline`, 'platform-offline')
      }
      const delayMs = this.config.platforms.noticeAfterSeconds * 1000
      if (delayMs <= 0) tell()
      else health.timer = setTimeout(tell, delayMs)
      return
    }
    this.ctx.logger.info(`anima: ${name} back online`)
    if (health.notified) {
      health.notified = false
      this.tellSelf(`${name} is back online at ${formatLocal(health.since)}.`, `${name} back online`, 'platform-online')
    }
    health.reason = undefined
  }

  /** A logged notice for her Self session that does not wake it, also kept for her next report. */
  private tellSelf(text: string, summary: string, stimulus: string): void {
    this.file.events.push(text)
    this.save()
    void (async () => {
      const self = await this.router.find(this.router.selfId)
      if (self !== undefined) await this.host.inject(self, this.router.stamped(`[notice] ${text}`), summary, stimulus)
    })().catch((error: unknown) => this.ctx.logger.warn(`anima: could not notify the Self session: ${String(error)}`))
  }

  /** Next scheduled heartbeat, on her clock. */
  get nextHeartbeatAt(): number | undefined {
    return this.file.nextHeartbeatAt
  }

  // ---- heartbeat ----

  private save(): void {
    writeJson(this.path, this.file)
  }

  private schedule(at: number): void {
    this.file.nextHeartbeatAt = at
    this.save()
    this.arm()
  }

  private arm(): void {
    clearTimeout(this.timer)
    if (this.disposed || this.file.nextHeartbeatAt === undefined) return
    const clock = this.ctx.anima.clock
    const delay = Math.min(MAX_TIMER_MS, Math.ceil(clock.realDelay(this.file.nextHeartbeatAt - clock.now())))
    this.timer = setTimeout(() => {
      if (this.disposed) return
      if (this.file.nextHeartbeatAt !== undefined && clock.now() + 1 < this.file.nextHeartbeatAt) return this.arm()
      this.beat().catch((error: unknown) => {
        this.ctx.logger.warn(`anima heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
        this.schedule(clock.now() + this.ctx.anima.modeConfig('day').minIntervalMinutes * MIN)
      })
    }, delay)
  }

  private async busy(sessionId: string): Promise<boolean> {
    const agent = await this.router.find(sessionId)
    return agent !== undefined && this.host.isBusy(agent)
  }

  /**
   * Run one heartbeat now: build the situation report and deliver it to the
   * day's triage session on the triage model. Skips (and reschedules) when
   * paused, over budget, busy, or at night with no wake-up left.
   */
  async beat(): Promise<void> {
    if (this.beating) return
    this.beating = true
    try {
      const core = this.ctx.anima
      const now = core.clock.now()
      const mode = core.mode(now)
      const held = core.admit({ kind: 'turn', purpose: 'heartbeat' })
      if (held !== undefined) return this.schedule(held.untilWake === true ? nextWakeOf(core, now) : now + core.modeConfig('day').minIntervalMinutes * MIN)
      if (mode === 'night' && core.nightWakesLeft(now) <= 0) return this.schedule(nextWakeOf(core, now))
      const day = core.dayKey(now)
      const triageId = this.router.triageId(day)
      if (await this.busy(triageId) || await this.busy(this.router.selfId)) return this.schedule(now + MIN)
      if (mode === 'night') core.useNightWake(now)
      // Awake with new messages in her inbox: she sees them in Self at once, not after a
      // cheap triage rest (owner decision 2026-11-12); she still decides whether to answer.
      if (mode === 'day' && this.inboxNewest() > (this.file.inboxSeen ?? 0)) {
        this.file.lastHeartbeatAt = now
        this.file.counts.heartbeats += 1
        await this.wakeSelf('[醒来] 你醒了，收件箱里有你睡着时收到的消息。')
        return
      }

      const report = this.reportText(now)
      this.lastReport = report
      this.file.events = []
      this.file.lastHeartbeatAt = now
      this.file.counts.heartbeats += 1
      this.triageDecided = false
      // Fallback if the triage turn never decides; rest() replaces it.
      this.schedule(nextHeartbeat(this.scheduleInput(now, undefined)).at)
      const canConsolidate = core.behavior('memory_consolidate') !== undefined
      const ask = mode === 'night'
        ? canConsolidate ? 'You are asleep. Call rest(until?) to go back to sleep, or memory_consolidate() to sort your memories first.' : 'You are asleep. Call rest(until?) to go back to sleep.'
        : 'Decide: rest(until?) to keep resting, or heartbeat_act(reason) to get up and act now.'
      await withTimeout(this.routed({ type: 'heartbeat', to: 'triage', day, text: `${report}\n\n${ask}`, ts: now }, agent => {
        this.host.selectModel(agent, core.modeConfig(mode).triageModel)
      }), DELIVERY_TIMEOUT_MS, 'heartbeat delivery to the triage session')
    } finally {
      this.beating = false
    }
  }

  private scheduleInput(now: number, requested: number | undefined) {
    const core = this.ctx.anima
    const day = core.modeConfig('day')
    return {
      now, requested, rhythm: core.config.day,
      minMinutes: day.minIntervalMinutes, maxMinutes: day.maxIntervalMinutes, defaultMinutes: day.defaultIntervalMinutes,
      nightWakesLeft: core.nightWakesLeft(now),
      mode: (t: number) => core.mode(t),
    }
  }

  private reportText(now: number, forSelf = false): string {
    const core = this.ctx.anima
    const channels: ChannelLine[] = this.router.known().map(({ channel }) => {
      const key = `${channel.platform}:${channel.account}:${channel.kind}:${channel.id}`
      return { key, display: channel.display, mayInitiate: core.admit({ kind: 'initiate', channelKey: key }) === undefined, lastContact: this.file.lastContact[key] }
    })
    const notes = [...this.sleepLines(now), core.selfModelReportLine(), ...[...this.reportLines].flatMap(provider => provider())]
    if (forSelf && core.clock.speed > 1) notes.push(`Test clock: your clock runs at ${core.clock.speed}× speed; alarms from schedule_create run on the real clock (real time now ${formatLocal(core.clock.realTime())}).`)
    return buildReport({
      time: formatStamp(now), phase: core.phase(now), mode: core.mode(now),
      state: core.stateText(),
      goals: core.goals.open().map(describeGoal),
      events: this.file.events,
      budgets: [...this.budgetLines].flatMap(provider => provider()),
      channels, now, notes,
    })
  }

  /** Report lines on sleep and the inbox (Phase 9): facts only. */
  private sleepLines(now: number): string[] {
    const core = this.ctx.anima
    const info = core.bedtimeInfo(now)
    const hhmm = (t: number) => formatLocal(t).slice(11)
    const lines: string[] = []
    const phase = core.phase(now)
    if (info.wokenAt !== undefined && !info.asleep && info.wokenUntil !== undefined && now < info.wokenUntil) {
      lines.push(`The owner woke you at ${hhmm(info.wokenAt)}; you stay awake until you sleep again (sleep) or until ${hhmm(info.wokenUntil)}.`)
    } else if (!info.asleep && (phase === 'winding-down' || now >= info.earliest)) {
      lines.push(`Bedtime: ${now >= info.earliest ? 'you may go to sleep now with sleep' : `from ${hhmm(info.earliest)} you may go to sleep with sleep`}; at ${hhmm(info.latest)} you fall asleep anyway.`)
    }
    const inbox = inboxSummary(this.inbox.entries())
    if (inbox !== undefined) lines.push(inbox)
    return lines
  }

  /**
   * Wake the Self session with her report and a first line saying why (Phase
   * 9): a deliberate wake by the owner, a resume after a pause, or the first
   * heartbeat after waking while her inbox holds messages. She still decides
   * whether to answer anything; the turn ends with rest.
   */
  private async wakeSelf(first: string): Promise<void> {
    const core = this.ctx.anima
    const now = core.clock.now()
    if (await this.busy(this.router.selfId)) {
      this.note(first)
      return
    }
    this.file.awaitingSelfRest = true
    this.file.counts.acts += 1
    this.file.inboxSeen = this.inboxNewest()
    const report = this.reportText(now, true)
    this.file.events = []
    this.save()
    const text = `${first}\n\n${report}\n\nDo what you want with your tools. When you are done, call rest(until?).`
    await this.routed({ type: 'heartbeat', to: 'self', day: core.dayKey(now), text, ts: now }, agent => {
      this.host.selectModel(agent, core.modeConfig(core.mode(now)).actionModel)
    })
    this.schedule(nextHeartbeat(this.scheduleInput(now, undefined)).at)
  }

  /** Send time of the newest held message, or 0. */
  private inboxNewest(): number {
    return Math.max(0, ...this.inbox.entries().map(entry => entry.messages.at(-1)!.ts))
  }

  private async escalate(reason: string): Promise<void> {
    const core = this.ctx.anima
    const now = core.clock.now()
    core.spendTurn()
    this.file.awaitingSelfRest = true
    this.file.counts.acts += 1
    this.save()
    const report = this.lastReport === '' ? this.reportText(now, true) : `${this.lastReport}\n${this.reportText(now, true).split('\n').filter(line => line.startsWith('Test clock:')).join('\n')}`.trimEnd()
    const text = `${report}\n\nYou woke up wanting to: ${reason}\nAct on it with your tools if you still want to. When you are done, call rest(until?).`
    await this.routed({ type: 'heartbeat', to: 'self', day: core.dayKey(now), text, ts: now }, agent => {
      this.host.selectModel(agent, core.modeConfig(core.mode(now)).actionModel)
    })
  }

  // ---- intents ----

  /**
   * Hand an intent to a channel's conversation (DESIGN §5): what
   * `open_conversation` does once the gate allowed it. Public for scripted
   * checks, which open intents without a Self turn; callers outside the gate
   * bypass the owner's initiate limits, so only test harnesses use it directly.
   * @param key - channel key.
   * @param intent - what she wants from the conversation.
   * @param context - optional context.
   * @returns the intent id and the conversation session id.
   */
  async openIntent(key: string, intent: string, context?: string): Promise<{ intentId: string; sessionId: string }> {
    const channel = this.router.channel(key)
    if (channel === undefined) {
      const known = this.router.known().map(({ channel: c }) => channelKey(c)).join(', ')
      throw new AnimaError('anima/unknown-channel', `no channel "${key}". Known channels: ${known || 'none'}.`)
    }
    const now = this.ctx.anima.clock.now()
    const intentId = `i${++this.file.intentSeq}`
    const sessionId = this.router.conversationId(channel)
    this.tracker.open({ id: intentId, sessionId, channelKey: key, display: channel.display, intent, at: now })
    this.file.counts.intents += 1
    this.file.lastContact[key] = now
    this.save()
    await this.routed({ type: 'intent', channel, intentId, intent, context, heldSeconds: this.holdSeconds(), ts: now })
    return { intentId, sessionId }
  }

  private report(outcome: Outcome | undefined): void {
    if (outcome === undefined) return
    const text = describeOutcome(outcome)
    this.file.events.push(text)
    this.save()
    void (async () => {
      const self = await this.router.find(this.router.selfId)
      if (self !== undefined) await this.host.inject(self, this.router.stamped(`[notice] ${text}`), `Intent ${outcome.intent.id}: ${outcome.kind}`, 'intent-outcome')
    })().catch((error: unknown) => this.ctx.logger.warn(`anima: could not report intent outcome: ${String(error)}`))
  }

  private onSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    const info = this.router.describe(sessionId)
    if (info === undefined) return
    const data = event.data as Record<string, unknown>
    switch (event.type) {
      case 'user/message': {
        const source = (data as { source?: { kind?: string; ref?: string; wake?: boolean } }).source
        if (info.kind === 'conversation' && source?.kind === 'anima-stimulus') this.tracker.onUserMessage(sessionId, source.ref)
        if (info.kind === 'conversation' && source?.kind === 'anima-stimulus' && source.wake === true) this.closer.onWake(sessionId)
        if (info.kind === 'group-triage' && source?.kind === 'anima-stimulus' && source.ref !== undefined) this.triageTurn = source.ref
        if (info.kind === 'self' && source?.kind === 'schedule') {
          const content = (data as { content?: { type: string; text?: string }[] }).content ?? []
          const text = content.map(block => block.text ?? '').join('')
          for (const prompt of alarmPrompts(text)) this.file.events.push(`An alarm you set rang: ${JSON.stringify(prompt)}.`)
          if (alarmPrompts(text).length === 0) this.file.events.push('An alarm you set rang.')
        }
        this.save()
        break
      }
      case 'tool/call': {
        const { callId, name, arguments: raw } = data as { callId: string; name: string; arguments: string }
        if (info.kind === 'conversation') {
          const args = safeObject(raw)
          this.tracker.onToolCall(sessionId, callId, name, typeof args.reason === 'string' ? args.reason : undefined)
          const meta = this.ctx.anima.behavior(name)
          this.closer.onToolCall(sessionId, callId, meta !== undefined && closesTurn(meta, args))
          if (meta?.effect === 'express') {
            this.expressCalls.set(`${sessionId}|${callId}`, name)
            this.file.lastContact[info.channelKey] = this.ctx.anima.clock.now()
            this.file.lastSpoke[info.channelKey] = this.ctx.anima.clock.now()
            this.save()
          }
        }
        break
      }
      case 'tool/result': {
        if (info.kind !== 'conversation') break
        const message = (data as { message: { toolCallId: string; isError?: boolean; content?: { type: string; text?: string }[] } }).message
        const errorText = message.isError === true ? (message.content ?? []).map(block => block.text ?? '').join('') : undefined
        const outcome = this.tracker.onToolResult(sessionId, message.toolCallId, message.isError === true, errorText)
        this.report(outcome)
        this.closer.onToolResult(sessionId, message.toolCallId, message.isError === true)
        const express = this.expressCalls.get(`${sessionId}|${message.toolCallId}`)
        this.expressCalls.delete(`${sessionId}|${message.toolCallId}`)
        // Speaking in a group opens its attention window (DESIGN §6, message timing).
        const attentionMs = this.config.groupTriage.attentionSeconds * 1000
        if (express === `${info.channel.platform}_say` && message.isError !== true && info.channel.kind === 'group' && attentionMs > 0) {
          this.attention.set(info.channelKey, Date.now() + attentionMs)
        }
        // A reply outside an intent: her Self hears it was already answered (DESIGN §5, Phase 7).
        if (express !== undefined && message.isError !== true && outcome === undefined) this.noteResponded(info.channelKey, express)
        this.save()
        break
      }
      case 'assistant/message': {
        if (info.kind === 'conversation') {
          const content = (data as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []
          this.closer.onText(sessionId, content.filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
        }
        const waiter = info.kind === 'viewing' ? this.views.get(sessionId) : undefined
        if (waiter !== undefined) {
          const content = (data as { message?: { content?: { type: string; text?: string }[] } }).message?.content ?? []
          const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim()
          if (text !== '') waiter.lastText = text
        }
        break
      }
      case 'turn/end': {
        if (info.kind === 'viewing') {
          const waiter = this.views.get(sessionId)
          if (waiter !== undefined) {
            if (waiter.lastText !== '') waiter.resolve(waiter.lastText)
            else waiter.reject(new AnimaError('anima/view-no-note', 'the viewing ended without a note.'))
          }
        } else if (info.kind === 'group-triage') {
          // A batch turn that ended without a decision is remembered, never woken.
          if (this.triageTurn !== undefined) this.triage.decide(this.triageTurn, 'remember', 'turn-end')
          this.triageTurn = undefined
        } else if (info.kind === 'conversation') {
          this.report(this.tracker.onTurnEnd(sessionId))
          this.save()
          // A turn that failed (a model error, max tokens) never reaches turn-stopping: if a
          // waking arrival was still unanswered, nothing reached them, so it is a lost reply too.
          const reason = (data as { reason?: { kind?: string; error?: { code?: string; message?: string } } }).reason
          const text = this.closer.lastText(sessionId)
          if (this.closer.isOpen(sessionId) && reason?.kind !== undefined && reason.kind !== 'completed' && reason.kind !== 'aborted') {
            const why = reason.kind === 'error' ? `error: ${reason.error?.code ?? reason.error?.message ?? 'unknown'}` : reason.kind
            this.ctx.anima.recordActivity({ type: 'lost-reply', channel: info.channelKey, sessionId, text, reason: why })
            this.ctx.logger.warn(`anima: lost reply in ${info.channel.id}: the turn ended with ${why} before a say or end_turn`)
          }
          this.closer.onTurnEnd(sessionId)
        } else if (info.kind === 'triage' && !this.triageDecided) {
          // Keep the fallback heartbeat scheduled at beat time.
          this.triageDecided = true
        } else if (info.kind === 'self' && this.file.awaitingSelfRest) {
          this.file.awaitingSelfRest = false
          const now = this.ctx.anima.clock.now()
          this.schedule(nextHeartbeat(this.scheduleInput(now, undefined)).at)
        }
        break
      }
    }
  }

  /**
   * A conversation turn is about to stop (DSH `agent/turn-stopping`). If no
   * closing action followed the arrival that opened it, steer a reminder into
   * the same turn; after `conversation.closeReminders` of them, let it end and
   * record a lost reply (DESIGN §6). Nothing she wrote is ever forwarded.
   */
  private onStopping(agent: Agent): void {
    const info = this.router.describe(agent.id)
    if (info?.kind !== 'conversation') return
    const action = this.closer.onStopping(agent.id)
    if (action === undefined) return
    const core = this.ctx.anima
    if (action.kind === 'remind') {
      core.recordActivity({ type: 'reminder', channel: info.channelKey, sessionId: agent.id, text: action.text, count: action.count })
      const text = reminderText(`${info.channel.platform}_say`, action.text, action.count, this.config.conversation.closeReminders)
      if (this.host.steer === undefined) return
      this.host.steer(agent, this.router.stamped(text), `Close reminder ${action.count}`, 'close-reminder')
      return
    }
    core.recordActivity({ type: 'lost-reply', channel: info.channelKey, sessionId: agent.id, text: action.text })
    this.ctx.logger.warn(`anima: lost reply in ${this.router.channel(info.channelKey)?.display ?? info.channelKey}: the turn ended without a say or end_turn${action.text === '' ? '' : ` (text: ${JSON.stringify(action.text.slice(0, 80))})`}`)
  }

  /** One report line per channel: the latest time her conversation there responded. */
  private noteResponded(key: string, behavior: string): void {
    const display = this.router.channel(key)?.display ?? key
    const prefix = `You responded in ${display} at `
    this.file.events = this.file.events.filter(line => !line.startsWith(prefix))
    this.file.events.push(`${prefix}${formatLocal(this.ctx.anima.clock.now())} (${behavior}); that conversation already handled what came in there.`)
  }

  // ---- behaviors ----

  private registerBehaviors(): void {
    const core = this.ctx.anima

    core.registerBehavior(defineTool({
      name: 'rest',
      description: 'Rest until your next heartbeat and end this turn. Give `until` as local "HH:mm" or "YYYY-MM-DD HH:mm" for when you want to be woken; the owner\'s limits may adjust it.',
      parameters: {
        until: { type: 'string', description: 'When to wake you next, local "HH:mm" or "YYYY-MM-DD HH:mm". Omit for the default interval.' },
        note: { type: 'string', description: 'Optional note to yourself about why.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            next: { type: 'string', required: true, description: 'Next heartbeat, local time.' },
            adjusted: { type: 'string', description: 'How your request was adjusted, if it was.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Resting. Next heartbeat ${value.next}${value.adjusted === undefined ? '' : ` (${value.adjusted})`}.` }],
      },
      execute: async (args, exec) => {
        const now = core.clock.now()
        let requested: number | undefined
        if (args.until !== undefined && args.until.trim() !== '') {
          requested = parseWhen(args.until, now)
          if (requested === undefined) throw new AnimaError('anima/bad-time', `"${args.until}" is not a time like 21:00 or 2026-11-10 21:00.`)
        }
        const next = nextHeartbeat(this.scheduleInput(now, requested))
        const kind = exec.agent === undefined ? undefined : core.describeSession(exec.agent.id)?.kind
        if (kind === 'triage') this.triageDecided = true
        if (kind === 'self') this.file.awaitingSelfRest = false
        this.file.counts.rests += 1
        this.schedule(next.at)
        exec.concludeTurn()
        return { next: formatLocal(next.at), ...next.adjusted === undefined ? {} : { adjusted: next.adjusted } }
      },
    }), { effect: 'internal', sessions: ['triage', 'self'], closes: true })

    core.registerBehavior(defineTool({
      name: 'heartbeat_act',
      description: 'Get up and act now: wakes your Self session with full context and tools. Say what you want to do.',
      parameters: {
        reason: { type: 'string', required: true, description: 'What you want to do, in a sentence.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { woke: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'Your Self session is waking up.' }],
      },
      execute: async (args, exec) => {
        this.triageDecided = true
        exec.concludeTurn()
        this.escalate(args.reason).catch((error: unknown) => this.ctx.logger.warn(`anima: could not wake the Self session: ${String(error)}`))
        return { woke: true }
      },
    }), { effect: 'internal', sessions: ['triage'], modes: ['day'] })

    core.registerBehavior(defineTool({
      name: 'open_conversation',
      description: 'Start (or resume) a conversation with someone. The conversation session with them writes the actual words and may still decide to stay silent; the outcome comes back to you as a notice.',
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel key from your report, e.g. "local:owner:private:owner".' },
        intent: { type: 'string', required: true, description: 'What you want from this conversation and why, in a sentence or two.' },
        context: { type: 'string', description: 'Optional context the conversation should know.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true, description: 'Whether the intent reached the conversation.' },
            intentId: { type: 'string', required: true, description: 'Id to recognize the outcome notice.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Intent ${value.intentId} handed to the conversation. Its outcome will arrive here as a notice.` }],
      },
      execute: async args => {
        const { intentId } = await this.openIntent(args.channel, args.intent, args.context)
        return { delivered: true, intentId }
      },
    }), { effect: 'initiate', sessions: ['self'], target: args => typeof args.channel === 'string' ? args.channel : undefined })

    const batchOf = (id: string) => {
      const batch = this.triage.batch(id)
      if (batch === undefined) throw new AnimaError('anima/unknown-batch', `no batch "${id}".`)
      if (batch.decision !== undefined) throw new AnimaError('anima/batch-settled', `batch ${batch.id} was already settled (${batch.decision}).`)
      return batch
    }
    const settled = {
      schema: { type: 'object' as const, additionalProperties: false as const, properties: { decision: { type: 'string' as const, required: true as const, description: 'wake, remember or ignore.' } } },
      render: (_args: unknown, value: { decision: string }) => [{ type: 'text' as const, text: `Batch settled: ${value.decision}.` }],
    }

    core.registerBehavior(defineTool({
      name: 'group_wake',
      description: 'Join this group conversation now: the batch is handed to your conversation session for that group, which decides what (if anything) to say. Ends this turn.',
      parameters: {
        batch: { type: 'string', required: true, description: 'Batch id, e.g. "b12".' },
        reason: { type: 'string', required: true, description: 'Why you want to take part, in a sentence.' },
      },
      output: settled,
      execute: async (args, exec) => {
        const batch = batchOf(args.batch)
        exec.concludeTurn()
        this.triage.decide(batch.id, 'wake', 'her', args.reason)
        return { decision: 'wake' }
      },
    // Not `closes`: a wake has an effect (it wakes the group), so its quota must apply (DESIGN §5).
    }), { effect: 'internal', sessions: ['group-triage'], target: args => typeof args.batch === 'string' ? this.triage.batch(args.batch)?.channelKey : undefined })

    core.registerBehavior(defineTool({
      name: 'group_pass',
      description: 'Let this batch go without joining. With remember: true its messages are kept in your memory of that group; with false they are dropped. Ends this turn.',
      parameters: {
        batch: { type: 'string', required: true, description: 'Batch id, e.g. "b12".' },
        remember: { type: 'boolean', required: true, description: 'Keep these messages in your memory of the group.' },
        reason: { type: 'string', description: 'Optional short reason.' },
      },
      output: settled,
      execute: async (args, exec) => {
        const batch = batchOf(args.batch)
        exec.concludeTurn()
        const decision = args.remember ? 'remember' : 'ignore'
        this.triage.decide(batch.id, decision)
        return { decision }
      },
    }), { effect: 'internal', sessions: ['group-triage'], closes: true })

    core.registerBehavior(defineTool({
      name: 'viewing_note',
      description: 'Finish this viewing with your note: what you saw, what stood out, what you think. The note is all you keep from it. Ends the viewing.',
      parameters: {
        note: { type: 'string', required: true, description: 'Your viewing note, in your own voice.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { kept: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'Note kept.' }],
      },
      execute: async (args, exec) => {
        const waiter = exec.agent === undefined ? undefined : this.views.get(exec.agent.id)
        if (waiter === undefined) throw new AnimaError('anima/no-view', 'no viewing is running in this session.')
        if (args.note.trim() === '') throw new AnimaError('anima/empty-note', 'the note is empty.')
        waiter.resolve(args.note.trim())
        exec.concludeTurn()
        return { kept: true }
      },
    }), { effect: 'internal', sessions: ['viewing'], closes: true })

    core.registerBehavior(defineTool({
      name: 'end_turn',
      description: 'End this turn without (further) speech: after a poke or reaction alone, when you choose not to answer, or to decline an intent from your Self. Give a short reason; if this turn came from your own intent, your Self learns it was declined.',
      parameters: {
        reason: { type: 'string', description: 'Why, in a few words.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ended: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'Turn ended.' }],
      },
      execute: async () => ({ ended: true }),
    }), { effect: 'internal', sessions: ['conversation'], closes: true })

    // The inbox (DESIGN §5, Phase 9): what waited while she slept or was paused.
    core.registerBehavior(defineTool({
      name: 'inbox_read',
      description: 'Read the messages that arrived while you were asleep or paused, per chat, with the times they were sent. They stay in the inbox until you answer them with inbox_answer or that chat writes again.',
      parameters: {
        channel: { type: 'string', description: 'Optional channel key, to read one chat only.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true, description: 'One line per chat, then one per message.' } } },
        render: (_args, value) => [{ type: 'text', text: value.lines.length === 0 ? '收件箱是空的。' : value.lines.join('\n') }],
      },
      execute: async (args) => {
        const entries = this.inbox.entries().filter(entry => args.channel === undefined || args.channel === '' || entry.key === args.channel)
        const lines = entries.flatMap(({ key, channel, messages }) => [
          `${channel.display} — channel "${key}"，${messages.length} 条：`,
          ...messages.map(m => `  ${formatLocal(m.ts)} ${m.sender.displayName}${m.sender.isOwner ? '（主人）' : ''}${m.messageId === undefined ? '' : ` [msg ${m.messageId}]`}${m.addressed === true ? ' 叫你' : ''}: ${m.text}`),
        ])
        return { lines }
      },
    }), { effect: 'observe', sessions: ['self'] })

    core.registerBehavior(defineTool({
      name: 'inbox_answer',
      description: 'Hand one chat\'s held messages to that chat, so you answer them there: they arrive as one burst marked as received while you slept, and that conversation decides what to say. It is a reply, not a new conversation. Messages you do not hand over stay unanswered.',
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel key of the chat, as shown in your inbox.' },
        note: { type: 'string', description: 'Optional note from your inner life to that conversation (what you want to keep in mind).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { handed: { type: 'integer', required: true, description: 'How many messages went to that chat.' } } },
        render: (_args, value) => [{ type: 'text', text: `${value.handed} 条消息交给了那个聊天。` }],
      },
      execute: async (args) => {
        const key = args.channel
        const channel = this.router.channel(key)
        if (channel === undefined) throw new AnimaError('anima/unknown-channel', `没有「${key}」这个地方。`)
        const heldWhy = this.inbox.why(key)
        const held = this.inbox.take(key)
        if (held.length === 0) throw new AnimaError('anima/inbox-empty', `收件箱里没有 ${channel.display} 的消息（可能那个聊天已经又找过你了）。`)
        this.ctx.anima.recordActivity({ type: 'inbox-release', channel: key, reason: 'answer', count: held.length, ...args.note === undefined ? {} : { note: args.note } })
        await this.deliverOne({ type: 'burst', channel, messages: held, held: held.length, heldWhy, note: args.note, ts: held.at(-1)!.ts }, {}, true)
        return { handed: held.length }
      },
    }), { effect: 'express', sessions: ['self'], target: args => typeof args.channel === 'string' ? args.channel : undefined })
  }

  private statusPart(): Record<string, unknown> {
    const { counts, nextHeartbeatAt, lastHeartbeatAt, intents } = this.file
    const core = this.ctx.anima
    return {
      nextHeartbeatAt: nextHeartbeatAt ?? null,
      nextHeartbeat: nextHeartbeatAt === undefined ? null : formatLocal(nextHeartbeatAt),
      lastHeartbeat: lastHeartbeatAt === undefined ? null : formatLocal(lastHeartbeatAt),
      selfActing: this.file.awaitingSelfRest,
      counts,
      intents: [...intents.pending, ...intents.active].map(i => ({ id: i.id, display: i.display })),
      inbox: this.inbox.entries().map(({ key, channel, messages }) => ({ key, display: channel.display, count: messages.length, first: messages[0]!.ts, last: messages.at(-1)!.ts })),
      groupsToday: this.file.groups[core.dayKey()] ?? {},
      sessions: {
        self: this.router.selfId,
        triage: this.router.triageId(core.dayKey()),
        conversations: this.router.known().map(({ sessionId, channel }) => ({ sessionId, display: channel.display, channelKey: channelKey(channel) })),
      },
    }
  }

  private statusLines(): string[] {
    const { counts, nextHeartbeatAt, intents } = this.file
    const core = this.ctx.anima
    return [
      `Next heartbeat: ${nextHeartbeatAt === undefined ? 'not scheduled' : formatLocal(nextHeartbeatAt)}${this.file.awaitingSelfRest ? ' (Self is acting)' : ''}`,
      `Heartbeats ${counts.heartbeats}, acted ${counts.acts}, rests ${counts.rests}, intents ${counts.intents}`,
      `Pending intents: ${[...intents.pending, ...intents.active].map(i => `${i.id} → ${i.display}`).join(', ') || 'none'}`,
      `Inbox: ${this.inbox.entries().map(({ channel, messages }) => `${channel.display} ${messages.length} (last ${formatLocal(messages.at(-1)!.ts)})`).join(', ') || 'empty'}`,
      `Settle window: ${this.config.conversation.settleSeconds} s quiet, at most ${this.config.conversation.settleMaxSeconds} s; waiting: ${[...this.settling].map(([key, e]) => `${key} (${e.messages.length}${e.typing > 0 ? `, typing ${e.typing}` : ''})`).join(', ') || 'none'}`,
      `Group triage: window ${this.config.groupTriage.windowSeconds} s, attention ${this.config.groupTriage.attentionSeconds} s (in it: ${[...this.attention].filter(([, until]) => until > Date.now()).map(([key]) => key).join(', ') || 'none'}); open buffers ${this.triage.open().map(b => `${b.channelKey} (${b.messages})`).join(', ') || 'none'}; undecided batches ${this.triage.undecided().map(b => b.id).join(', ') || 'none'}`,
      ...Object.entries(this.file.groups[core.dayKey()] ?? {}).map(([key, g]) => `  ${key} today: wakes ${g.direct} direct + ${g.triage} triage${g.attention === undefined ? '' : ` + ${g.attention} attention`}; batches ${g.batches} (remember ${g.remember}, ignore ${g.ignore}, fallback ${g.fallback})`),
      `Self session: ${this.router.selfId}`,
      `Triage session today: ${this.router.triageId(core.dayKey())}`,
      ...this.router.known().map(({ sessionId, channel }) => `Conversation ${channel.display}: ${sessionId}`),
    ]
  }
}

function nextWakeOf(core: Context['anima'], now: number): number {
  return nextWake(now, core.config.day)
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Reminder prompts of a DSH schedule delivery: a single reminder carries
 * `reminder_prompt_json: "…"`, a batch carries `reminders_json: [{ reminder_prompt }]`.
 * @param text - delivered message text.
 */
export function alarmPrompts(text: string): string[] {
  const single = /reminder_prompt_json: (.*)/.exec(text)?.[1]
  const batch = /reminders_json: (.*)/.exec(text)?.[1]
  try {
    if (single !== undefined) {
      const value: unknown = JSON.parse(single)
      return typeof value === 'string' ? [value] : []
    }
    if (batch !== undefined) {
      const value: unknown = JSON.parse(batch)
      return Array.isArray(value) ? value.map(item => (item as { reminder_prompt?: unknown }).reminder_prompt).filter((p): p is string => typeof p === 'string') : []
    }
  } catch {
    return []
  }
  return []
}
