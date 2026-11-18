/**
 * An in-memory {@link QqBackend} for the adapter tests: no protocol, no socket.
 * Tests push QQ events, set answers per method, and read the calls it got.
 */

import { AnimaError } from '@anima/core'
import type { BackendHandlers, ChatKind, ForwardNode, Health, OutgoingSegment, QqBackend, QqEvent, QqMessage, QqSegment } from '../src/backend.ts'

/** One call the backend received. */
export interface BackendCall {
  readonly method: string
  readonly args: readonly unknown[]
}

/** Optional abilities a test can take away. */
export type Ability = 'message' | 'history' | 'image' | 'forward' | 'poke' | 'react' | 'markRead' | 'typing'

/** A fake QQ runtime. */
export class FakeBackend implements QqBackend {
  readonly name = 'fake QQ backend'
  readonly health: Health = { state: 'idle', since: Date.now(), connects: 0 }
  readonly calls: BackendCall[] = []
  /** Friends and groups the account has. */
  friendList: { userId: string; name?: string }[] = []
  groupList: { groupId: string; name?: string }[] = []
  /** The account the runtime is logged in as. */
  loggedInAs: string
  private handlers: BackendHandlers | undefined
  private readonly answers = new Map<string, (...args: never[]) => unknown>()
  private seq = 9000

  message?: QqBackend['message']
  history?: QqBackend['history']
  image?: QqBackend['image']
  forward?: QqBackend['forward']
  poke?: QqBackend['poke']
  react?: QqBackend['react']
  markRead?: QqBackend['markRead']
  typing?: QqBackend['typing']

  /**
   * @param account - the account it is logged in as.
   * @param without - abilities it lacks.
   */
  constructor(account: string, without: readonly Ability[] = []) {
    this.loggedInAs = account
    const optional = {
      message: async (messageId: string) => this.call('message', [messageId], () => undefined) as Promise<QqMessage | undefined>,
      history: async (kind: ChatKind, chatId: string, count: number) => this.call('history', [kind, chatId, count], () => []) as Promise<QqMessage[]>,
      image: async (file: string) => this.call('image', [file], () => ({})) as Promise<{ bytes?: Uint8Array; url?: string }>,
      forward: async (id: string) => this.call('forward', [id], () => []) as Promise<ForwardNode[]>,
      poke: async (kind: ChatKind, chatId: string, userId: string) => { await this.call('poke', [kind, chatId, userId]) },
      react: async (messageId: string, emoji: string) => { await this.call('react', [messageId, emoji]) },
      markRead: async (kind: ChatKind, chatId: string) => { await this.call('markRead', [kind, chatId]) },
      typing: async (userId: string) => { await this.call('typing', [userId]) },
    }
    for (const [key, fn] of Object.entries(optional)) if (!without.includes(key as Ability)) (this as Record<string, unknown>)[key] = fn
  }

  /** Set the answer of a method; throw inside it to fail the call. */
  respond(method: string, answer: (...args: never[]) => unknown): void {
    this.answers.set(method, answer)
  }

  /** Calls of one method. */
  callsOf(method: string): BackendCall[] {
    return this.calls.filter(call => call.method === method)
  }

  start(handlers: BackendHandlers): void {
    this.handlers = handlers
    this.connect()
  }

  stop(): void {
    this.handlers = undefined
    this.health.state = 'closed'
  }

  /** Connect (again), as the runtime accepting a connection. */
  connect(): void {
    this.health.state = 'open'
    this.health.connects += 1
    this.health.lastError = undefined
    this.health.since = Date.now()
    this.handlers?.open()
  }

  /** Lose the connection. */
  drop(reason = 'closed (1006)'): void {
    this.health.state = 'closed'
    this.health.lastError = reason
    this.handlers?.close(reason)
  }

  /** The account goes offline or comes back, per the runtime. */
  setOnline(online: boolean, reason?: string): void {
    this.health.online = online
    this.health.lastError = reason
    this.handlers?.health()
  }

  /** Push an event, as the runtime would. */
  push(event: QqEvent): void {
    this.handlers?.event(event)
  }

  /** Whether the adapter holds it started. */
  get started(): boolean {
    return this.handlers !== undefined
  }

  async login(): Promise<{ userId: string; nickname?: string }> {
    await this.call('login', [])
    return { userId: this.loggedInAs, nickname: 'Anima' }
  }

  async friends(): Promise<{ userId: string; name?: string }[]> {
    return this.call('friends', [], () => this.friendList) as Promise<{ userId: string; name?: string }[]>
  }

  async groups(): Promise<{ groupId: string; name?: string }[]> {
    return this.call('groups', [], () => this.groupList) as Promise<{ groupId: string; name?: string }[]>
  }

  async send(kind: ChatKind, chatId: string, segments: readonly OutgoingSegment[]): Promise<string> {
    return this.call('send', [kind, chatId, segments], () => String(++this.seq)) as Promise<string>
  }

  private async call(method: string, args: unknown[], fallback: () => unknown = () => undefined): Promise<unknown> {
    this.calls.push({ method, args })
    if (this.health.state !== 'open') throw new AnimaError('anima/qq-offline', `QQ is not connected; ${method} was not sent.`)
    const answer = this.answers.get(method)
    return answer === undefined ? fallback() : (answer as (...a: unknown[]) => unknown)(...args)
  }
}

/** A text message from someone. */
export function textMessage(kind: ChatKind, chatId: string, userId: string, text: string | QqSegment[], options: { messageId?: string; displayName?: string; time?: number } = {}): QqEvent {
  return {
    type: 'message',
    message: {
      kind, chatId, userId,
      displayName: options.displayName ?? userId,
      messageId: options.messageId ?? String(Math.floor(Math.random() * 1e6)),
      segments: typeof text === 'string' ? [{ type: 'text', text }] : text,
      ...options.time === undefined ? {} : { time: options.time },
    },
  }
}
