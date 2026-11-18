/**
 * OneBot v11 client over a forward WebSocket, on Node's built-in `WebSocket`
 * (no dependency). One connection carries API calls (`{ action, params, echo }`)
 * and events. The access token goes in the standard `Authorization: Bearer`
 * header. It reconnects with backoff and treats lost heartbeats and
 * `bot_offline` notices as health signals.
 * @module @anima/adapter-qq/onebot/client
 */

import { AnimaError } from '@anima/core'
import type { Health } from '../backend.ts'
import type { OneBotEvent } from './types.ts'

/** Client options. */
export interface ClientOptions {
  readonly url: string
  readonly accessToken?: string | undefined
  readonly callTimeoutMs: number
  readonly maxBackoffMs: number
  /** Heartbeat intervals without a heartbeat before the connection counts as lost. */
  readonly heartbeatGrace: number
  /** First reconnect delay; 1 s by default. */
  readonly minBackoffMs?: number
  /** Called for every event. */
  readonly onEvent: (event: OneBotEvent) => void
  /** Called after each successful connect. */
  readonly onOpen?: () => void
  /** Called when health changes on an event (heartbeat, lifecycle, `bot_offline`). */
  readonly onHealth?: () => void
  /** Called when the connection closes. */
  readonly onClose?: (reason: string) => void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Handshake headers: the standard OneBot `Authorization: Bearer <token>`, so the
 * token never appears in a URL.
 * @param token - access token, if any.
 */
export function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` }
}

/**
 * Next reconnect delay: doubling from the minimum, capped.
 * @param attempt - consecutive failed attempts so far (0 for the first retry).
 */
export function backoff(attempt: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30))
}

/** A OneBot v11 forward-WebSocket client. */
export class OneBotClient {
  readonly health: Health = { state: 'idle', since: Date.now(), connects: 0 }
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private attempt = 0
  private stopped = true
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: ClientOptions) {}

  /** Start connecting (and keep reconnecting until stopped). */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  /** Close and stop reconnecting; pending calls fail. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.watchdog)
    this.socket?.close()
    this.socket = undefined
    this.setState('closed')
    this.failAll('the QQ adapter stopped')
  }

  /** Whether the WebSocket is open. */
  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /**
   * Call a OneBot action.
   * @returns the response `data`.
   * @throws AnimaError `anima/qq-offline`, `anima/qq-timeout` or `anima/qq-failed`.
   */
  call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AnimaError('anima/qq-offline', `QQ is not connected (${this.health.lastError ?? this.health.state}); ${action} was not sent.`))
    }
    const echo = `anima-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new AnimaError('anima/qq-timeout', `${action} got no answer within ${this.options.callTimeoutMs / 1000} s.`))
      }, this.options.callTimeoutMs)
      this.pending.set(echo, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  private setState(state: Health['state']): void {
    this.health.state = state
    this.health.since = Date.now()
  }

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')
    this.health.retryInMs = undefined
    let socket: WebSocket
    try {
      // Node's WebSocket takes handshake headers in its second argument (undici's WebSocketInit).
      socket = new WebSocket(this.options.url, { headers: authHeaders(this.options.accessToken) } as unknown as string[])
    } catch (error: unknown) {
      this.health.lastError = error instanceof Error ? error.message : String(error)
      this.scheduleRetry()
      return
    }
    this.socket = socket
    let failure: string | undefined
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.attempt = 0
      this.health.connects += 1
      this.health.lastError = undefined
      this.setState('open')
      this.options.onOpen?.()
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data))
    })
    socket.addEventListener('error', (event) => {
      if (this.socket !== socket) return
      const message = (event as unknown as { message?: string }).message
      failure = message === undefined || message === '' ? 'WebSocket error' : message
    })
    socket.addEventListener('close', (event) => {
      this.drop(socket, failure ?? `closed (${event.code}${event.reason === '' ? '' : ` ${event.reason}`})`)
    })
  }

  /** Forget a connection at once (closed, failed, or silent) and schedule a reconnect. */
  private drop(socket: WebSocket, reason: string): void {
    if (this.socket !== socket) return
    this.socket = undefined
    clearTimeout(this.watchdog)
    this.health.lastError = reason
    this.setState('closed')
    this.failAll(`the QQ connection closed: ${reason}`)
    this.options.onClose?.(reason)
    this.scheduleRetry()
    try {
      socket.close()
    } catch {
      // Already closing.
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const delay = backoff(this.attempt++, this.options.minBackoffMs ?? 1000, this.options.maxBackoffMs)
    this.health.retryInMs = delay
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private failAll(reason: string): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AnimaError('anima/qq-offline', reason))
      this.pending.delete(echo)
    }
  }

  private onMessage(raw: string): void {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof value.echo === 'string' && this.pending.has(value.echo)) {
      const pending = this.pending.get(value.echo)!
      this.pending.delete(value.echo)
      clearTimeout(pending.timer)
      if (value.status === 'ok' || value.retcode === 0) pending.resolve(value.data)
      else pending.reject(new AnimaError('anima/qq-failed', `OneBot refused the call (retcode ${String(value.retcode)}): ${String(value.wording ?? value.message ?? value.msg ?? 'no message')}.`))
      return
    }
    const event = value as OneBotEvent
    if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat') {
      this.health.lastHeartbeat = Date.now()
      if (event.status?.online !== undefined) this.health.online = event.status.online
      this.armWatchdog(typeof event.interval === 'number' ? event.interval : undefined)
    }
    if (event.post_type === 'notice' && event.notice_type === 'bot_offline') {
      this.health.online = false
      this.health.lastError = `bot offline${typeof event.message === 'string' ? `: ${event.message}` : ''}`
    }
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle' && event.sub_type === 'disable') this.health.online = false
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle' && (event.sub_type === 'enable' || event.sub_type === 'connect')) this.health.online ??= true
    if (event.post_type === 'meta_event' || (event.post_type === 'notice' && event.notice_type === 'bot_offline')) this.options.onHealth?.()
    try {
      this.options.onEvent(event)
    } catch {
      // A handler failure must not break the connection.
    }
  }

  private armWatchdog(intervalMs: number | undefined): void {
    clearTimeout(this.watchdog)
    if (intervalMs === undefined || intervalMs <= 0) return
    this.watchdog = setTimeout(() => {
      if (this.socket !== undefined) this.drop(this.socket, `heartbeat lost (none for ${Math.round(intervalMs * this.options.heartbeatGrace / 1000)} s)`)
    }, intervalMs * this.options.heartbeatGrace)
  }
}
