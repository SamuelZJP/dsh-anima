/**
 * The `animaLife` service: channel publication, stimulus delivery, the Self
 * session, and the session resolver it provides to the core gate.
 * @module @anima/life/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError } from '@anima/core'
import type {} from '@anima/core'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionRouter, type SessionHost } from './router.ts'
import type { PublishedChannel, Stimulus } from './stimulus.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaLife: AnimaLife
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A stimulus Anima delivered into one of her sessions. */
    'anima-stimulus': { kind: 'anima-stimulus'; stimulus: string } & ContextFormed
  }
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

  async deliver(agent: Agent, text: string, summary: string, stimulus: string): Promise<void> {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'anima-stimulus', stimulus, form: 'notice', summary: boundContextSummary(summary) },
    }))
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new AnimaError('anima/no-sessions', 'DSH session service is missing.')
    if (!(await sessions.flush(agent.session))) {
      throw new AnimaError('anima/delivery-not-durable', `session ${agent.id} did not accept the message durably.`)
    }
  }
}

/** Anima life service. */
export class AnimaLife extends Service {
  static inject = ['anima']

  /** Routing and session identity. */
  readonly router: SessionRouter<Agent>

  /**
   * @param ctx - root context.
   * @param host - session host; DSH's by default (tests pass a fake).
   */
  constructor(ctx: Context, host?: SessionHost<Agent>) {
    super(ctx, 'animaLife')
    const { characterId, dataDir } = ctx.anima.config
    this.router = new SessionRouter(host ?? new DshSessionHost(ctx), { characterId, dataDir })
    ctx.anima.provideSessions(id => this.router.describe(id))
    ctx.anima.addStatus(() => [
      `Self session: ${this.router.selfId}`,
      ...this.router.known().map(({ sessionId, channel }) => `Conversation ${channel.display}: ${sessionId}`),
    ])
    ctx.anima.addSubcommand({
      name: 'self',
      usage: 'self [text] — open her Self session; with text, deliver it there as an owner notice',
      run: async (args) => {
        if (args === '') {
          const agent = await this.router.ensureSelf()
          return { kind: 'success', text: `Self session: ${agent.id}. It shows in the sidebar after its first turn; use /anima self <text> to start one.` }
        }
        const id = await this.deliver({ type: 'notice', text: `The owner says: ${args}`, ts: Date.now() })
        return { kind: 'success', text: `Delivered to the Self session ${id}.` }
      },
    })
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
  deliver(stimulus: Stimulus): Promise<string> {
    return this.router.deliver(stimulus)
  }
}
