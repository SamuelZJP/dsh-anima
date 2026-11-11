/**
 * Her Bilibili login: QR login through the passport API, and the cookie file
 * `<dataDir>/bili/cookie.json` (mode 0600, never in the repo).
 * @module @anima/adapter-bili/login
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AnimaError } from '@anima/core'
import type { BiliClient } from './client.ts'
import { encodeQr, renderQr, type QrCode } from './qr.ts'

/** Saved login. */
export interface SavedLogin {
  cookies: Record<string, string>
  refreshToken?: string | undefined
  /** Real time of the login. */
  at: number
}

/** The cookie file. */
export class CookieStore {
  constructor(readonly path: string) {}

  read(): SavedLogin | undefined {
    if (!existsSync(this.path)) return undefined
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as SavedLogin
      return typeof value.cookies === 'object' && value.cookies !== null ? value : undefined
    } catch {
      throw new AnimaError('anima/bili-cookie-file', `${this.path} is not valid JSON. Delete it and log in again with /anima bili login.`)
    }
  }

  write(login: SavedLogin): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 })
    chmodSync(this.path, 0o600)
  }

  remove(): boolean {
    if (!existsSync(this.path)) return false
    rmSync(this.path)
    return true
  }
}

/** Login cookies Bilibili sets on a successful QR login. */
export const LOGIN_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'] as const

/** A QR login waiting for the scan. */
export interface PendingLogin {
  readonly url: string
  readonly key: string
  readonly qr: QrCode
  readonly text: string
}

/** Outcome of one poll. */
export type PollState = 'waiting' | 'scanned' | 'expired' | 'done'

/**
 * Start a QR login.
 * @returns the scan URL, its key and the QR.
 */
export async function startLogin(client: BiliClient): Promise<PendingLogin> {
  const body = await client.request<{ url: string; qrcode_key: string }>('/x/passport-login/web/qrcode/generate', {}, { origin: 'passport' })
  const { url, qrcode_key: key } = body.data ?? { url: '', qrcode_key: '' }
  if (url === '' || key === '') throw new AnimaError('anima/bili-error', 'the QR login endpoint returned no URL.')
  const qr = encodeQr(url)
  return { url, key, qr, text: renderQr(qr) }
}

/**
 * Poll a QR login once. On success the client's jar holds the login cookies
 * (from Set-Cookie, or the cross-domain URL as a fallback).
 * @returns the state and, when done, the refresh token.
 */
export async function pollLogin(client: BiliClient, key: string): Promise<{ state: PollState; refreshToken?: string }> {
  const body = await client.request<{ code: number; url?: string; refresh_token?: string; message?: string }>(
    '/x/passport-login/web/qrcode/poll', { qrcode_key: key }, { origin: 'passport' },
  )
  const data = body.data ?? { code: -1 }
  switch (data.code) {
    case 0: {
      if (data.url !== undefined && data.url !== '') {
        const params = new URL(data.url).searchParams
        const fallback: Record<string, string> = {}
        for (const name of LOGIN_COOKIES) {
          const value = params.get(name)
          if (value !== null && client.cookies()[name] === undefined) fallback[name] = value
        }
        if (Object.keys(fallback).length > 0) client.setCookies(fallback)
      }
      if (client.cookies().SESSDATA === undefined) throw new AnimaError('anima/bili-error', 'the login finished but no SESSDATA cookie came back.')
      return { state: 'done', ...data.refresh_token === undefined ? {} : { refreshToken: data.refresh_token } }
    }
    case 86101: return { state: 'waiting' }
    case 86090: return { state: 'scanned' }
    case 86038: return { state: 'expired' }
    default: throw new AnimaError('anima/bili-error', `QR login poll answered ${data.code}${data.message === undefined ? '' : ` (${data.message})`}.`)
  }
}

/**
 * The QR as an SVG with a white quiet zone: served to the browser by
 * `/anima bili login` and saved as a file. `crispEdges` keeps adjacent
 * modules from showing anti-aliased seams.
 */
export function qrSvg(qr: QrCode, scale = 8, quiet = 4): string {
  const size = (qr.size + quiet * 2) * scale
  const rects: string[] = []
  qr.modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) rects.push(`<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${scale}" height="${scale}"/>`)
  }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>\n`
}
