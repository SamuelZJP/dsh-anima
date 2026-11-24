/**
 * The `animaLife` service (docs/design/life.md): her waking sessions, the
 * stimuli that reach them, `wait`, groups, the inbox, her heartbeat, and what
 * happens to her sessions when she falls asleep and wakes. Physiology and
 * plumbing; she decides everything she does.
 * @module @anima/life/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, channelKey, type ChannelRef, describeGoal, formatLocal, formatStamp, readJson, writeJson, type AdmitRefusal, type BehaviorEvent, type SessionInfo } from '@anima/core'
import type {} from '@anima/core'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { resolveLifeConfig, type Config as LifeConfig } from './config.ts'
import { GroupBuffers } from './groups.ts'
import { nextBeat } from './heartbeat.ts'
import { consolidationSessionId } from './identity.ts'
import { Inbox, inboxSummary } from './inbox.ts'
import { buildReport, formatSpan, type ChannelLine } from './report.ts'
import { senderLabel, stimulusRef, stimulusSummary, stimulusText, wakes, whereOf, type ExtraBlock, type MessageStimulus, type PublishedChannel, type Stimulus } from './stimulus.ts'
import { CONSOLIDATION_PRESET, WakingSessions, type ArchiveResult, type ModelChoice, type SessionHost, type WakingState } from './waking.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaLife: AnimaLife
  }
  interface Events {
    /** A stimulus reached one of her sessions, or was kept for her. `anima-memory` records channel messages from it. */
    'anima/stimulus'(payload: StimulusEvent): void
    /** She read a chat (it reached her, or she read a group): its adapter may mark it read. */
    'anima/read'(payload: { readonly channel: ChannelRef }): void
  }
}

/** Payload of the `anima/stimulus` event. */
export interface StimulusEvent {
  readonly stimulus: Stimulus
  /** The session it went to (for `record`, her current waking session). */
  readonly sessionId: string
  /**
   * `wake`: it started (or joined) a turn; `context`: it joined her context
   * without starting one (a glanced group line, a channel event); `record`:
   * kept only in her transcript (a message held in her inbox while she slept).
   */
  readonly delivery: 'wake' | 'context' | 'record'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A stimulus Anima delivered into one of her sessions. */
    'anima-stimulus': { kind: 'anima-stimulus'; stimulus: string; ref?: string; wake?: true } & ContextFormed
  }
}

/** A chat's messages waiting to settle into one burst. */
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

/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_MS = 2_147_483_647
const MIN = 60_000
/** Real time a heartbeat delivery may take before the beat gives up (the next beat is already set). */
const DELIVERY_TIMEOUT_MS = 120_000
/** Lines `group_read` returns by default. */
const READ_LINES = 20

/** Reject when a promise does not settle in time, so a stuck delivery cannot stall her heart. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AnimaError('anima/delivery-timeout', `${what} did not finish within ${ms / 1000} s; check the DSH log for a preset or plugin that failed to load.`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** The part of DSH's schedule service used to move alarms. */
interface ScheduleMover {
  list(request: { active?: boolean; limit?: number }): Promise<{ items: readonly { id: string; target?: { kind: string; sessionId?: string } }[] }>
  edit(request: { id: string; action: 'update'; patch: { target: { kind: 'session'; sessionId: string } } }): Promise<unknown>
}

/** {@link SessionHost} over DSH's session controller, title, workspace and schedule services. */
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

  async archive(sessionId: string): Promise<ArchiveResult> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new AnimaError('anima/no-workspace-registry', 'DSH has no workspace registry, so her ended waking sessions cannot be archived.')
    try {
      await registry.archiveSession(sessionId as SessionId)
      return 'archived'
    } catch (error: unknown) {
      // DSH refuses while a turn runs or an alarm targets the session (docs/dsh.md).
      if ((error as { activity?: unknown } | undefined)?.activity !== undefined || (error as Error | undefined)?.name === 'WorkspaceActiveSessionError') return 'busy'
      throw error
    }
  }

  async moveAlarms(from: string, to: string): Promise<number> {
    const schedule = this.ctx.get('schedule' as never) as ScheduleMover | undefined
    if (schedule === undefined) return 0
    const { items } = await schedule.list({ active: true, limit: 500 })
    const mine = items.filter(item => item.target?.kind === 'session' && item.target.sessionId === from)
    for (const item of mine) await schedule.edit({ id: item.id, action: 'update', patch: { target: { kind: 'session', sessionId: to } } })
    return mine.length
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
    // Idle, a steer starts a turn; during a turn it joins as the next step (docs/dsh.md).
    agent.steer(this.message(text, summary, stimulus, ref, extra, true))
    await this.flush(agent)
  }

  async inject(agent: Agent, text: string, summary: string, stimulus: string): Promise<void> {
    agent.inject(this.message(text, summary, stimulus))
    await this.flush(agent)
  }

  selectModel(agent: Agent, choice: ModelChoice): void {
    agent.model.select({ provider: choice.provider, model: choice.model })
  }
}

/** The part of DSH's subagent service a close view uses (docs/dsh.md). */
interface Subagents {
  startActivation(spec: {
    provider: string
    label: string
    delivery: 'caller'
    signal: AbortSignal
    request: { parent: Agent; signal: AbortSignal; agentPreset: string; agentOptions?: { provider: string; model: string }; prompt: unknown[] }
  }): Promise<{ result: Promise<{ output: readonly { type: string; text?: string }[]; stopReason: string; diagnostic?: string }>; dispose(): Promise<void> }>
}

/** Preset of a close view's perception (a subagent of her waking session). */
export const VIEWING_PRESET = 'anima-viewing'

/** A close look, run as a subagent of her waking session (docs/design/channels.md). */
export interface ViewRequest {
  /** Her waking session's agent, the subagent's parent. */
  readonly parent: Agent
  /** Title of the viewing. */
  readonly title: string
  /** What she is looking at and why. */
  readonly text: string
  /** Frames with captions, in time order. */
  readonly parts: readonly ExtraBlock[]
  /** Vision-capable model of the viewing. */
  readonly model?: ModelChoice
  /** Real seconds the viewing may take. */
  readonly timeoutSeconds: number
  readonly signal?: AbortSignal
}

/** Her last sleep, for the waking context. */
interface LastSleep {
  readonly since: number
  readonly by: string
  readonly note?: string | undefined
}

/** Durable life state, `<dataDir>/life.json`. */
interface LifeFile {
  waking: WakingState
  nextHeartbeatAt?: number
  lastHeartbeatAt?: number
  /** Things that happened since her last heartbeat (or while she slept), as lines. */
  events: string[]
  /** When someone there last wrote to her, per channel key (a message that reaches her or waits in her inbox). */
  lastHeard: Record<string, number>
  /** When she last spoke there, per channel key. */
  lastSpoke: Record<string, number>
  lastSleep?: LastSleep
  counts: { heartbeats: number; wakings: number; sleeps: number }
}

/** Health of one platform, as its adapter reported it. */
interface PlatformHealth {
  online: boolean
  /** When it last changed, on her clock. */
  since: number
  reason?: string | undefined
  /** She was told it went offline. */
  notified: boolean
  timer?: ReturnType<typeof setTimeout> | undefined
}

function emptyFile(): LifeFile {
  return { waking: { pending: [], past: [] }, events: [], lastHeard: {}, lastSpoke: {}, counts: { heartbeats: 0, wakings: 0, sleeps: 0 } }
}

/** Anima life service. */
export class AnimaLife extends Service {
  static inject = ['anima']

  /** Life config. */
  readonly config: Readonly<LifeConfig>
  /** Her waking sessions. */
  readonly waking: WakingSessions<Agent>
  /** Her inbox: chat messages held while she slept or was paused. */
  readonly inbox: Inbox
  /** Unaddressed group messages, per group, until she looks. */
  readonly groups: GroupBuffers
  private readonly host: SessionHost<Agent>
  private readonly path: string
  private readonly file: LifeFile
  private timer: ReturnType<typeof setTimeout> | undefined
  private beating = false
  private disposed = false
  private readonly reportLines = new Set<() => string[]>()
  private readonly budgetLines = new Set<() => string[]>()
  /** Channels adapters published, by key. */
  private readonly channels = new Map<string, PublishedChannel[]>()
  /** Consolidation session ids, by id → her day. */
  private readonly consolidations = new Map<string, string>()
  /** Sessions running a turn now. */
  private readonly running = new Set<string>()
  /** `wait` calls waiting for something to arrive. */
  private readonly waiters = new Set<() => void>()
  private readonly platforms = new Map<string, PlatformHealth>()
  /** Chat messages waiting for their chat to settle, by channel key. */
  private readonly settling = new Map<string, SettleEntry>()
  /** Groups in their attention window after she spoke: channel key → real time it ends. */
  private readonly attention = new Map<string, number>()

  /**
   * @param ctx - root context.
   * @param options - a session host (tests), or `{ host?, config? }`.
   */
  constructor(ctx: Context, options?: SessionHost<Agent> | LifeOptions) {
    super(ctx, 'animaLife')
    const core = ctx.anima
    const { characterId, dataDir } = core.config
    const opts: LifeOptions = options !== undefined && 'resolve' in options ? { host: options } : options ?? {}
    this.config = resolveLifeConfig(opts.config)
    this.host = opts.host ?? new DshSessionHost(ctx)
    this.path = join(dataDir, 'life.json')
    this.inbox = new Inbox(join(dataDir, 'inbox.json'))
    this.groups = new GroupBuffers(this.config.groups.bufferMessages)
    const saved = readJson<Partial<LifeFile>>(this.path) ?? {}
    this.file = { ...emptyFile(), ...saved, waking: { pending: [], past: [], ...saved.waking } }
    this.waking = new WakingSessions(this.host, this.file.waking, {
      characterId, dataDir, model: this.config.waking.model,
      title: at => `Anima · ${formatLocal(at).slice(5)}`,
      save: () => this.save(),
      warn: message => ctx.logger.warn(message),
    })

    ctx.effect(() => () => {
      for (const health of this.platforms.values()) clearTimeout(health.timer)
      for (const entry of this.settling.values()) clearTimeout(entry.timer)
      this.settling.clear()
      for (const resolve of this.waiters) resolve()
    }, 'animaLife.timers')

    core.provideSessions(id => this.describe(id))
    core.provideChannels(key => {
      const channel = this.channel(key)
      return channel === undefined ? undefined : { isOwner: channel.isOwner === true, display: channel.display, note: channel.note }
    }, () => [...this.channels.keys()])
    // A turn in any of her waking sessions (the one that just ended included) keeps sleep that overwhelms her waiting.
    core.provideBusy(() => [...this.running].some(id => this.waking.describe(id) !== undefined))
    core.addStatus(() => this.statusLines())
    core.addStatusPart('life', () => this.statusPart())

    this.registerBehaviors()

    ctx.on('anima/sleep', payload => { void this.onSleep(payload.at).catch((error: unknown) => ctx.logger.warn(`anima: falling asleep: ${errorText(error)}`)) })
    ctx.on('anima/wake', ({ by }) => {
      // An alarm starts its own turn; the waking context joins it at its first step.
      if (by === 'alarm') return
      void this.openWaking(by).catch((error: unknown) => ctx.logger.warn(`anima: waking: ${errorText(error)}`))
    })
    ctx.on('anima/paused', (paused) => {
      if (paused || this.inbox.size() === 0 || core.asleep()) return
      void this.deliverOne({ type: 'notice', wake: true, text: `主人让你继续了。${inboxSummary(this.inbox.entries()) ?? ''}`, ts: core.clock.now() })
        .catch((error: unknown) => ctx.logger.warn(`anima: after a pause: ${errorText(error)}`))
    })
    ctx.on('anima/behavior', event => this.onBehavior(event))
    ctx.on('session/event', (session, event) => this.onSessionEvent(session.id, event))
    ctx.on('agent/pre-step', (payload, next) => this.preStep(payload as never, next as never))

    ctx.effect(() => {
      this.disposed = false
      if (this.file.nextHeartbeatAt === undefined) this.schedule(core.clock.now() + MIN)
      else this.arm()
      // Her first waking in this data directory, or a waking whose first arrival never went out.
      if (!core.asleep() && !this.waking.opened) {
        void this.openWaking(this.waking.current === undefined ? 'start' : core.sleepInfo().by)
          .catch((error: unknown) => ctx.logger.warn(`anima: opening her waking session: ${errorText(error)}`))
      }
      return () => {
        this.disposed = true
        clearTimeout(this.timer)
      }
    }, 'animaLife.heartbeat')
  }

  // ---- sessions and channels ----

  /**
   * Describe a session id: one of her waking sessions, or a consolidation
   * session of her sleep. Every other session is plain DSH.
   */
  describe(sessionId: string): SessionInfo | undefined {
    return this.waking.describe(sessionId) ?? (this.consolidations.has(sessionId) ? { kind: 'consolidation' } : undefined)
  }

  /** The consolidation session id of one of her days, known to {@link describe}. */
  consolidationId(day: string): string {
    const id = consolidationSessionId(this.ctx.anima.config.characterId, day)
    this.consolidations.set(id, day)
    return id
  }

  /**
   * Publish an adapter's channels, owned by the calling plugin.
   * @param channels - places she can talk in.
   */
  publish(channels: readonly PublishedChannel[]): () => void {
    return this.ctx.effect(() => {
      const forget = channels.map(channel => this.know(channel))
      return () => { for (const off of forget) off() }
    }, 'animaLife.publish()')
  }

  private know(channel: PublishedChannel): () => void {
    const key = channelKey(channel)
    const list = this.channels.get(key) ?? []
    list.push(channel)
    this.channels.set(key, list)
    return () => {
      const now = (this.channels.get(key) ?? []).filter(entry => entry !== channel)
      if (now.length === 0) this.channels.delete(key)
      else this.channels.set(key, now)
    }
  }

  /** A known channel by key. */
  channel(key: string): PublishedChannel | undefined {
    return this.channels.get(key)?.at(-1)
  }

  /** Every known channel. */
  known(): PublishedChannel[] {
    return [...this.channels.values()].map(list => list.at(-1)!)
  }

  /** When someone in a channel last wrote to her (a message that reached her or waits in her inbox), on her clock. */
  lastHeard(key: string): number | undefined {
    return this.file.lastHeard[key]
  }

  /** When she last spoke in a channel, on her clock. */
  lastSpoke(key: string): number | undefined {
    return this.file.lastSpoke[key]
  }

  /**
   * Add lines to every heartbeat's state, owned by the calling plugin. Lines
   * state facts; they never suggest what to do.
   */
  addReportLine(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.reportLines.add(provider)
      return () => { this.reportLines.delete(provider) }
    }, 'animaLife.addReportLine()')
  }

  /** Add budget lines (what is left of what the outside allows) to every heartbeat, owned by the calling plugin. Facts only. */
  addBudgetLine(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.budgetLines.add(provider)
      return () => { this.budgetLines.delete(provider) }
    }, 'animaLife.addBudgetLine()')
  }

  // ---- stimuli ----

  /**
   * Deliver one stimulus from the world. A group message that does not address
   * her waits in its group's unread buffer, unless the group is in its
   * attention window after she spoke there. A chat message waits for its chat to
   * settle (`conversation.settleSeconds`), so a burst is one arrival. While she
   * sleeps or is held from outside (a pause), chat messages that would reach her
   * wait in her inbox. A consolidation goes to sleep's consolidation session.
   * @returns the session it went to, or would go to.
   */
  async deliver(stimulus: Stimulus, options: { model?: ModelChoice } = {}): Promise<string> {
    const here = this.waking.current ?? ''
    if (stimulus.type === 'consolidate') return this.consolidate(stimulus, options.model)
    if (stimulus.type === 'message' || stimulus.type === 'channel-event') {
      const key = channelKey(stimulus.channel)
      // The outside may keep a chat away from her altogether (the allowlist): it never reaches her.
      if (this.ctx.anima.admit({ kind: 'reach', channelKey: key })?.drop === true) return here
      if (stimulus.type === 'channel-event') {
        if (this.unreachable()) return here
        return this.deliverOne(stimulus)
      }
      if (this.channel(key) === undefined) this.know(stimulus.channel)
      if (stimulus.channel.kind === 'group' && !wakes(stimulus)) {
        if (this.attentive(key) && !this.unreachable()) return this.settleLater(stimulus, true)
        this.groups.add(stimulus)
        return here
      }
      if (this.unreachable()) return this.hold(stimulus)
      if (this.config.conversation.settleSeconds > 0) return this.settleLater(stimulus, false)
      return this.deliverBurst(key, [stimulus], false)
    }
    if (stimulus.type === 'notice' && this.unreachable()) {
      this.note(stimulus.text)
      return here
    }
    return this.deliverOne(stimulus)
  }

  /** Whether she cannot be reached now: asleep, or held from outside (a pause). */
  private unreachable(): boolean {
    return this.ctx.anima.asleep() || this.heldBy() !== undefined
  }

  /** Why the outside holds her now, if it does (`anima/admit` reach). */
  private heldBy(): AdmitRefusal | undefined {
    return this.ctx.anima.admit({ kind: 'reach' })
  }

  /** Hold a chat message in her inbox; its platform does not mark it read. */
  private hold(stimulus: MessageStimulus): string {
    const core = this.ctx.anima
    const reason: 'asleep' | 'paused' = core.asleep() || this.heldBy() === undefined ? 'asleep' : 'paused'
    const key = channelKey(stimulus.channel)
    this.inbox.hold(stimulus, reason)
    this.file.lastHeard[key] = Math.max(this.file.lastHeard[key] ?? 0, stimulus.ts)
    this.save()
    core.recordActivity({ type: 'inbox-held', channel: key, reason })
    const sessionId = this.waking.current ?? ''
    this.ctx.emit('anima/stimulus', { stimulus, sessionId, delivery: 'record' })
    return sessionId
  }

  /**
   * The other person is typing in a chat (where the platform reports it): a
   * burst waiting there keeps waiting, within `settleMaxSeconds`.
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

  private attentive(key: string): boolean {
    return (this.attention.get(key) ?? 0) > Date.now()
  }

  private settleLater(stimulus: MessageStimulus, attention: boolean): string {
    const key = channelKey(stimulus.channel)
    const entry = this.settling.get(key) ?? { messages: [], timer: undefined, attention, first: Date.now(), typing: 0 }
    entry.messages.push(stimulus)
    this.settling.set(key, entry)
    this.armSettle(key, entry)
    return this.waking.current ?? ''
  }

  private armSettle(key: string, entry: SettleEntry): void {
    clearTimeout(entry.timer)
    const { settleSeconds, settleMaxSeconds } = this.config.conversation
    const quiet = settleSeconds * 1000
    const cap = entry.first + Math.max(settleMaxSeconds, settleSeconds) * 1000 - Date.now()
    entry.timer = setTimeout(() => this.flushSettled(key), Math.max(0, Math.min(quiet, cap)))
  }

  private takeSettling(key: string): MessageStimulus[] {
    const entry = this.settling.get(key)
    if (entry === undefined) return []
    clearTimeout(entry.timer)
    this.settling.delete(key)
    return entry.messages
  }

  /**
   * A chat settled: its messages reach her as one burst. A burst of only
   * unaddressed attention-window lines first asks the outside (`group_attention`);
   * refused, they go to the group's buffer. If she fell asleep (or was paused)
   * meanwhile, messages that would reach her go to her inbox.
   */
  private flushSettled(key: string): void {
    const messages = this.takeSettling(key)
    if (messages.length === 0) return
    const waking = messages.some(message => wakes(message))
    if (this.unreachable()) {
      for (const message of messages) {
        if (wakes(message)) this.hold(message)
        else this.groups.add(message)
      }
      return
    }
    if (!waking && this.ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: key }) !== undefined) {
      for (const message of messages) this.groups.add(message)
      return
    }
    void this.deliverBurst(key, messages, !waking)
      .catch((error: unknown) => this.ctx.logger.warn(`anima: could not deliver ${messages[0]!.channel.display}: ${errorText(error)}`))
  }

  /**
   * Deliver settled messages as one arrival: an addressed group burst takes the
   * group's unseen lines before it, and the chat's held inbox messages go first,
   * marked with their times. A lone message keeps the single-message format.
   */
  private async deliverBurst(key: string, settled: readonly MessageStimulus[], attention: boolean): Promise<string> {
    const channel = settled[0]!.channel
    const heldWhy = this.inbox.why(key)
    const held = this.inbox.take(key)
    if (held.length > 0) this.ctx.anima.recordActivity({ type: 'inbox-release', channel: key, reason: 'wrote', count: held.length })
    const buffered = channel.kind === 'group' ? this.groups.takeUnseen(key) : []
    const messages = [...held, ...[...buffered, ...settled].sort((a, b) => a.ts - b.ts)]
    if (messages.length === 1) {
      const only = messages[0]!
      return this.deliverOne(attention ? { ...only, via: { kind: 'attention' } } : only)
    }
    return this.deliverOne({
      type: 'burst', channel, messages,
      ...held.length > 0 ? { held: held.length, heldWhy } : {},
      ...attention ? { via: { kind: 'attention' as const } } : {},
      ts: messages.at(-1)!.ts,
    })
  }

  /**
   * Deliver one stimulus into her current waking session: one that starts a
   * turn (or joins the running one), or context for her next turn. Every
   * delivered arrival starts with the time on her clock.
   */
  private async deliverOne(stimulus: Stimulus): Promise<string> {
    const core = this.ctx.anima
    const now = core.clock.now()
    const wake = wakes(stimulus)
    const agent = await this.waking.ensureCurrent(now)
    let text = `[${formatStamp(now)}] ${stimulusText(stimulus)}`
    // A waking whose first arrival never went out (a restart) begins with the waking context.
    if (!this.waking.opened && stimulus.type !== 'waking') text = `[${formatStamp(now)}] ${stimulusText({ type: 'waking', text: this.wakingText('restart', now), ts: now })}\n\n${text}`
    if (stimulus.type === 'message' || stimulus.type === 'burst') {
      const key = channelKey(stimulus.channel)
      const last = (stimulus.type === 'burst' ? stimulus.messages : [stimulus]).at(-1)!
      this.file.lastHeard[key] = Math.max(this.file.lastHeard[key] ?? 0, last.ts)
      this.save()
    }
    if (wake) await this.host.deliver(agent, text, stimulusSummary(stimulus), stimulus.type, stimulusRef(stimulus))
    else await this.host.inject(agent, text, stimulusSummary(stimulus), stimulus.type)
    this.waking.markOpened(agent, now)
    if (wake) {
      for (const resolve of [...this.waiters]) resolve()
      core.recordActivity({
        type: 'wake', stimulus: stimulus.type, session: 'waking', sessionId: agent.id,
        ...'channel' in stimulus ? { channel: channelKey(stimulus.channel) } : {},
      })
    }
    if (stimulus.type === 'burst') {
      // The transcript records each message on its own; held ones were recorded when they arrived.
      for (const [index, message] of stimulus.messages.entries()) {
        if (index < (stimulus.held ?? 0)) continue
        this.ctx.emit('anima/stimulus', { stimulus: message, sessionId: agent.id, delivery: wake && index === stimulus.messages.length - 1 ? 'wake' : 'context' })
      }
    } else {
      this.ctx.emit('anima/stimulus', { stimulus, sessionId: agent.id, delivery: wake ? 'wake' : 'context' })
    }
    // A chat that reached her is read, like a person opening it.
    if (wake && (stimulus.type === 'message' || stimulus.type === 'burst')) this.ctx.emit('anima/read', { channel: stimulus.channel })
    return agent.id
  }

  /** Deliver a consolidation to sleep's consolidation session of the day. */
  private async consolidate(stimulus: Extract<Stimulus, { type: 'consolidate' }>, model: ModelChoice | undefined): Promise<string> {
    const sessionId = this.consolidationId(stimulus.day)
    let agent = await this.host.resolve(sessionId)
    if (agent === undefined) {
      const cwd = join(this.ctx.anima.config.dataDir, 'consolidation')
      const { mkdirSync } = await import('node:fs')
      mkdirSync(cwd, { recursive: true })
      const created = await this.host.create(sessionId, { agentPreset: CONSOLIDATION_PRESET, cwd })
      if (created !== sessionId) throw new AnimaError('anima/session-id-mismatch', `DSH created session ${created} instead of ${sessionId}.`)
      agent = await this.host.resolve(sessionId)
      if (agent === undefined) throw new AnimaError('anima/session-missing', `session ${sessionId} was created but cannot be resolved.`)
      this.host.rename(agent, `Anima · memory ${stimulus.day}`)
    }
    if (model !== undefined) this.host.selectModel(agent, model)
    await this.host.deliver(agent, stimulusText(stimulus), stimulusSummary(stimulus), stimulus.type, stimulusRef(stimulus))
    return sessionId
  }

  /**
   * Add a line to what she learns at her next heartbeat, or at waking if she
   * sleeps (a platform event such as a friend request), without starting a turn.
   */
  note(text: string): void {
    this.file.events.push(text)
    this.save()
  }

  // ---- her behaviors, as they happen ----

  /** She spoke somewhere: that chat's held messages leave her inbox, and a group opens its attention window. */
  private onBehavior(event: BehaviorEvent): void {
    if (event.meta.effect !== 'express') return
    const key = event.meta.target?.(event.args)
    if (key === undefined) return
    const now = this.ctx.anima.clock.now()
    this.file.lastSpoke[key] = now
    const held = this.inbox.take(key)
    if (held.length > 0) this.ctx.anima.recordActivity({ type: 'inbox-release', channel: key, reason: 'said', count: held.length })
    const channel = this.channel(key)
    const attentionMs = this.config.groups.attentionSeconds * 1000
    if (channel?.kind === 'group' && event.name === `${channel.platform}_say` && attentionMs > 0) this.attention.set(key, Date.now() + attentionMs)
    this.save()
  }

  private onSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    if (this.waking.describe(sessionId) === undefined) return
    if (event.type === 'turn/start') {
      this.running.add(sessionId)
    } else if (event.type === 'turn/end') {
      this.running.delete(sessionId)
      for (const resolve of [...this.waiters]) resolve()
      // Sleep that overwhelmed her waits for the running turn; an ended session archives after its last one.
      this.ctx.anima.checkSleep()
      void this.archivePending()
    }
  }

  private async archivePending(): Promise<void> {
    try {
      for (const id of await this.waking.archivePending(id => this.running.has(id))) {
        this.ctx.anima.recordActivity({ type: 'waking-archive', sessionId: id })
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`anima: archiving: ${errorText(error)}`)
    }
  }

  /**
   * At the first step of each turn in her current waking session: an alarm
   * that rings while she sleeps wakes her (her body, `wake('alarm')`); the
   * first turn of a waking begins with the waking context; an alarm gets its
   * label. Logged as session messages.
   */
  private async preStep(
    payload: { agent: { id: string }; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted || payload.step !== 1) return decision
    const info = this.waking.describe(payload.agent.id)
    if (info === undefined) return decision
    // A ringing alarm carries its prompt; DSH's notice that an alarm was moved here does not, and is not an alarm.
    const alarms = decision.messages.filter(message => (message.source?.kind as string | undefined) === 'schedule'
      && alarmPrompts(message.content.map(block => block.type === 'text' ? block.text : '').join('')).length > 0)
    const core = this.ctx.anima
    if (info.kind === 'waking' && !info.current) {
      // An alarm DSH had already queued in a waking that has ended (it rang as she fell asleep): it rings
      // in her current waking instead; asleep, it wakes her there. Nothing else runs in an ended waking.
      if (alarms.length === 0) return decision
      const notes = alarms.flatMap(alarm => alarmPrompts(alarm.content.map(block => block.type === 'text' ? block.text : '').join('')))
      if (core.asleep()) core.wake('alarm')
      const now = core.clock.now()
      const line = `[闹钟] 你定的闹钟响了：${notes.map(note => `「${note}」`).join('、')}`
      void (this.waking.opened
        ? this.deliverOne({ type: 'notice', wake: true, text: line.replace(/^\[闹钟\] /, '闹钟：'), ts: now })
        : this.deliverOne({ type: 'waking', text: `${this.wakingText('alarm', now)}\n${line}`, ts: now })
      ).catch((error: unknown) => this.ctx.logger.warn(`anima: an alarm from an ended waking: ${errorText(error)}`))
      return { kind: 'reject' }
    }
    if (alarms.length === 0 && this.waking.opened) return decision
    if (alarms.length > 0 && core.asleep()) core.wake('alarm')
    const now = core.clock.now()
    const before: UserMessage[] = []
    const after: UserMessage[] = []
    // Her waking begins only once she is awake (an alarm has just woken her, or she already was).
    if (!this.waking.opened && !core.asleep()) {
      const agent = await this.waking.ensureCurrent(now)
      before.push(lifeMessage(`[${formatStamp(now)}] ${stimulusText({ type: 'waking', text: this.wakingText(alarms.length > 0 ? 'alarm' : 'restart', now), ts: now })}`, 'Waking'))
      this.waking.markOpened(agent, now)
    }
    for (const alarm of alarms) {
      const text = alarm.content.map(block => block.type === 'text' ? block.text : '').join('')
      const notes = alarmPrompts(text)
      after.push(lifeMessage(`[${formatStamp(now)}] [闹钟] 你定的闹钟响了${notes.length === 0 ? '。' : `：${notes.map(note => `「${note}」`).join('、')}`}`, 'Alarm'))
    }
    return { ...decision, messages: [...before, ...decision.messages, ...after] }
  }

  // ---- falling asleep and waking ----

  /**
   * She fell asleep: what was settling goes to her inbox, the next waking's
   * session is prepared and her alarms move into it, and the ended session is
   * archived once its last turn is over.
   */
  private async onSleep(at: number): Promise<void> {
    const core = this.ctx.anima
    for (const key of [...this.settling.keys()]) this.flushSettled(key)
    this.attention.clear()
    for (const resolve of [...this.waiters]) resolve()
    const info = core.sleepInfo()
    this.file.lastSleep = { since: at, by: info.by, ...info.note === undefined ? {} : { note: info.note } }
    this.file.counts.sleeps += 1
    this.save()
    const { ended, next, alarms } = await this.waking.sleep(at, id => this.running.has(id))
    core.recordActivity({ type: 'waking-open', sessionId: next, ...alarms > 0 ? { count: alarms } : {} })
    if (ended !== undefined && !this.waking.state.pending.includes(ended)) core.recordActivity({ type: 'waking-archive', sessionId: ended })
  }

  /** She woke by her body or the owner (or her first waking): her waking session gets its first arrival. */
  private async openWaking(by: string): Promise<void> {
    const now = this.ctx.anima.clock.now()
    this.file.counts.wakings += 1
    this.save()
    await this.deliverOne({ type: 'waking', text: this.wakingText(by, now), ts: now })
  }

  /** The waking context: the time, why she woke, her last sleep and note, her inbox, what happened while she slept. */
  private wakingText(by: string, now: number): string {
    const why: Record<string, string> = {
      rested: '你睡醒了。',
      alarm: '你定的闹钟把你叫醒了。',
      owner: '主人把你叫醒了。',
      start: '你醒着。这是你第一次在这里醒来。',
      restart: '你醒着。',
    }
    const lines = [`现在是 ${formatLocal(now)}。${why[by] ?? '你醒了。'}`]
    const last = this.file.lastSleep
    if (last !== undefined && by !== 'start') {
      lines.push(`你 ${formatLocal(last.since)} 睡着（${last.by === 'overwhelmed' ? '困得撑不住了' : '你自己上床睡的'}），睡了 ${formatSpan(now - last.since)}。${last.note === undefined ? '' : `睡前你写下：「${last.note}」`}`)
    }
    lines.push(inboxSummary(this.inbox.entries()) ?? '收件箱是空的。')
    const recent = this.known()
      .map(channel => ({ channel, last: Math.max(this.file.lastHeard[channelKey(channel)] ?? 0, this.file.lastSpoke[channelKey(channel)] ?? 0) }))
      .filter(entry => entry.last > 0)
      .sort((a, b) => b.last - a.last)
      .slice(0, this.config.waking.contextChannels)
    if (recent.length > 0) lines.push(`最近联系过的地方：${recent.map(({ channel, last }) => `${whereOf(channel)}（最后 ${formatLocal(last).slice(5)}）`).join('、')}`)
    if (this.file.events.length > 0) {
      lines.push('你睡着的时候：', ...this.file.events.map(event => `  ${event}`))
      this.file.events = []
      this.save()
    }
    return lines.join('\n')
  }

  // ---- platform health ----

  /** Whether a platform is online as far as its adapter said; true when it never said. */
  platformOnline(platform: string): boolean {
    return this.platforms.get(platform)?.online !== false
  }

  /**
   * An adapter reports its platform's health. Going offline, she is told once
   * it has lasted `platforms.noticeAfterSeconds`; coming back, she is told it is
   * back if she was told it went down. Recorded (`anima/record`).
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
        this.tell(`${name} went offline at ${formatLocal(since)}${health.reason === undefined ? '' : ` (${health.reason})`}. Nobody there can reach you, and you cannot reach anyone there until it is back; you will get a notice then.`)
      }
      const delayMs = this.config.platforms.noticeAfterSeconds * 1000
      if (delayMs <= 0) tell()
      else health.timer = setTimeout(tell, delayMs)
      return
    }
    this.ctx.logger.info(`anima: ${name} back online`)
    if (health.notified) {
      health.notified = false
      this.tell(`${name} is back online at ${formatLocal(health.since)}.`)
    }
    health.reason = undefined
  }

  /** A notice that starts nothing: context for her next turn awake, or a line for her waking. */
  private tell(text: string): void {
    void this.deliver({ type: 'notice', text, ts: this.ctx.anima.clock.now() })
      .catch((error: unknown) => this.ctx.logger.warn(`anima: could not tell her: ${errorText(error)}`))
  }

  // ---- heartbeat ----

  /** Next heartbeat, on her clock. */
  get nextHeartbeatAt(): number | undefined {
    return this.file.nextHeartbeatAt
  }

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
        this.ctx.logger.warn(`anima heartbeat: the turn it started failed: ${errorText(error)}`)
      })
    }, delay)
  }

  /**
   * One beat of her heart (docs/design/body.md): her self-drive. The next beat
   * is set first, from her resting rhythm alone; nothing she does and nothing
   * outside changes it. Awake and idle, the beat stirs her: a turn in her
   * waking session with her state. Asleep, it beats without waking her; while
   * she is in a turn, it starts no second one.
   */
  async beat(): Promise<void> {
    if (this.beating) return
    this.beating = true
    try {
      const core = this.ctx.anima
      const now = core.clock.now()
      this.schedule(nextBeat(now, core.config.heartbeat.restingMinutes))
      this.file.lastHeartbeatAt = now
      this.file.counts.heartbeats += 1
      this.save()
      if (core.asleep() || this.heldBy() !== undefined) return
      const current = this.waking.current
      if (current !== undefined && this.running.has(current)) return
      const text = this.reportText(now)
      this.file.events = []
      this.save()
      await withTimeout(this.deliverOne({ type: 'heartbeat', text, ts: now }), DELIVERY_TIMEOUT_MS, 'heartbeat delivery to her waking session')
    } finally {
      this.beating = false
    }
  }

  private reportText(now: number): string {
    const core = this.ctx.anima
    const channels: ChannelLine[] = this.known().map((channel) => {
      const key = channelKey(channel)
      const last = Math.max(this.file.lastHeard[key] ?? 0, this.file.lastSpoke[key] ?? 0)
      return { key, display: channel.display, mayInitiate: core.admit({ kind: 'initiate', channelKey: key }) === undefined, lastContact: last === 0 ? undefined : last }
    })
    const unread = Object.entries(this.groups.unread()).map(([key, n]) => `${this.channel(key)?.display ?? key} ${n}`)
    const notes = [
      ...inboxSummary(this.inbox.entries()) === undefined ? [] : [inboxSummary(this.inbox.entries())!],
      ...unread.length === 0 ? [] : [`Unread in groups: ${unread.join(', ')}.`],
      core.selfModelReportLine(),
      ...[...this.reportLines].flatMap(provider => provider()),
      ...core.clock.speed > 1 ? [`Test clock: your clock runs at ${core.clock.speed}× speed.`] : [],
    ]
    return buildReport({
      time: formatStamp(now),
      state: core.stateText(),
      goals: core.goals.open().map(describeGoal),
      events: this.file.events,
      budgets: [...this.budgetLines].flatMap(provider => provider()),
      channels, now, notes,
    })
  }

  // ---- looking closely ----

  /**
   * Look closely at frames, as a subagent of her waking session on a vision
   * model (docs/dsh.md), and return what she saw. Only the text comes back to
   * her waking session; the frames stay with the subagent.
   * @returns her note of the viewing.
   */
  async view(request: ViewRequest): Promise<string> {
    const subagents = this.ctx.get('subagents' as never) as Subagents | undefined
    if (subagents === undefined) throw new AnimaError('anima/no-subagents', 'DSH has no subagent service in this profile, so she cannot look closely.')
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const activation = await subagents.startActivation({
        provider: 'spawn', label: `viewing ${request.title}`, delivery: 'caller', signal: controller.signal,
        request: {
          parent: request.parent, signal: controller.signal, agentPreset: VIEWING_PRESET,
          ...request.model === undefined ? {} : { agentOptions: { provider: request.model.provider, model: request.model.model } },
          prompt: [{ type: 'text', text: request.text }, ...request.parts],
        },
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void activation.dispose().catch(() => undefined)
          reject(new AnimaError('anima/view-timeout', `the viewing did not finish within ${request.timeoutSeconds} s.`))
        }, request.timeoutSeconds * 1000)
      })
      const result = await Promise.race([activation.result, timeout])
      const note = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim()
      if (note === '') throw new AnimaError('anima/view-no-note', `the viewing ended without a note (${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}).`)
      return note
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
  }

  // ---- behaviors ----

  private registerBehaviors(): void {
    const core = this.ctx.anima
    const awake = { sessions: ['waking'] } as const
    const lines = {
      schema: { type: 'object' as const, additionalProperties: false as const, properties: { lines: { type: 'array' as const, items: { type: 'string' as const }, required: true as const, description: 'One line each.' } } },
    }

    core.registerBehavior(defineTool({
      name: 'rest',
      description: 'Stop and rest: ends this turn. It sets nothing in your body; your heart keeps its own rhythm. To come back to something at a time, set an alarm.',
      parameters: { note: { type: 'string', description: 'Optional note to yourself.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { resting: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'Resting.' }],
      },
      execute: async () => ({ resting: true }),
    }), { effect: 'internal', ...awake, closes: true })

    core.registerBehavior(defineTool({
      name: 'end_turn',
      description: 'End this turn without (further) speech: after a poke or a reaction alone, or when you choose not to answer.',
      parameters: { reason: { type: 'string', description: 'Why, in a few words.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ended: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'Turn ended.' }],
      },
      execute: async () => ({ ended: true }),
    }), { effect: 'internal', ...awake, closes: true })

    core.registerBehavior(defineTool({
      name: 'wait',
      description: 'Keep your attention open for a while, in seconds on your clock. It returns at once when anything new arrives, from any chat; if nothing does before the time runs out, this turn ends.',
      parameters: {
        seconds: { type: 'number', required: true, description: `How long to wait, 1–${this.config.wait.maxSeconds} seconds.` },
        channel: { type: 'string', description: 'Optional: which chat you are waiting for (anything still interrupts the wait).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { arrived: { type: 'boolean', required: true, description: 'Whether something arrived before the time ran out.' } } },
        render: (_args, value) => [{ type: 'text', text: value.arrived ? '有新消息到了。' : '等到了时间，什么也没来。' }],
      },
      execute: async (args, exec) => {
        const seconds = Math.max(1, Math.min(this.config.wait.maxSeconds, Number(args.seconds) || 0))
        const arrived = await new Promise<boolean>((resolve) => {
          let done = false
          const finish = (value: boolean) => {
            if (done) return
            done = true
            clearTimeout(timer)
            this.waiters.delete(onArrival)
            exec.signal.removeEventListener('abort', onAbort)
            resolve(value)
          }
          const onArrival = () => finish(true)
          const onAbort = () => finish(true)
          const timer = setTimeout(() => finish(false), Math.ceil(core.clock.realDelay(seconds * 1000)))
          this.waiters.add(onArrival)
          exec.signal.addEventListener('abort', onAbort, { once: true })
        })
        if (!arrived) exec.concludeTurn()
        return { arrived }
      },
    }), { effect: 'internal', ...awake })

    core.registerBehavior(defineTool({
      name: 'inbox_read',
      description: 'Read the messages that arrived while you were asleep or paused, per chat, with the times they were sent. A chat\'s messages leave the inbox when you say something there or when that chat writes again.',
      parameters: { channel: { type: 'string', description: 'Optional channel key, to read one chat only.' } },
      output: { ...lines, render: (_args, value) => [{ type: 'text', text: value.lines.length === 0 ? '收件箱是空的。' : value.lines.join('\n') }] },
      execute: async (args) => {
        const entries = this.inbox.entries().filter(entry => args.channel === undefined || args.channel === '' || entry.key === args.channel)
        return {
          lines: entries.flatMap(({ channel, messages }) => [
            `${whereOf(channel)} ${messages.length} 条：`,
            ...messages.map(m => `  ${formatLocal(m.ts)} ${m.sender.displayName}${m.sender.isOwner ? '（主人）' : ''}${m.messageId === undefined ? '' : ` [msg ${m.messageId}]`}${m.addressed === true ? ' 叫你' : ''}: ${m.text}`),
          ]),
        }
      },
    }), { effect: 'observe', ...awake })

    const groupLine = (m: MessageStimulus) => `  ${formatLocal(m.ts).slice(11)} ${senderLabel(m)}: ${m.text}`
    core.registerBehavior(defineTool({
      name: 'groups_glance',
      description: 'Glance at your groups: which have unread messages, how many, and the latest few lines of each. It does not mark them read.',
      parameters: {},
      output: { ...lines, render: (_args, value) => [{ type: 'text', text: value.lines.length === 0 ? '没有未读的群消息。' : value.lines.join('\n') }] },
      execute: async (_args, exec) => {
        const { groups, fresh } = this.groups.glance(this.config.groups.glanceLines)
        this.perceived(fresh, exec.agent?.id)
        return { lines: groups.flatMap(group => [`${whereOf(group.channel)} ${group.unread} 条未读，最近的：`, ...group.latest.map(groupLine)]) }
      },
    }), { effect: 'observe', ...awake })

    core.registerBehavior(defineTool({
      name: 'group_read',
      description: 'Read one group: its recent messages, oldest first, and mark it read. Give `before` (a message id) to read further back.',
      parameters: {
        channel: { type: 'string', required: true, description: 'The group\'s channel key.' },
        before: { type: 'string', description: 'Optional message id: read the messages before it.' },
        count: { type: 'integer', description: `How many messages (default ${READ_LINES}).` },
      },
      output: { ...lines, render: (_args, value) => [{ type: 'text', text: value.lines.length === 0 ? '这里没有可读的消息。' : value.lines.join('\n') }] },
      execute: async (args, exec) => {
        const count = Math.max(1, Math.min(this.config.groups.bufferMessages, Math.round(args.count ?? READ_LINES)))
        const read = this.groups.read(args.channel.trim(), count, args.before)
        if (read === undefined) return { lines: [] }
        this.perceived(read.fresh, exec.agent?.id)
        this.ctx.emit('anima/read', { channel: read.channel })
        return { lines: [`${whereOf(read.channel)}${read.earlier ? '（更早的还有）' : ''}：`, ...read.lines.map(groupLine)] }
      },
    }), { effect: 'observe', ...awake, target: args => typeof args.channel === 'string' ? args.channel.trim() : undefined })
  }

  /** Group lines she now sees for the first time joined her perception (memory records them). */
  private perceived(messages: readonly MessageStimulus[], sessionId: string | undefined): void {
    for (const message of messages) this.ctx.emit('anima/stimulus', { stimulus: message, sessionId: sessionId ?? this.waking.current ?? '', delivery: 'context' })
  }

  private statusPart(): Record<string, unknown> {
    const { counts, nextHeartbeatAt, lastHeartbeatAt } = this.file
    return {
      nextHeartbeatAt: nextHeartbeatAt ?? null,
      nextHeartbeat: nextHeartbeatAt === undefined ? null : formatLocal(nextHeartbeatAt),
      lastHeartbeat: lastHeartbeatAt === undefined ? null : formatLocal(lastHeartbeatAt),
      counts,
      inbox: this.inbox.entries().map(({ key, channel, messages }) => ({ key, display: channel.display, count: messages.length, first: messages[0]!.ts, last: messages.at(-1)!.ts })),
      groupsUnread: this.groups.unread(),
      sessions: { waking: this.waking.current ?? null, opened: this.waking.opened, pendingArchive: this.waking.state.pending, past: this.waking.state.past.slice(-10) },
    }
  }

  private statusLines(): string[] {
    const { counts, nextHeartbeatAt } = this.file
    const current = this.waking.current
    return [
      `Waking session: ${current ?? 'none'}${current === undefined ? '' : `${this.waking.opened ? '' : ' (prepared, not opened)'}${this.running.has(current) ? ' (turn running)' : ''}`}`,
      `Waiting to archive: ${this.waking.state.pending.join(', ') || 'none'}`,
      `Next heartbeat: ${nextHeartbeatAt === undefined ? 'not scheduled' : formatLocal(nextHeartbeatAt)}`,
      `Heartbeats ${counts.heartbeats}, wakings ${counts.wakings}, sleeps ${counts.sleeps}`,
      `Inbox: ${this.inbox.entries().map(({ channel, messages }) => `${channel.display} ${messages.length} (last ${formatLocal(messages.at(-1)!.ts)})`).join(', ') || 'empty'}`,
      `Settle window: ${this.config.conversation.settleSeconds} s quiet, at most ${this.config.conversation.settleMaxSeconds} s; waiting: ${[...this.settling].map(([key, e]) => `${key} (${e.messages.length}${e.typing > 0 ? `, typing ${e.typing}` : ''})`).join(', ') || 'none'}`,
      `Groups: attention ${this.config.groups.attentionSeconds} s (in it: ${[...this.attention].filter(([, until]) => until > Date.now()).map(([key]) => key).join(', ') || 'none'}); unread ${Object.entries(this.groups.unread()).map(([key, n]) => `${key} ${n}`).join(', ') || 'none'}`,
    ]
  }
}

/** A context message from life, logged with source `anima-life`. */
function lifeMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'anima-stimulus', stimulus: 'waking', form: 'notice', summary: boundContextSummary(summary) },
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
