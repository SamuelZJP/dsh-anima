/**
 * Get-or-create of Anima sessions and stimulus delivery, over a small
 * {@link SessionHost} so the logic is testable without a DSH host.
 * @module @anima/life/router
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AnimaError, channelKey, type SessionInfo, type SessionKind } from '@anima/core'
import { route, stimulusSummary, stimulusText, type PublishedChannel, type Route, type Stimulus } from './stimulus.ts'
import { conversationSessionId, selfSessionId } from './identity.ts'

/** Preset ids of the two session kinds (bundle/presets/*.patch.yml). */
export const PRESETS: Record<SessionKind, string> = {
  conversation: 'anima-conversation',
  self: 'anima-self',
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
  deliver(agent: A, text: string, summary: string, stimulus: Stimulus['type']): Promise<void>
}

/** Options of a router. */
export interface RouterOptions {
  readonly characterId: string
  readonly dataDir: string
}

/** Routes stimuli to deterministic sessions and remembers which id is which channel. */
export class SessionRouter<A extends HostAgent = HostAgent> {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly channels = new Map<string, { channel: PublishedChannel; channelKey: string }>()

  constructor(private readonly host: SessionHost<A>, private readonly options: RouterOptions) {}

  /** Self session id. */
  get selfId(): string {
    return selfSessionId(this.options.characterId)
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
    const entry = this.channels.get(sessionId)
    return entry === undefined ? undefined : { kind: 'conversation', channel: entry.channel, channelKey: entry.channelKey }
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
    const cwd = join(this.options.dataDir, target.kind === 'self' ? 'workspace' : 'conversations')
    mkdirSync(cwd, { recursive: true })
    const created = await this.host.create(sessionId, { agentPreset: PRESETS[target.kind], cwd })
    if (created !== sessionId) {
      throw new AnimaError('anima/session-id-mismatch', `DSH created session ${created} instead of ${sessionId}. Report this; Anima relies on deterministic ids.`)
    }
    const agent = await this.host.resolve(sessionId)
    if (agent === undefined) throw new AnimaError('anima/session-missing', `session ${sessionId} was created but cannot be resolved.`)
    this.host.rename(agent, target.kind === 'self' ? 'Anima · self' : `Anima · ${target.channel.display}`)
    return agent
  }

  /** Ensure the Self session. */
  ensureSelf(): Promise<A> {
    return this.ensure({ kind: 'self', sessionId: this.selfId })
  }

  /**
   * Route a stimulus to its session and deliver it as a waking message.
   * @returns the target session id.
   */
  async deliver(stimulus: Stimulus): Promise<string> {
    const target = route(this.options.characterId, stimulus)
    if (target.kind === 'conversation' && !this.channels.has(target.sessionId)) this.know(target.channel)
    const agent = await this.ensure(target)
    await this.host.deliver(agent, stimulusText(stimulus), stimulusSummary(stimulus), stimulus.type)
    return target.sessionId
  }
}
