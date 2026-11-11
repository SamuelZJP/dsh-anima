/**
 * Bilibili web API client on built-in `fetch`: a cookie jar, WBI signing,
 * one request at a time with a minimum gap (transport pacing), and back-off
 * when Bilibili's risk control answers -352. Quotas on her behavior are the
 * gate's, not this client's.
 * @module @anima/adapter-bili/client
 */

import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AnimaError } from '@anima/core'
import { mixinKey, signQuery } from './wbi.ts'

/** Browser-like user agent; Bilibili refuses obvious bots. */
export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
/** Referer the play URLs and APIs expect. */
export const REFERER = 'https://www.bilibili.com/'

/** Origins, replaceable in tests. */
export interface Origins {
  readonly api: string
  readonly passport: string
  readonly www: string
}

export const ORIGINS: Origins = {
  api: 'https://api.bilibili.com',
  passport: 'https://passport.bilibili.com',
  www: 'https://www.bilibili.com',
}

/** Client options. */
export interface ClientOptions {
  readonly minGapMs: number
  readonly timeoutMs: number
  readonly backoffMs: number
  readonly maxBackoffMs: number
  readonly origins?: Origins
  readonly fetch?: typeof fetch
  /** Real clock (tests). */
  readonly now?: () => number
  /** Called when the jar changes (persist login cookies). */
  readonly onCookies?: (cookies: Readonly<Record<string, string>>) => void
}

/** Risk-control state, for status and her report. */
export interface RiskState {
  /** Real time until which requests are refused, or undefined. */
  until: number | undefined
  /** Times risk control answered. */
  hits: number
  lastAt: number | undefined
  lastPath: string | undefined
  /** Next back-off length. */
  nextMs: number
}

/** Who is logged in, from `nav`. */
export interface LoginInfo {
  readonly isLogin: boolean
  readonly uname?: string | undefined
  readonly mid?: number | undefined
}

interface Envelope<T> {
  code: number
  message?: string
  data?: T
}

/** Error codes the client throws. */
export const BiliCode = {
  risk: 'anima/bili-risk-control',
  login: 'anima/bili-login-needed',
  error: 'anima/bili-error',
  network: 'anima/bili-network',
  tooLarge: 'anima/bili-too-large',
} as const

/** Bilibili web API client. */
export class BiliClient {
  private readonly jar = new Map<string, string>()
  private chain: Promise<unknown> = Promise.resolve()
  private lastRequestAt = 0
  private mixin: { key: string; at: number } | undefined
  private readonly origins: Origins
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  /** Risk-control state. */
  readonly risk: RiskState
  /** Requests made and failed, for status. */
  readonly counts = { requests: 0, failures: 0 }
  /** Last login check. */
  login: LoginInfo & { checkedAt?: number } = { isLogin: false }

  constructor(private readonly options: ClientOptions) {
    this.origins = options.origins ?? ORIGINS
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.risk = { until: undefined, hits: 0, lastAt: undefined, lastPath: undefined, nextMs: options.backoffMs }
  }

  /** Absolute URL of a path on an origin. */
  url(path: string, origin: keyof Origins = 'api'): string {
    return `${this.origins[origin]}${path}`
  }

  // ---- cookies ----

  /** Replace or add cookies (login cookies from the store or a QR login). */
  setCookies(cookies: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(cookies)) this.jar.set(name, value)
    this.mixin = undefined
  }

  /** Drop the login cookies, keeping the device ids. */
  clearLogin(): void {
    for (const name of [...this.jar.keys()]) if (!['buvid3', 'buvid4', 'b_nut'].includes(name)) this.jar.delete(name)
    this.login = { isLogin: false }
    this.mixin = undefined
  }

  /** Current jar (copy). */
  cookies(): Record<string, string> {
    return Object.fromEntries(this.jar)
  }

  private cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private absorb(response: Response): void {
    const set = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    let changed = false
    for (const line of set) {
      const [pair = ''] = line.split(';')
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (this.jar.get(name) !== value) {
        this.jar.set(name, value)
        changed = true
      }
    }
    if (changed) this.options.onCookies?.(this.cookies())
  }

  // ---- transport ----

  /** Run one request after the previous one, at least `minGapMs` (plus jitter) later. */
  private paced<T>(work: () => Promise<T>): Promise<T> {
    const run = async () => {
      const gap = this.options.minGapMs * (1 + Math.random() * 0.5)
      const wait = this.lastRequestAt + gap - this.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      this.lastRequestAt = this.now()
      return work()
    }
    const next = this.chain.catch(() => undefined).then(run)
    this.chain = next
    return next
  }

  private refuseIfBackingOff(path: string): void {
    const until = this.risk.until
    if (until !== undefined && this.now() < until) {
      throw new AnimaError(BiliCode.risk, `Bilibili's risk control refused requests (code -352${this.risk.lastPath === undefined ? '' : ` on ${this.risk.lastPath}`}); Anima is backing off for about ${Math.ceil((until - this.now()) / 60_000)} min more. Do something else for now. (Asked: ${path})`)
    }
  }

  private trip(path: string): AnimaError {
    const now = this.now()
    this.risk.hits += 1
    this.risk.lastAt = now
    this.risk.lastPath = path
    this.risk.until = now + this.risk.nextMs
    const minutes = Math.ceil(this.risk.nextMs / 60_000)
    this.risk.nextMs = Math.min(this.risk.nextMs * 2, this.options.maxBackoffMs)
    return new AnimaError(BiliCode.risk, `Bilibili's risk control refused the request (code -352 on ${path}). Anima backs off for about ${minutes} min; do something else for now.`)
  }

  private async raw(url: string, init: { referer?: boolean; signal?: AbortSignal | undefined } = {}): Promise<Response> {
    const signal = init.signal === undefined ? AbortSignal.timeout(this.options.timeoutMs) : AbortSignal.any([init.signal, AbortSignal.timeout(this.options.timeoutMs)])
    this.counts.requests += 1
    try {
      const response = await this.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, ...init.referer === false ? {} : { Referer: REFERER }, ...this.jar.size === 0 ? {} : { Cookie: this.cookieHeader() } },
        signal,
      })
      this.absorb(response)
      return response
    } catch (error: unknown) {
      this.counts.failures += 1
      throw new AnimaError(BiliCode.network, `Bilibili did not answer (${error instanceof Error ? error.message : String(error)}).`)
    }
  }

  /** Get device ids (`buvid3`, `b_nut`) from the homepage once, as a browser would. */
  async ensureDevice(): Promise<void> {
    if (this.jar.has('buvid3')) return
    await this.paced(async () => {
      const response = await this.raw(`${this.origins.www}/`, { referer: false })
      await response.arrayBuffer()
    })
  }

  private async mixinKey(): Promise<string> {
    if (this.mixin !== undefined && this.now() - this.mixin.at < 3_600_000) return this.mixin.key
    await this.nav()
    if (this.mixin === undefined) throw new AnimaError(BiliCode.error, 'nav returned no WBI keys.')
    return this.mixin.key
  }

  /**
   * Read `nav`: who is logged in, and the WBI keys (present without login too).
   * @returns the login info.
   */
  async nav(): Promise<LoginInfo> {
    const body = await this.request<{ isLogin?: boolean; uname?: string; mid?: number; wbi_img?: { img_url: string; sub_url: string } }>(
      '/x/web-interface/nav', {}, { allowCodes: [-101] },
    )
    const data = body.data ?? {}
    if (data.wbi_img !== undefined) this.mixin = { key: mixinKey(data.wbi_img.img_url, data.wbi_img.sub_url), at: this.now() }
    this.login = { isLogin: data.isLogin === true, uname: data.uname, mid: data.mid, checkedAt: this.now() }
    return this.login
  }

  /**
   * GET a JSON API and check its envelope.
   * @param path - path on the API origin, or an absolute URL.
   * @param params - query parameters.
   * @param options.wbi - sign with WBI.
   * @param options.allowCodes - non-zero codes returned instead of thrown.
   * @param options.origin - `passport` for login endpoints.
   */
  async request<T>(path: string, params: Readonly<Record<string, string | number>> = {}, options: { wbi?: boolean; allowCodes?: readonly number[]; origin?: keyof Origins; signal?: AbortSignal } = {}): Promise<Envelope<T>> {
    this.refuseIfBackingOff(path)
    await this.ensureDevice()
    const query = options.wbi === true
      ? signQuery(params, await this.mixinKey())
      : new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString()
    const base = path.startsWith('http') ? path : `${this.origins[options.origin ?? 'api']}${path}`
    const url = query === '' ? base : `${base}${base.includes('?') ? '&' : '?'}${query}`
    return this.paced(async () => {
      this.refuseIfBackingOff(path)
      const response = await this.raw(url, { signal: options.signal })
      if (response.status === 412) throw this.trip(path)
      let body: Envelope<T>
      try {
        body = await response.json() as Envelope<T>
      } catch {
        this.counts.failures += 1
        throw new AnimaError(BiliCode.error, `${path} answered HTTP ${response.status} without JSON.`)
      }
      if (body.code === -352 || isVoucherOnly(body)) throw this.trip(path)
      if (body.code === 0 || options.allowCodes?.includes(body.code) === true) {
        this.risk.nextMs = this.options.backoffMs
        return body
      }
      this.counts.failures += 1
      if (body.code === -101) throw new AnimaError(BiliCode.login, `${path} needs her Bilibili login, and she is not logged in. The owner can log her in with /anima bili login.`)
      throw new AnimaError(BiliCode.error, `${path} answered code ${body.code}${body.message === undefined ? '' : ` (${body.message})`}.`)
    })
  }

  /**
   * GET a resource that is not an API envelope (danmaku XML, subtitle JSON).
   * @returns the body text.
   */
  async text(url: string, signal?: AbortSignal): Promise<string> {
    this.refuseIfBackingOff(url)
    await this.ensureDevice()
    return this.paced(async () => {
      const response = await this.raw(url.startsWith('//') ? `https:${url}` : url, { signal })
      if (response.status === 412) throw this.trip(url)
      if (!response.ok) {
        this.counts.failures += 1
        throw new AnimaError(BiliCode.error, `${url} answered HTTP ${response.status}.`)
      }
      return response.text()
    })
  }

  /**
   * Stream a file to disk, refusing more than `maxBytes`.
   * @returns bytes written.
   */
  async download(url: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<number> {
    this.refuseIfBackingOff('play stream')
    return this.paced(async () => {
      const response = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Referer: REFERER }, signal: signal ?? null })
      this.counts.requests += 1
      if (!response.ok || response.body === null) {
        this.counts.failures += 1
        throw new AnimaError(BiliCode.error, `the video stream answered HTTP ${response.status}.`)
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > maxBytes) {
        await response.body.cancel()
        throw new AnimaError(BiliCode.tooLarge, `the video stream is ${Math.round(declared / 1e6)} MB, more than the ${Math.round(maxBytes / 1e6)} MB cache allows.`)
      }
      let written = 0
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      source.on('data', (chunk: Buffer) => {
        written += chunk.length
        if (written > maxBytes) source.destroy(new AnimaError(BiliCode.tooLarge, `the video stream passed the ${Math.round(maxBytes / 1e6)} MB cache limit.`))
      })
      try {
        await pipeline(source, createWriteStream(path))
      } catch (error) {
        await unlink(path).catch(() => undefined)
        throw error
      }
      return written
    })
  }
}

/** A risk-control challenge disguised as success: `data` holds only `v_voucher`. */
export function isVoucherOnly(body: { code: number; data?: unknown }): boolean {
  if (body.code !== 0 || body.data === null || typeof body.data !== 'object') return false
  const keys = Object.keys(body.data)
  return keys.length > 0 && keys.every(key => key === 'v_voucher')
}
