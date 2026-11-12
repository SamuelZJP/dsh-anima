/**
 * The `animaLife` service: channel publication, stimulus delivery, the Self and
 * triage sessions, the heartbeat loop (DESIGN §7), `open_conversation` with
 * intent outcomes (DESIGN §5), and the session and channel resolvers it
 * provides to the core gate.
 * @module @anima/life/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, channelKey, describeGoal, formatLocal, formatStamp, nextWake, parseWhen, readJson, stringArg, writeJson } from '@anima/core'
import type {} from '@anima/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { groupTriageModel, resolveLifeConfig, type Config as LifeConfig } from './config.ts'
import { batchText, GroupTriage, type Batch, type MessageStimulus } from './group-triage.ts'
import { nextHeartbeat } from './heartbeat.ts'
import { answeringIntent, describeOutcome, IntentTracker, OUTBOX_CANCELLED, OUTBOX_EXPIRED, type Outcome, type TrackerState } from './intent.ts'
import { Outbox, platformOf, type HeldMessage } from './outbox.ts'
import { buildReport, type ChannelLine } from './report.ts'
import { SessionRouter, type ModelChoice, type SessionHost } from './router.ts'
import { senderLabel, wakes, type ExtraBlock, type PublishedChannel, type Stimulus } from './stimulus.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaLife: AnimaLife
  }
  interface Events {
    /** A stimulus was delivered to one of her sessions. `anima-memory` records channel messages from it. */
    'anima/stimulus'(payload: StimulusEvent): void
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

/** Options of the life service. */
export interface LifeOptions {
  /** Session host; DSH's by default (tests pass a fake). */
  readonly host?: SessionHost<Agent>
  readonly config?: Partial<LifeConfig>
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A stimulus Anima delivered into one of her sessions. */
    'anima-stimulus': { kind: 'anima-stimulus'; stimulus: string; ref?: string } & ContextFormed
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

  private message(text: string, summary: string, stimulus: string, ref?: string, extra: readonly ExtraBlock[] = []) {
    return createUserMessage({
      content: [{ type: 'text', text }, ...extra],
      source: { kind: 'anima-stimulus', stimulus, form: 'notice', summary: boundContextSummary(summary), ...ref === undefined ? {} : { ref } },
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
    agent.followup(this.message(text, summary, stimulus, ref, extra))
    await this.flush(agent)
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
  /** Life config. */
  readonly config: Readonly<LifeConfig>
  /** Group triage buffers and batches. */
  readonly triage: GroupTriage
  /** Her initiated messages waiting to go out. */
  readonly outbox: Outbox
  /** Batch whose turn is running in the group-triage session. */
  private triageTurn: string | undefined
  /** Viewing sessions waiting for their note, by session id. */
  private readonly views = new Map<string, ViewWaiter>()
  /** Health of each platform as its adapter reports it (DESIGN §11). */
  private readonly platforms = new Map<string, PlatformHealth>()
  /** Pending express calls in conversation sessions, by `session|callId`. */
  private readonly expressCalls = new Map<string, string>()

  /**
   * @param ctx - root context.
   * @param options - a session host (tests), or `{ host?, config? }`.
   */
  constructor(ctx: Context, options?: SessionHost<Agent> | LifeOptions) {
    super(ctx, 'animaLife')
    const core = ctx.anima
    const { characterId, selfGeneration, dataDir } = core.config
    const opts: LifeOptions = options !== undefined && 'resolve' in options ? { host: options } : options ?? {}
    this.config = resolveLifeConfig(opts.config)
    const host = opts.host
    this.host = host ?? new DshSessionHost(ctx)
    this.router = new SessionRouter(this.host, { characterId, selfGeneration, dataDir, stamp: () => formatStamp(core.clock.now()) })
    this.path = join(dataDir, 'life.json')
    this.file = { ...emptyFile(), ...readJson<LifeFile>(this.path) }
    this.tracker = new IntentTracker(this.file.intents, name => core.behavior(name)?.effect === 'express')
    const { groupTriage, outbox } = this.config
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
    this.outbox = new Outbox(() => { this.file.outboxSeq += 1; this.save(); return this.file.outboxSeq }, outbox.delaySeconds * 1000, outbox.offlineHoldMinutes * 60_000)
    ctx.effect(() => () => {
      this.outbox.cancelAll()
      for (const health of this.platforms.values()) clearTimeout(health.timer)
    }, 'animaLife.outbox')
    core.addOwnerReply((reply) => {
      if (reply.verb !== 'cancel' || !reply.id.startsWith('o')) return undefined
      return this.outbox.cancel(reply.id) ? `Cancelled ${reply.id}; it will not be sent.` : `No message ${reply.id} in the outbox (already sent or cancelled).`
    })

    core.provideSessions(id => this.router.describe(id))
    core.provideChannels(key => {
      const channel = this.router.channel(key)
      return channel === undefined ? undefined : { isOwner: channel.isOwner === true }
    }, () => this.router.known().map(({ channel }) => channelKey(channel)))
    core.addStatus(() => this.statusLines())
    core.addSubcommand({
      name: 'self',
      usage: 'self [text] — open her Self session; with text, deliver it there as an owner notice',
      run: async (args) => {
        if (args === '') {
          const agent = await this.router.ensureSelf()
          return { kind: 'success', text: `Self session: ${agent.id}. It shows in the sidebar after its first turn; use /anima self <text> to start one.` }
        }
        // A notice comes without a situation report, so it names the channels she can reach.
        const reachable = this.router.known()
          .map(({ channel }) => ({ key: channelKey(channel), display: channel.display }))
          .filter(({ key }) => core.channelAllowed(key) !== false)
          .map(({ key, display }) => `${display}: "${key}"`)
        const text = `The owner says: ${args}\nChannels you can reach: ${reachable.join('; ') || 'none'}.`
        const id = await this.deliver({ type: 'notice', text, ts: core.clock.now() })
        return { kind: 'success', text: `Delivered to the Self session ${id}.` }
      },
    })
    core.addSubcommand({
      name: 'heartbeat',
      usage: 'heartbeat — run a heartbeat now instead of at the scheduled time',
      run: async () => {
        await core.ownerAction('heartbeat', {}, 'command')
        return { kind: 'success', text: `Heartbeat delivered to the triage session of ${core.dayKey()}.` }
      },
    })

    core.addSubcommand({
      name: 'outbox',
      usage: 'outbox [cancel <id>] — list her held initiated messages, or cancel one before it goes out',
      run: async (args) => {
        const [verb = '', id = ''] = args.split(/\s+/)
        if (verb === '') {
          const held = this.outbox.list()
          if (held.length === 0) return { kind: 'success', text: `The outbox is empty (delay ${this.config.outbox.delaySeconds} s).` }
          return { kind: 'success', text: held.map(m => `${m.id} → ${m.display} in ${Math.max(0, Math.round((m.sendsAt - Date.now()) / 1000))} s (intent ${m.intentId}): ${m.text}`).join('\n') }
        }
        if (verb.toLowerCase() !== 'cancel' || id === '') return { kind: 'error', text: 'Usage: /anima outbox [cancel <id>]' }
        const { cancelled } = await core.ownerAction('outbox.cancel', { id }, 'command') as { cancelled: boolean }
        return cancelled ? { kind: 'success', text: `Cancelled ${id.toLowerCase()}.` } : { kind: 'error', text: `No message ${id} in the outbox.` }
      },
    })

    // Owner surface shared with the Anima page (DESIGN §12).
    core.addOwnerView('outbox', () => ({
      delaySeconds: this.config.outbox.delaySeconds,
      held: this.outbox.list().map(m => ({ id: m.id, display: m.display, channelKey: m.channelKey, intentId: m.intentId, text: m.text, sendsAt: m.sendsAt, offlineSince: m.offlineSince ?? null })),
    }))
    core.addOwnerAction('outbox.cancel', args => ({ cancelled: this.outbox.cancel(stringArg(args, 'id')) }))
    core.addOwnerAction('heartbeat', async () => {
      await this.beat()
      return { day: core.dayKey() }
    })
    core.addStatusPart('life', () => this.statusPart())

    this.registerBehaviors()

    ctx.on('session/event', (session, event) => this.onSessionEvent(session.id, event))

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
   * Route and deliver one stimulus. A group message that does not address her
   * and is not from the owner goes to group triage first (DESIGN §5); one that
   * does wakes the group at once, with the group's buffered messages as context.
   * Channel stimuli for a channel off its platform's allowlist are refused.
   * @param options.model - model to select on the target session before delivery.
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus, options: { model?: ModelChoice } = {}): Promise<string> {
    if (stimulus.type === 'message' || stimulus.type === 'channel-event' || stimulus.type === 'intent') {
      const key = channelKey(stimulus.channel)
      if (this.ctx.anima.channelAllowed(key) === false) {
        throw new AnimaError('anima/not-allowlisted', `${key} is not on the owner's allowlist; the stimulus was dropped.`)
      }
      if (stimulus.type === 'message' && stimulus.channel.kind === 'group') {
        if (!wakes(stimulus)) {
          this.router.know(stimulus.channel)
          this.triage.add(stimulus)
          return this.router.conversationId(stimulus.channel)
        }
        for (const earlier of this.triage.take(key)) await this.deliverOne(earlier, {}, false)
        this.groupDay(key).direct += 1
        this.save()
      }
    }
    return this.deliverOne(stimulus, options)
  }

  private async deliverOne(stimulus: Stimulus, options: { model?: ModelChoice }, wake = wakes(stimulus)): Promise<string> {
    const sessionId = await this.deliverNow(stimulus, options, wake)
    this.ctx.emit('anima/stimulus', { stimulus, sessionId, delivery: wake ? 'wake' : 'context' })
    return sessionId
  }

  private async deliverNow(stimulus: Stimulus, options: { model?: ModelChoice }, wake: boolean): Promise<string> {
    const model = options.model
    const before = model === undefined ? undefined : (agent: Agent) => this.host.selectModel(agent, model)
    if (stimulus.type === 'message') {
      const key = channelKey(stimulus.channel)
      this.file.lastContact[key] = stimulus.ts
      if (wake) this.file.events.push(`${stimulus.sender.displayName}${stimulus.sender.isOwner ? ' (owner)' : ''} wrote to you in ${stimulus.channel.display} at ${formatLocal(stimulus.ts)}.`)
      if (stimulus.sender.isOwner) this.report(this.tracker.onOwnerMessage(key))
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
    if (core.paused || core.mode(now) === 'night' || core.overBudget(now)) return false
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
        void (async () => {
          for (const [index, message] of messages.entries()) await this.deliverOne(message, {}, index === messages.length - 1)
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

  // ---- outbox ----

  /**
   * Called by every say tool before it sends. When this turn is answering an
   * intent (her own initiation), the message waits in the outbox for the
   * configured delay, and the owner can cancel it (DESIGN §10).
   * @param sessionId - the calling conversation session.
   * @param text - the message, for the outbox listing.
   * @throws AnimaError `anima/outbox-cancelled` when it must not be sent.
   */
  async holdOutgoing(sessionId: string, text: string, options: { onHeld?: (held: HeldMessage) => void } = {}): Promise<void> {
    const intent = answeringIntent(this.file.intents, sessionId)
    if (intent === undefined) return
    const core = this.ctx.anima
    const platform = platformOf(intent.channelKey)
    const result = await this.outbox.hold({ sessionId, channelKey: intent.channelKey, display: intent.display, text, intentId: intent.id }, {
      online: () => this.platformOnline(platform),
      onHeld: (held) => {
        options.onHeld?.(held)
        if (!this.config.outbox.notifyOwner || core.channelInfo(intent.channelKey)?.isOwner === true) return
        core.ownerLine?.send(`[Anima outbox ${held.id}] In ${this.config.outbox.delaySeconds} s she sends to ${held.display}: "${text}". Reply "cancel ${held.id}" to stop it.`)
          .catch((error: unknown) => this.ctx.logger.warn(`anima: could not notify the owner about ${held.id}: ${String(error)}`))
      },
    })
    if (result === 'cancelled') throw new AnimaError(OUTBOX_CANCELLED, 'the owner cancelled this message before it went out. Do not send it again now.')
    if (result === 'expired') {
      throw new AnimaError(OUTBOX_EXPIRED, `${platform} stayed offline for ${this.config.outbox.offlineHoldMinutes} min after the message was due, so it was never sent. Do not send it again now; you hear when ${platform} is back.`)
    }
    if (core.paused) throw new AnimaError(OUTBOX_CANCELLED, 'Anima was paused while the message waited in the outbox, so it was not sent.')
  }

  // ---- platform health ----

  /** Whether a platform is online as far as its adapter said; true when it never said. */
  platformOnline(platform: string): boolean {
    return this.platforms.get(platform)?.online !== false
  }

  /**
   * An adapter reports its platform's health (DESIGN §11). Going offline, her
   * Self session gets a notice once it has lasted `platforms.noticeAfterSeconds`;
   * coming back, held outbox messages go out, and she is told it is back if she
   * was told it went down. Logged; never alerts anyone.
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
    const released = this.outbox.release(platform)
    if (health.notified) {
      health.notified = false
      this.tellSelf(`${name} is back online at ${formatLocal(health.since)}.${released === 0 ? '' : ` ${released} held message${released === 1 ? '' : 's'} went out now.`}`, `${name} back online`, 'platform-online')
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
      if (core.paused) return this.schedule(now + core.modeConfig('day').minIntervalMinutes * MIN)
      if (core.overBudget(now)) return this.schedule(nextWakeOf(core, now))
      if (mode === 'night' && core.nightWakesLeft(now) <= 0) return this.schedule(nextWakeOf(core, now))
      const day = core.dayKey(now)
      const triageId = this.router.triageId(day)
      if (await this.busy(triageId) || await this.busy(this.router.selfId)) return this.schedule(now + MIN)
      if (mode === 'night') core.useNightWake(now)

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
    }
  }

  private reportText(now: number, forSelf = false): string {
    const core = this.ctx.anima
    const channels: ChannelLine[] = this.router.known().map(({ channel }) => {
      const key = `${channel.platform}:${channel.account}:${channel.kind}:${channel.id}`
      return { key, display: channel.display, mayInitiate: core.mayInitiate(key), lastContact: this.file.lastContact[key] }
    })
    const notes = [core.selfModelReportLine(), ...[...this.reportLines].flatMap(provider => provider())]
    if (forSelf && core.clock.speed > 1) notes.push(`Test clock: your clock runs at ${core.clock.speed}× speed; alarms from schedule_create run on the real clock (real time now ${formatLocal(core.clock.realTime())}).`)
    return buildReport({
      time: formatStamp(now), phase: core.phase(now), mode: core.mode(now),
      state: core.stateText(),
      goals: core.goals.open().map(describeGoal),
      events: this.file.events,
      budgets: core.budgetText(now),
      channels, now, notes,
    })
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
        const source = (data as { source?: { kind?: string; ref?: string } }).source
        if (info.kind === 'conversation' && source?.kind === 'anima-stimulus') this.tracker.onUserMessage(sessionId, source.ref)
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
          if (this.ctx.anima.behavior(name)?.effect === 'express') {
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
        const express = this.expressCalls.get(`${sessionId}|${message.toolCallId}`)
        this.expressCalls.delete(`${sessionId}|${message.toolCallId}`)
        // A reply outside an intent: her Self hears it was already answered (DESIGN §5, Phase 7).
        if (express !== undefined && message.isError !== true && outcome === undefined) this.noteResponded(info.channelKey, express)
        this.save()
        break
      }
      case 'assistant/message': {
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
    }), { effect: 'internal', sessions: ['triage', 'self'] })

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
      execute: async (args) => {
        const channel = this.router.channel(args.channel)
        if (channel === undefined) {
          const known = this.router.known().map(({ channel: c }) => `${c.platform}:${c.account}:${c.kind}:${c.id}`).join(', ')
          throw new AnimaError('anima/unknown-channel', `no channel "${args.channel}". Known channels: ${known || 'none'}.`)
        }
        const now = core.clock.now()
        const intentId = `i${++this.file.intentSeq}`
        const sessionId = this.router.conversationId(channel)
        this.tracker.open({ id: intentId, sessionId, channelKey: args.channel, display: channel.display, intent: args.intent, at: now })
        this.file.counts.intents += 1
        this.file.lastContact[args.channel] = now
        this.save()
        await this.routed({ type: 'intent', channel, intentId, intent: args.intent, context: args.context, ts: now })
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
        this.triage.decide(batch.id, 'wake')
        return { decision: 'wake' }
      },
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
    }), { effect: 'internal', sessions: ['group-triage'] })

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
    }), { effect: 'internal', sessions: ['viewing'] })

    core.registerBehavior(defineTool({
      name: 'stay_silent',
      description: 'Choose not to speak in this conversation now, and end the turn. Give a short reason; if this turn came from your own intent, your Self learns it was declined.',
      parameters: {
        reason: { type: 'string', description: 'Why you are staying silent.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { silent: { type: 'boolean', required: true, description: 'Always true.' } } },
        render: () => [{ type: 'text', text: 'You stay silent.' }],
      },
      execute: async (_args, exec) => {
        exec.concludeTurn()
        return { silent: true }
      },
    }), { effect: 'internal', sessions: ['conversation'] })
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
      outboxHeld: this.outbox.list().length,
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
      `Group triage: window ${this.config.groupTriage.windowSeconds} s; open buffers ${this.triage.open().map(b => `${b.channelKey} (${b.messages})`).join(', ') || 'none'}; undecided batches ${this.triage.undecided().map(b => b.id).join(', ') || 'none'}`,
      ...Object.entries(this.file.groups[core.dayKey()] ?? {}).map(([key, g]) => `  ${key} today: wakes ${g.direct} direct + ${g.triage} triage; batches ${g.batches} (remember ${g.remember}, ignore ${g.ignore}, fallback ${g.fallback})`),
      `Outbox: delay ${this.config.outbox.delaySeconds} s, offline hold ${this.config.outbox.offlineHoldMinutes} min; held ${this.outbox.list().map(m => `${m.id} → ${m.display}${m.offlineSince === undefined ? '' : ' (waiting for its platform)'}`).join(', ') || 'none'}`,
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
