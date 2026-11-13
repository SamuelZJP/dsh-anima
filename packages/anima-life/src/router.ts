/**
 * Get-or-create of Anima sessions and stimulus delivery, over a small
 * {@link SessionHost} so the logic is testable without a DSH host.
 * @module @anima/life/router
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AnimaError, channelKey, type SessionInfo, type SessionKind } from '@anima/core'
import { answerLine, route, stimulusRef, stimulusSummary, stimulusText, wakes, type ExtraBlock, type PublishedChannel, type Route, type Stimulus } from './stimulus.ts'
import { consolidationSessionId, conversationSessionId, groupTriageSessionId, selfSessionId, triageSessionId, viewingSessionId } from './identity.ts'

/** Preset ids of the session kinds (bundle/presets/*.patch.yml). */
export const PRESETS: Record<SessionKind, string> = {
  conversation: 'anima-conversation',
  self: 'anima-self',
  triage: 'anima-triage',
  consolidation: 'anima-consolidation',
  'group-triage': 'anima-group-triage',
  viewing: 'anima-viewing',
}

const CWD: Record<SessionKind, string> = { conversation: 'conversations', self: 'workspace', triage: 'triage', consolidation: 'consolidation', 'group-triage': 'group-triage', viewing: 'viewing' }

/** A model route to select for a session's next requests. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/** The part of a live DSH Agent the router uses. */
export interface HostAgent {
  readonly id: string
}

/** Session operations the router needs from DSH. */
export interface SessionHost<A extends HostAgent = HostAgent> {
  /** Live agent of an existing session, or undefined when no session has the id. */
  resolve(sessionId: string): Promise<A | undefined>
  /** Create a session under exactly this id. Returns the id DSH used. */
  create(sessionId: string, spec: { agentPreset: string; cwd: string }): Promise<string>
  /** Whether the session is archived (archived sessions refuse model steps). */
  isArchived(sessionId: string): boolean
  /** Set a new session's title. */
  rename(agent: A, title: string): void
  /** Queue a waking message and wait until it is durable. */
  deliver(agent: A, text: string, summary: string, stimulus: Stimulus['type'], ref?: string, extra?: readonly ExtraBlock[]): Promise<void>
  /**
   * Steer a message into the agent's running turn as its next step (a close
   * reminder at `agent/turn-stopping`). Optional: without it no reminder is sent.
   */
  steer?(agent: A, text: string, summary: string, stimulus: string): void
  /** Queue context for the agent's next step without waking it. */
  inject(agent: A, text: string, summary: string, stimulus: string): Promise<void>
  /** Select the model of the agent's next requests. */
  selectModel(agent: A, choice: ModelChoice): void
  /** Whether the agent is running a turn. */
  isBusy(agent: A): boolean
}

/** Options of a router. */
export interface RouterOptions {
  readonly characterId: string
  /** Self session generation (core `selfGeneration`); defaults to 1. */
  readonly selfGeneration?: number
  /** Conversation session generation (core `conversationGeneration`); defaults to 1. */
  readonly conversationGeneration?: number
  readonly dataDir: string
  /** Clock stamp prefixed to every delivered stimulus, e.g. `Tue 2026-11-10 08:12`. */
  readonly stamp?: () => string
  /**
   * Her tools for answering in a channel: its say tool and the tool that ends
   * the turn without speech, when registered. Waking conversation arrivals end
   * with a line naming them (DESIGN §5); without this option there is no line.
   */
  readonly answerTools?: (channel: PublishedChannel) => { say: string | undefined; ender: string | undefined }
}

/** Routes stimuli to deterministic sessions and remembers which id is which channel. */
export class SessionRouter<A extends HostAgent = HostAgent> {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly channels = new Map<string, { channel: PublishedChannel; channelKey: string }>()
  private readonly triage = new Map<string, string>()
  private readonly consolidation = new Map<string, string>()
  private readonly groupTriage = new Map<string, string>()
  private readonly viewing = new Map<string, string>()

  constructor(private readonly host: SessionHost<A>, private readonly options: RouterOptions) {}

  /** Self session id. */
  get selfId(): string {
    return selfSessionId(this.options.characterId, this.options.selfGeneration)
  }

  /**
   * Make a channel known, so its session id resolves back to it.
   * @returns a disposer that forgets it.
   */
  know(channel: PublishedChannel): () => void {
    const key = channelKey(channel)
    const sessionId = conversationSessionId(this.options.characterId, key, this.options.conversationGeneration)
    const entry = { channel, channelKey: key }
    this.channels.set(sessionId, entry)
    return () => {
      if (this.channels.get(sessionId) === entry) this.channels.delete(sessionId)
    }
  }

  /**
   * Describe a session id.
   * @returns Anima session info, or undefined for any other session.
   */
  describe(sessionId: string): SessionInfo | undefined {
    if (sessionId === this.selfId) return { kind: 'self' }
    if (this.triage.has(sessionId)) return { kind: 'triage' }
    if (this.consolidation.has(sessionId)) return { kind: 'consolidation' }
    if (this.groupTriage.has(sessionId)) return { kind: 'group-triage' }
    if (this.viewing.has(sessionId)) return { kind: 'viewing' }
    const entry = this.channels.get(sessionId)
    return entry === undefined ? undefined : { kind: 'conversation', channel: entry.channel, channelKey: entry.channelKey }
  }

  /**
   * Triage session id of a day, made known to {@link describe}.
   * @param day - her day key.
   */
  triageId(day: string): string {
    const id = triageSessionId(this.options.characterId, day)
    this.triage.set(id, day)
    return id
  }

  /**
   * Consolidation session id of a day, made known to {@link describe}.
   * @param day - her day key.
   */
  consolidationId(day: string): string {
    const id = consolidationSessionId(this.options.characterId, day)
    this.consolidation.set(id, day)
    return id
  }

  /**
   * Group-triage session id of a day, made known to {@link describe}.
   * @param day - her day key.
   */
  groupTriageId(day: string): string {
    const id = groupTriageSessionId(this.options.characterId, day)
    this.groupTriage.set(id, day)
    return id
  }

  /**
   * Viewing session id of one close view, made known to {@link describe}.
   * @param key - viewing key.
   */
  viewingId(key: string): string {
    const id = viewingSessionId(this.options.characterId, key)
    this.viewing.set(id, key)
    return id
  }

  /**
   * A known channel by key.
   * @returns the channel, or undefined when no adapter published it.
   */
  channel(key: string): PublishedChannel | undefined {
    for (const entry of this.channels.values()) if (entry.channelKey === key) return entry.channel
    return undefined
  }

  /** Conversation session id of a channel. */
  conversationId(channel: PublishedChannel): string {
    return conversationSessionId(this.options.characterId, channelKey(channel), this.options.conversationGeneration)
  }

  /** Known conversation sessions, for status. */
  known(): { sessionId: string; channel: PublishedChannel }[] {
    return [...this.channels].map(([sessionId, entry]) => ({ sessionId, channel: entry.channel }))
  }

  /**
   * Resolve a session, creating it only when no session has the id. Serialized
   * per id: DSH's create silently mints a new id when the named session has
   * already started a turn (DSH-INTEGRATION §6).
   */
  ensure(target: Route): Promise<A> {
    const previous = this.chains.get(target.sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.ensureNow(target))
    this.chains.set(target.sessionId, next)
    void next.finally(() => {
      if (this.chains.get(target.sessionId) === next) this.chains.delete(target.sessionId)
    }).catch(() => undefined)
    return next
  }

  private async ensureNow(target: Route): Promise<A> {
    const { sessionId } = target
    if (this.host.isArchived(sessionId)) {
      throw new AnimaError('anima/session-archived', `session ${sessionId} is archived; unarchive it in the DSH sidebar to let her use it again.`)
    }
    const existing = await this.host.resolve(sessionId)
    if (existing !== undefined) return existing
    const cwd = join(this.options.dataDir, CWD[target.kind])
    mkdirSync(cwd, { recursive: true })
    const created = await this.host.create(sessionId, { agentPreset: PRESETS[target.kind], cwd })
    if (created !== sessionId) {
      throw new AnimaError('anima/session-id-mismatch', `DSH created session ${created} instead of ${sessionId}. Report this; Anima relies on deterministic ids.`)
    }
    const agent = await this.host.resolve(sessionId)
    if (agent === undefined) throw new AnimaError('anima/session-missing', `session ${sessionId} was created but cannot be resolved.`)
    this.host.rename(agent, title(target))
    return agent
  }

  /** Ensure the Self session. */
  ensureSelf(): Promise<A> {
    return this.ensure({ kind: 'self', sessionId: this.selfId })
  }

  /**
   * Route a stimulus to its session and deliver it: as a waking message, or as
   * context for the next turn when it does not wake. A `channel-event` is
   * delivered only into an existing session.
   * @param before - called with the agent just before delivery (e.g. to select a model).
   * @param wake - overrides {@link wakes}.
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus, before?: (agent: A) => void, wake = wakes(stimulus)): Promise<string> {
    const target = route(this.options.characterId, stimulus, this.options.selfGeneration, this.options.conversationGeneration)
    if (target.kind === 'conversation' && !this.channels.has(target.sessionId)) this.know(target.channel)
    if (target.kind === 'triage') this.triage.set(target.sessionId, target.day)
    if (target.kind === 'consolidation') this.consolidation.set(target.sessionId, target.day)
    if (target.kind === 'group-triage') this.groupTriage.set(target.sessionId, target.day)
    if (target.kind === 'viewing') this.viewing.set(target.sessionId, target.title)
    let agent: A | undefined
    if (stimulus.type === 'channel-event') {
      if (this.host.isArchived(target.sessionId)) return target.sessionId
      agent = await this.host.resolve(target.sessionId)
      if (agent === undefined) return target.sessionId
    } else {
      agent = await this.ensure(target)
    }
    before?.(agent)
    let body = stimulusText(stimulus)
    if (wake && target.kind === 'conversation') {
      const tools = this.options.answerTools?.(target.channel)
      if (tools !== undefined) body = `${body}\n${answerLine(target.channel, tools.say, tools.ender)}`
    }
    const text = this.stamped(body)
    if (wake) await this.host.deliver(agent, text, stimulusSummary(stimulus), stimulus.type, stimulusRef(stimulus), stimulus.type === 'view' ? stimulus.parts : undefined)
    else await this.host.inject(agent, text, stimulusSummary(stimulus), stimulus.type)
    return target.sessionId
  }

  /** Prefix the clock stamp. */
  stamped(text: string): string {
    return this.options.stamp === undefined ? text : `[${this.options.stamp()}] ${text}`
  }

  /**
   * Resolve a live agent without creating anything.
   * @returns the agent, or undefined when the session does not exist yet.
   */
  find(sessionId: string): Promise<A | undefined> {
    return this.host.resolve(sessionId)
  }
}

function title(target: Route): string {
  switch (target.kind) {
    case 'self': return 'Anima · self'
    case 'triage': return `Anima · triage ${target.day}`
    case 'consolidation': return `Anima · memory ${target.day}`
    case 'group-triage': return `Anima · groups ${target.day}`
    case 'viewing': return `Anima · viewing ${target.title}`
    case 'conversation': return `Anima · ${target.channel.display}`
  }
}
