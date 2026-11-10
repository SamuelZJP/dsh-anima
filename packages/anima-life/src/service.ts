/**
 * The `animaLife` service: channel publication, stimulus delivery, the Self and
 * triage sessions, the heartbeat loop (DESIGN §7), `open_conversation` with
 * intent outcomes (DESIGN §5), and the session and channel resolvers it
 * provides to the core gate.
 * @module @anima/life/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, describeGoal, formatLocal, formatStamp, nextWake, parseWhen, readJson, writeJson } from '@anima/core'
import type {} from '@anima/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { nextHeartbeat } from './heartbeat.ts'
import { describeOutcome, IntentTracker, type Outcome, type TrackerState } from './intent.ts'
import { buildReport, type ChannelLine } from './report.ts'
import { SessionRouter, type ModelChoice, type SessionHost } from './router.ts'
import type { PublishedChannel, Stimulus } from './stimulus.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaLife: AnimaLife
  }
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

  private message(text: string, summary: string, stimulus: string, ref?: string) {
    return createUserMessage({
      content: [{ type: 'text', text }],
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

  async deliver(agent: Agent, text: string, summary: string, stimulus: string, ref?: string): Promise<void> {
    agent.followup(this.message(text, summary, stimulus, ref))
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
}

function emptyFile(): LifeFile {
  return { events: [], lastContact: {}, intents: { pending: [], active: [], awaitingReply: [] }, intentSeq: 0, awaitingSelfRest: false, counts: { heartbeats: 0, acts: 0, rests: 0, intents: 0 } }
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

  /**
   * @param ctx - root context.
   * @param host - session host; DSH's by default (tests pass a fake).
   */
  constructor(ctx: Context, host?: SessionHost<Agent>) {
    super(ctx, 'animaLife')
    const core = ctx.anima
    const { characterId, selfGeneration, dataDir } = core.config
    this.host = host ?? new DshSessionHost(ctx)
    this.router = new SessionRouter(this.host, { characterId, selfGeneration, dataDir, stamp: () => formatStamp(core.clock.now()) })
    this.path = join(dataDir, 'life.json')
    this.file = { ...emptyFile(), ...readJson<LifeFile>(this.path) }
    this.tracker = new IntentTracker(this.file.intents, name => core.behavior(name)?.effect === 'express')

    core.provideSessions(id => this.router.describe(id))
    core.provideChannels(key => {
      const channel = this.router.channel(key)
      return channel === undefined ? undefined : { isOwner: channel.isOwner === true }
    })
    core.addStatus(() => this.statusLines())
    core.addSubcommand({
      name: 'self',
      usage: 'self [text] — open her Self session; with text, deliver it there as an owner notice',
      run: async (args) => {
        if (args === '') {
          const agent = await this.router.ensureSelf()
          return { kind: 'success', text: `Self session: ${agent.id}. It shows in the sidebar after its first turn; use /anima self <text> to start one.` }
        }
        const id = await this.deliver({ type: 'notice', text: `The owner says: ${args}`, ts: core.clock.now() })
        return { kind: 'success', text: `Delivered to the Self session ${id}.` }
      },
    })
    core.addSubcommand({
      name: 'heartbeat',
      usage: 'heartbeat — run a heartbeat now instead of at the scheduled time',
      run: async () => {
        await this.beat()
        return { kind: 'success', text: `Heartbeat delivered to the triage session of ${core.dayKey()}.` }
      },
    })

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
   * Route and deliver one stimulus.
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus): Promise<string> {
    if (stimulus.type === 'message') {
      const key = `${stimulus.channel.platform}:${stimulus.channel.account}:${stimulus.channel.kind}:${stimulus.channel.id}`
      this.file.lastContact[key] = stimulus.ts
      this.file.events.push(`${stimulus.sender.displayName}${stimulus.sender.isOwner ? ' (owner)' : ''} wrote to you in ${stimulus.channel.display} at ${formatLocal(stimulus.ts)}.`)
      if (stimulus.sender.isOwner) this.report(this.tracker.onOwnerMessage(key))
      this.save()
    }
    return this.router.deliver(stimulus)
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
      const ask = mode === 'night'
        ? 'You are asleep. Call rest(until?) to go back to sleep.'
        : 'Decide: rest(until?) to keep resting, or heartbeat_act(reason) to get up and act now.'
      await withTimeout(this.router.deliver({ type: 'heartbeat', to: 'triage', day, text: `${report}\n\n${ask}`, ts: now }, agent => {
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
    const notes = forSelf && core.clock.speed > 1
      ? [`Test clock: your clock runs at ${core.clock.speed}× speed; alarms from schedule_create run on the real clock (real time now ${formatLocal(core.clock.realTime())}).`]
      : []
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
    await this.router.deliver({ type: 'heartbeat', to: 'self', day: core.dayKey(now), text, ts: now }, agent => {
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
            this.file.lastContact[info.channelKey] = this.ctx.anima.clock.now()
            this.save()
          }
        }
        break
      }
      case 'tool/result': {
        if (info.kind !== 'conversation') break
        const message = (data as { message: { toolCallId: string; isError?: boolean; content?: { type: string; text?: string }[] } }).message
        const errorText = message.isError === true ? (message.content ?? []).map(block => block.text ?? '').join('') : undefined
        this.report(this.tracker.onToolResult(sessionId, message.toolCallId, message.isError === true, errorText))
        this.save()
        break
      }
      case 'turn/end': {
        if (info.kind === 'conversation') {
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
        await this.router.deliver({ type: 'intent', channel, intentId, intent: args.intent, context: args.context, ts: now })
        return { delivered: true, intentId }
      },
    }), { effect: 'initiate', sessions: ['self'], target: args => typeof args.channel === 'string' ? args.channel : undefined })

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

  private statusLines(): string[] {
    const { counts, nextHeartbeatAt, intents } = this.file
    const core = this.ctx.anima
    return [
      `Next heartbeat: ${nextHeartbeatAt === undefined ? 'not scheduled' : formatLocal(nextHeartbeatAt)}${this.file.awaitingSelfRest ? ' (Self is acting)' : ''}`,
      `Heartbeats ${counts.heartbeats}, acted ${counts.acts}, rests ${counts.rests}, intents ${counts.intents}`,
      `Pending intents: ${[...intents.pending, ...intents.active].map(i => `${i.id} → ${i.display}`).join(', ') || 'none'}`,
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
