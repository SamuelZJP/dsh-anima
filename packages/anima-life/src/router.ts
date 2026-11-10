/**
 * Get-or-create of Anima sessions and stimulus delivery, over a small
 * {@link SessionHost} so the logic is testable without a DSH host.
 * @module @anima/life/router
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AnimaError, channelKey, type SessionInfo, type SessionKind } from '@anima/core'
import { route, stimulusRef, stimulusSummary, stimulusText, type PublishedChannel, type Route, type Stimulus } from './stimulus.ts'
import { conversationSessionId, selfSessionId, triageSessionId } from './identity.ts'

/** Preset ids of the session kinds (bundle/presets/*.patch.yml). */
export const PRESETS: Record<SessionKind, string> = {
  conversation: 'anima-conversation',
  self: 'anima-self',
  triage: 'anima-triage',
}

const CWD: Record<SessionKind, string> = { conversation: 'conversations', self: 'workspace', triage: 'triage' }

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
  deliver(agent: A, text: string, summary: string, stimulus: Stimulus['type'], ref?: string): Promise<void>
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
  readonly dataDir: string
  /** Clock stamp prefixed to every delivered stimulus, e.g. `Tue 2026-11-10 08:12`. */
  readonly stamp?: () => string
}

/** Routes stimuli to deterministic sessions and remembers which id is which channel. */
export class SessionRouter<A extends HostAgent = HostAgent> {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly channels = new Map<string, { channel: PublishedChannel; channelKey: string }>()
  private readonly triage = new Map<string, string>()

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
    const sessionId = conversationSessionId(this.options.characterId, key)
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
   * A known channel by key.
   * @returns the channel, or undefined when no adapter published it.
   */
  channel(key: string): PublishedChannel | undefined {
    for (const entry of this.channels.values()) if (entry.channelKey === key) return entry.channel
    return undefined
  }

  /** Conversation session id of a channel. */
  conversationId(channel: PublishedChannel): string {
    return conversationSessionId(this.options.characterId, channelKey(channel))
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
    this.host.rename(agent, target.kind === 'self' ? 'Anima · self' : target.kind === 'triage' ? `Anima · triage ${target.day}` : `Anima · ${target.channel.display}`)
    return agent
  }

  /** Ensure the Self session. */
  ensureSelf(): Promise<A> {
    return this.ensure({ kind: 'self', sessionId: this.selfId })
  }

  /**
   * Route a stimulus to its session and deliver it as a waking message.
   * @param before - called with the agent just before delivery (e.g. to select a model).
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus, before?: (agent: A) => void): Promise<string> {
    const target = route(this.options.characterId, stimulus, this.options.selfGeneration)
    if (target.kind === 'conversation' && !this.channels.has(target.sessionId)) this.know(target.channel)
    if (target.kind === 'triage') this.triage.set(target.sessionId, target.day)
    const agent = await this.ensure(target)
    before?.(agent)
    await this.host.deliver(agent, this.stamped(stimulusText(stimulus)), stimulusSummary(stimulus), stimulus.type, stimulusRef(stimulus))
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
