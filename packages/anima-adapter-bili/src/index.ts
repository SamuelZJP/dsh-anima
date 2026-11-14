/**
 * Bilibili adapter (DESIGN §11), read-only. It registers `observe` behaviors
 * for her Self session in three tiers she chooses between: skim lists
 * (`bili_feed`, `bili_popular`, `bili_search`), a text watch digest
 * (`bili_watch`, `bili_comments`), and a close view through sampled frames
 * in a short viewing session (`bili_view_closely`). Every limit is the core
 * gate's. Her account logs in by QR (`/anima bili login`).
 * @module @anima/adapter-bili
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AnimaError, formatLocal, type BehaviorMeta, type Subcommand } from '@anima/core'
import type {} from '@anima/core'
import type { ExtraBlock } from '@anima/life'
import type {} from '@anima/life'
import type {} from '@anima/memory'
import { BiliApi, checkBvid, type Page, type VideoInfo } from './api.ts'
import { BiliClient, type ClientOptions } from './client.ts'
import { Config as ConfigSchema, resolveBiliConfig, type Config as BiliConfig, type ResolvedBiliConfig } from './config.ts'
import { formatDuration, plain, subtitleAt, videoLine, watchDigest, type TimedText } from './digest.ts'
import { checkFfmpeg, extractFrames, pickSpread } from './frames.ts'
import { CookieStore, pollLogin, qrSvg, startLogin } from './login.ts'

export { BiliApi, checkBvid, countText, type Page, type Subtitles, type VideoInfo } from './api.ts'
export { BiliClient, BiliCode, isVoucherOnly, ORIGINS, REFERER, USER_AGENT, type ClientOptions, type LoginInfo, type Origins, type RiskState } from './client.ts'
export { resolveBiliConfig, type ResolvedBiliConfig } from './config.ts'
export * from './digest.ts'
export { checkFfmpeg, extractFrames, ffmpegArgs, pickSpread, type ExtractOptions, type Frame } from './frames.ts'
export { CookieStore, LOGIN_COOKIES, pollLogin, qrSvg, startLogin, type PendingLogin, type PollState, type SavedLogin } from './login.ts'
export { encodeQr, renderQr, type QrCode } from './qr.ts'
export { mixinKey, signQuery } from './wbi.ts'

/** Cordis plugin name. */
export const name = 'anima-adapter-bili'
/** Services used by the plugin (`attachments` and `animaMemory` are used when present). */
export const inject = ['anima', 'animaLife', 'tools']

/** Platform id and tool prefix. */
export const PLATFORM = 'bili'

/** Plugin config. */
export type Config = BiliConfig
/** Plugin config schema. */
export const Config = ConfigSchema

/** Test seams. */
export interface BiliOptions {
  readonly config?: Partial<Config> | undefined
  readonly client?: Partial<ClientOptions>
}

const QR_POLL_MS = 2000

/** The part of DSH's webserver (`ctx.webServer`) the login QR uses; optional. */
interface WebServerLike {
  getOrigin(): string
  register(route: { kind: 'exact'; path: string; resource: (request: Request) => Promise<Response> }): () => void
}
const QR_WAIT_MS = 180_000

/**
 * Register the Bilibili adapter.
 * @param ctx - root context.
 * @param input - plugin config, or `{ config, client }` in tests.
 */
export function apply(ctx: Context, input: Partial<Config> | BiliOptions | undefined): void {
  const options: BiliOptions = input !== undefined && ('config' in input || 'client' in input) ? input as BiliOptions : { config: input as Partial<Config> | undefined }
  const config = resolveBiliConfig(options.config)
  const core = ctx.anima
  const life = ctx.animaLife
  const dir = join(core.config.dataDir, 'bili')
  const cacheDir = join(dir, 'cache')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Files from an interrupted view are never needed again.
  rmSync(cacheDir, { recursive: true, force: true })
  mkdirSync(cacheDir, { recursive: true })
  const ffmpegVersion = config.closeView.enabled ? checkFfmpeg(config.ffmpegPath) : undefined

  const store = new CookieStore(join(dir, 'cookie.json'))
  const saved = store.read()
  let refreshToken = saved?.refreshToken
  const client = new BiliClient({
    minGapMs: config.minGapMs,
    timeoutMs: config.requestTimeoutSeconds * 1000,
    backoffMs: config.backoffSeconds * 1000,
    maxBackoffMs: config.maxBackoffSeconds * 1000,
    ...options.client,
    onCookies: (cookies) => {
      // Keep refreshed login cookies; anonymous device ids need no file.
      if (cookies.SESSDATA !== undefined) store.write({ cookies, refreshToken, at: Date.now() })
    },
  })
  if (saved !== undefined) client.setCookies(saved.cookies)
  const api = new BiliApi(client)
  const counts = { views: 0, viewsFailed: 0, watched: 0 }
  const login = { pending: undefined as undefined | { key: string; until: number; svg: string }, lastResult: undefined as string | undefined }
  let disposed = false
  let qrRoute: (() => Promise<void>) | undefined
  ctx.effect(() => () => { disposed = true }, 'anima-adapter-bili.lifetime')

  // Learn whether the saved login still works; failures only show in status.
  void client.nav().catch((error: unknown) => ctx.logger.warn(`anima bili: login check failed: ${message(error)}`))

  const observe = (text: string, memory?: { importance: number }) => {
    const memoryService = ctx.get('animaMemory')
    if (memoryService === undefined) return undefined
    return memoryService.observe({ text, scope: 'public', source: 'bili', ...memory === undefined ? {} : { memory: { kind: 'episode', importance: memory.importance } } })
  }

  const skim: Omit<BehaviorMeta, 'effect'> & { effect: 'observe' } = { platform: PLATFORM, effect: 'observe', sessions: ['self'], modes: ['day'] }
  const listOutput = {
    schema: {
      type: 'object' as const, additionalProperties: false as const,
      properties: {
        lines: { type: 'array' as const, items: { type: 'string' as const }, required: true as const, description: 'One line per video.' },
        next: { type: 'string' as const, description: 'Cursor for the next page.' },
      },
    },
    render: (_args: unknown, value: { lines: string[]; next?: string }) => [{ type: 'text' as const, text: `${value.lines.length === 0 ? 'Nothing here.' : value.lines.join('\n')}${value.next === undefined ? '' : `\n(more: pass page "${value.next}")`}` }],
  }
  const lines = (page: Page) => ({ lines: page.items.map(item => videoLine(item)), ...page.next === undefined ? {} : { next: page.next } })
  const pageNumber = (page: string | undefined) => {
    const n = Number(page ?? '1')
    return Number.isInteger(n) && n >= 1 ? n : 1
  }

  core.registerBehavior(defineTool({
    name: 'bili_feed',
    description: 'Skim new videos from uploaders you follow on Bilibili (needs your login). One line per video: bvid, title, uploader, length, counts, a short description. Cheap. Pass `page` from a previous result for more.',
    parameters: { page: { type: 'string', description: 'Cursor from the previous result; omit for the newest.' } },
    output: listOutput,
    execute: async args => lines(await api.feed(args.page, config.listSize)),
  }), skim)

  core.registerBehavior(defineTool({
    name: 'bili_popular',
    description: 'Skim what is popular on Bilibili now. One line per video: bvid, title, uploader, length, counts, a short description. Cheap.',
    parameters: { page: { type: 'string', description: 'Page number, default 1.' } },
    output: listOutput,
    execute: async args => lines(await api.popular(pageNumber(args.page), config.listSize)),
  }), skim)

  core.registerBehavior(defineTool({
    name: 'bili_search',
    description: 'Search Bilibili videos. One line per video: bvid, title, uploader, length, counts, a short description. Cheap.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to search for, in any language.' },
      page: { type: 'string', description: 'Page number, default 1.' },
    },
    output: listOutput,
    execute: async (args) => {
      if (args.query.trim() === '') throw new AnimaError('anima/bad-args', 'query is empty.')
      return lines(await api.search(args.query.trim(), pageNumber(args.page), config.listSize))
    },
  }), skim)

  const textOutput = {
    schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const, description: 'The digest.' } } },
    render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
  }

  core.registerBehavior(defineTool({
    name: 'bili_watch',
    description: 'Watch a Bilibili video as text: its details, then what is said (subtitles, when it has them), a sample of danmaku across the video, and the top comments. You do not see the picture; for that use bili_view_closely, which is rarer. You remember what you watched.',
    parameters: { bvid: { type: 'string', required: true, description: 'The video\'s bvid, e.g. BV1xx411c7mD.' } },
    output: textOutput,
    execute: async (args) => {
      const info = await api.view(checkBvid(args.bvid))
      const [subtitles, danmaku, comments] = [await soft(api.subtitles(info), { lines: [] as TimedText[], note: 'could not load' }), await soft(api.danmaku(info), []), await soft(api.comments(info, undefined), { items: [] })]
      counts.watched += 1
      observe(`You watched ${info.bvid} «${plain(info.title)}» by ${plain(info.author)} (${formatDuration(info.durationSeconds)}, ${info.category ?? 'video'}) on Bilibili.`)
      return { text: watchDigest({ item: info, subtitles: subtitles.lines, subtitleNote: subtitles.note, danmaku, comments: comments.items, caps: config.digest }) }
    },
  }), skim)

  core.registerBehavior(defineTool({
    name: 'bili_comments',
    description: 'Read more of the discussion under a Bilibili video, hot comments first. Pass `page` from a previous result for more.',
    parameters: {
      bvid: { type: 'string', required: true, description: 'The video\'s bvid.' },
      page: { type: 'string', description: 'Cursor from the previous result.' },
    },
    output: textOutput,
    execute: async (args) => {
      const info = await api.view(checkBvid(args.bvid))
      const { items, next } = await api.comments(info, args.page)
      const body = items.length === 0 ? 'No comments here.' : items.map(c => `- ${plain(c.author)} (${c.likes} likes${c.replies ? `, ${c.replies} replies` : ''}): ${plain(c.text)}`).join('\n')
      return { text: `Comments on ${info.bvid} «${plain(info.title)}»:\n${body}${next === undefined ? '' : `\n(more: pass page "${next}")`}` }
    },
  }), skim)

  if (config.closeView.enabled) {
    core.registerBehavior(defineTool({
      name: 'bili_view_closely',
      description: `Look closely at a Bilibili video: you see ${config.closeView.framesPerView} frames sampled across it (at scene changes), each with what was being said then, and write a viewing note. No sound. Your most expensive way to watch: only a few per day, for shorter videos you really want to see. Say in \`focus\` what you want to look at. You remember the note.`,
      parameters: {
        bvid: { type: 'string', required: true, description: 'The video\'s bvid.' },
        focus: { type: 'string', description: 'What you want to look at or find out, in your own words.' },
      },
      output: textOutput,
      execute: async (args, exec) => {
        const info = await api.view(checkBvid(args.bvid))
        try {
          const note = await closeView(info, args.focus, exec.signal)
          counts.views += 1
          observe(`You looked closely at ${info.bvid} «${plain(info.title)}» by ${plain(info.author)} on Bilibili. Your viewing note: ${note}`, { importance: 0.5 })
          return { text: `Your viewing note on ${info.bvid} «${plain(info.title)}»:\n${note}` }
        } catch (error) {
          counts.viewsFailed += 1
          throw error
        }
      },
    }), {
      ...skim,
      // Checked by the gate against the owner's limits before anything is downloaded.
      facts: async args => ({ durationSeconds: (await api.view(checkBvid(String(args.bvid ?? '')))).durationSeconds, frames: config.closeView.framesPerView }),
    })
  }

  /** Download, extract frames, run the viewing session, clean up. */
  async function closeView(info: VideoInfo, focus: string | undefined, signal: AbortSignal | undefined): Promise<string> {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new AnimaError('anima/no-attachments', 'DSH has no attachment service, so frames cannot be shown to a model.')
    const stream = await api.playUrl(info, config.quality)
    const maxBytes = config.cache.maxMegabytes * 1e6 - dirBytes(cacheDir)
    if (stream.bytes > maxBytes) throw new AnimaError('anima/bili-too-large', `this video's stream is ${Math.round(stream.bytes / 1e6)} MB, more than the ${config.cache.maxMegabytes} MB cache allows now. Pick a shorter one.`)
    const work = mkdtempSync(join(cacheDir, `${info.bvid}-`))
    try {
      const video = join(work, 'video.mp4')
      await client.download(stream.url, video, maxBytes, signal)
      const subtitles = await soft(api.subtitles(info), { lines: [] as TimedText[], note: 'could not load' })
      const k = config.closeView.framesPerView
      const candidates = await extractFrames({
        ffmpeg: config.ffmpegPath, input: video, outDir: work, everySeconds: config.closeView.fallbackEverySeconds,
        sceneThreshold: config.closeView.sceneThreshold, width: config.closeView.frameWidth, maxCandidates: k * 4, signal,
      })
      const frames = pickSpread(candidates, k)
      if (frames.length === 0) throw new AnimaError('anima/ffmpeg-failed', 'no frames came out of the video.')
      const parts: ExtraBlock[] = []
      for (const [index, frame] of frames.entries()) {
        const said = subtitleAt(subtitles.lines, frame.t)
        parts.push({ type: 'text', text: `Frame ${index + 1} of ${frames.length}, at ${formatDuration(frame.t)}${said === undefined ? '' : ` — said: "${said}"`}` })
        const ref = await attachments.saveImage({ data: readFileSync(frame.file), mediaType: 'image/jpeg', name: `${info.bvid}-${index + 1}.jpg` })
        parts.push({ type: 'image', attachment: ref })
      }
      const text = [
        `You chose to look closely at ${info.bvid} «${plain(info.title)}» by ${plain(info.author)} (${formatDuration(info.durationSeconds)}${info.category === undefined ? '' : `, ${info.category}`}).`,
        `What you wanted to look at: ${focus === undefined || focus.trim() === '' ? '(nothing in particular)' : focus.trim()}`,
        `Description: ${plain(info.description).slice(0, 300) || '(none)'}`,
        `Subtitles: ${subtitles.note}. Frames follow in time order (${frames.length} of ${candidates.length} candidates, ${stream.quality === 16 ? '360p' : `quality ${stream.quality}`}).`,
        'When you have looked, call viewing_note(note).',
      ].join('\n')
      return await life.view({
        key: `bili:${info.bvid}:${Date.now().toString(36)}`, title: plain(info.title).slice(0, 40), text, parts,
        model: config.closeView.model, timeoutSeconds: config.closeView.timeoutSeconds, ...signal === undefined ? {} : { signal },
      })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // ---- login commands ----

  // Offered to the owner from outside: the guard registers platform subcommands and actions.
  const biliCommand: Subcommand = {
    name: 'bili',
    usage: 'bili login | bili status | bili logout — her Bilibili account (QR login)',
    run: async (args) => {
      const verb = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      switch (verb) {
        case 'login': return loginCommand()
        case 'logout': {
          const { removed } = logout()
          return { kind: 'success', text: removed ? 'Logged out: her Bilibili cookies are deleted.' : 'She was not logged in.' }
        }
        case '':
        case 'status': {
          const info = await soft(client.nav(), undefined)
          return { kind: 'success', text: [...statusLines(), ...info === undefined ? ['Bilibili: the login check failed just now.'] : []].join('\n') }
        }
        default: return { kind: 'error', text: 'Usage: /anima bili login | status | logout' }
      }
    },
  }

  /** Delete her Bilibili cookies. */
  function logout(): { removed: boolean } {
    const removed = store.remove()
    client.clearLogin()
    refreshToken = undefined
    return { removed }
  }

  /**
   * Start a QR login (command and page share it).
   * @param serve - also serve the QR on a one-time link (the command's way; the page shows it inline).
   * @throws {AnimaError} `anima/bili-login-pending` while one waits.
   */
  async function beginLogin(serve: boolean): Promise<{ svg: string; svgPath: string; text: string; link: string | undefined; expiresAt: number }> {
    if (login.pending !== undefined && Date.now() < login.pending.until) throw new AnimaError('anima/bili-login-pending', 'A QR login is already waiting; scan it, or wait for it to expire (3 min).')
    const pending = await startLogin(client)
    const svgText = qrSvg(pending.qr)
    const svg = join(dir, 'login-qr.svg')
    writeFileSync(svg, svgText, { mode: 0o600 })
    login.pending = { key: pending.key, until: Date.now() + QR_WAIT_MS, svg: svgText }
    login.lastResult = 'waiting for the scan'
    const link = serve ? serveQr(svgText) : undefined
    ctx.logger.info(`anima bili: scan this QR with the Bilibili app on her account (also saved as ${svg}${link === undefined ? '' : ` and served at ${link}`}):\n${pending.text}`)
    void pollUntilDone(pending.key)
    return { svg: svgText, svgPath: svg, text: pending.text, link, expiresAt: login.pending.until }
  }

  // Owner surface shared with the Anima page (DESIGN §12). Cookies are never shown.
  core.providePlatform({
    platform: 'bili',
    title: 'Bilibili',
    view: () => {
      const { risk, login: who } = client
      const backingOff = risk.until !== undefined && Date.now() < risk.until
      const waiting = login.pending !== undefined && Date.now() < login.pending.until
      return {
        health: backingOff ? 'warn' : who.isLogin ? 'ok' : 'off',
        summary: statusLines()[0]!.replace(/^Bilibili: /, ''),
        details: {
          loggedIn: who.isLogin,
          uname: who.uname ?? null,
          mid: who.mid ?? null,
          lastLogin: login.lastResult ?? null,
          pendingQr: waiting ? { svg: login.pending!.svg, expiresAt: login.pending!.until } : null,
          risk: { backingOffUntil: backingOff ? risk.until : null, hits: risk.hits, lastPath: risk.lastPath ?? null },
          traffic: { requests: client.counts.requests, failures: client.counts.failures, ...counts },
          closeView: config.closeView.enabled,
        },
      }
    },
    actions: {
      login: async () => {
        const started = await beginLogin(false)
        return { svg: started.svg, expiresAt: started.expiresAt }
      },
      logout: () => logout(),
      'login-link': () => beginLogin(true),
    },
    subcommands: [biliCommand],
  })

  async function loginCommand() {
    let started: Awaited<ReturnType<typeof beginLogin>>
    try {
      started = await beginLogin(true)
    } catch (error: unknown) {
      return { kind: 'error' as const, text: message(error).replace(/^anima\/bili-login-pending: /, '') }
    }
    const { svgPath: svg, link, text: qrText } = started
    const head = 'Scan the QR with the Bilibili app, logged in to HER account, and confirm on the phone. It expires in 3 minutes.'
    const tail = 'Check the result with /anima bili status.'
    // The web UI shows command output as short, line-spaced plain text, where a
    // text QR cannot scan; a page the browser renders as an image can.
    if (link !== undefined) return { kind: 'success' as const, text: [head, `Open this in your browser: ${link}`, `(Also saved as ${svg}.) ${tail}`].join('\n') }
    return { kind: 'success' as const, text: [head, qrText, `If it does not scan, open ${svg} instead. ${tail}`].join('\n') }
  }

  /**
   * Serve the pending QR on DSH's webserver, when this host has one, at a
   * one-time random path that lives only while the login waits.
   * @returns the absolute link, or undefined without a webserver.
   */
  function serveQr(svgText: string): string | undefined {
    const web = (ctx.get as (name: string) => unknown)('webServer') as WebServerLike | undefined
    if (web === undefined) return undefined
    stopServingQr()
    try {
      const path = `/anima/bili/qr/${randomBytes(16).toString('hex')}.svg`
      const origin = web.getOrigin()
      qrRoute = ctx.effect(() => web.register({
        kind: 'exact',
        path,
        resource: async () => new Response(svgText, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } }),
      }), 'anima-adapter-bili.login-qr')
      return `${origin}${path}`
    } catch (error: unknown) {
      ctx.logger.warn(`anima bili: could not serve the login QR: ${message(error)}`)
      return undefined
    }
  }

  function stopServingQr(): void {
    const off = qrRoute
    qrRoute = undefined
    if (off !== undefined) void off()
  }

  async function pollUntilDone(key: string): Promise<void> {
    while (!disposed && login.pending?.key === key && Date.now() < login.pending.until) {
      await new Promise(resolve => setTimeout(resolve, QR_POLL_MS))
      if (disposed || login.pending?.key !== key) return
      try {
        const result = await pollLogin(client, key)
        if (result.state === 'scanned') login.lastResult = 'scanned; waiting for confirmation on the phone'
        if (result.state === 'expired') break
        if (result.state === 'done') {
          refreshToken = result.refreshToken
          store.write({ cookies: client.cookies(), refreshToken, at: Date.now() })
          const info = await soft(client.nav(), undefined)
          login.lastResult = `logged in${info?.uname === undefined ? '' : ` as ${info.uname} (${info.mid})`} at ${new Date().toLocaleTimeString()}`
          ctx.logger.info(`anima bili: ${login.lastResult}`)
          login.pending = undefined
          stopServingQr()
          rmSync(join(dir, 'login-qr.svg'), { force: true })
          return
        }
      } catch (error: unknown) {
        login.lastResult = `poll failed: ${message(error)}`
      }
    }
    if (login.pending?.key === key) {
      login.pending = undefined
      stopServingQr()
      login.lastResult = 'the QR expired before it was confirmed; run /anima bili login again'
    }
  }

  // ---- status and report ----

  function statusLines(): string[] {
    const { risk, login: who } = client
    const backingOff = risk.until !== undefined && Date.now() < risk.until
    return [
      `Bilibili: ${who.isLogin ? `logged in as ${who.uname ?? '?'} (${who.mid ?? '?'})` : 'not logged in (feed and some subtitles need /anima bili login)'}${who.checkedAt === undefined ? '' : `, checked ${formatAgo(who.checkedAt)}`}${login.lastResult === undefined ? '' : `; last login: ${login.lastResult}`}`,
      `Bilibili risk control: ${backingOff ? `BACKING OFF until ${new Date(risk.until!).toLocaleTimeString()} after code -352 on ${risk.lastPath}` : risk.hits === 0 ? 'never hit' : `hit ${risk.hits}× (last ${formatAgo(risk.lastAt!)} on ${risk.lastPath}); not backing off now`}`,
      `Bilibili traffic: ${client.counts.requests} requests, ${client.counts.failures} failed; watched ${counts.watched}, close views ${counts.views} (${counts.viewsFailed} failed); cache ${Math.round(dirBytes(cacheDir) / 1e6)} of ${config.cache.maxMegabytes} MB`,
      `Bilibili close views: ${config.closeView.enabled ? `${config.closeView.framesPerView} frames on ${config.closeView.model.provider}/${config.closeView.model.model}; ${ffmpegVersion ?? ''}` : 'off'}`,
    ]
  }
  core.addStatus(statusLines)
  life.addReportLine(() => {
    const report: string[] = []
    if (client.risk.until !== undefined && Date.now() < client.risk.until) report.push(`Bilibili's risk control is refusing requests; Anima backs off until about ${formatLocal(core.clock.now() + (client.risk.until - Date.now()) * core.clock.speed)}. Browse later.`)
    else {
      report.push(`Bilibili: from your Self session you can skim (bili_feed, bili_popular, bili_search), watch a video as text (bili_watch), or look closely at one through its frames (bili_view_closely, only a few a day).${client.login.isLogin || client.login.checkedAt === undefined ? '' : ' You are not logged in, so your feed is unavailable.'}`)
    }
    return report
  })
}

/** Resolve to a fallback instead of failing (an optional digest section). */
async function soft<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch {
    return fallback
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000)
  return s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** Bytes of all files under a directory. */
function dirBytes(path: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
    }
  } catch {
    return 0
  }
  return total
}
