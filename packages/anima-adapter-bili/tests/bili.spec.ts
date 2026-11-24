import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { AnimaLife, type ExtraBlock, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as bili from '../src/index.ts'

const SHORT = 'BV1xx411c7mD'
const LONG = 'BV1LONG0000A'
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-bili-it-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface FakeAgent { id: string; inbox: { text: string; extra: readonly ExtraBlock[] }[] }

class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent>()
  onDeliver: (agent: FakeAgent) => void = () => {}
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string) { this.sessions.set(id, { id, inbox: [] }); return id }
  isArchived() { return false }
  async archive() { return 'archived' as const }
  async moveAlarms() { return 0 }
  rename() {}
  async deliver(agent: FakeAgent, { text, extra = [] }: { text: string; extra?: readonly ExtraBlock[] | undefined }) {
    agent.inbox.push({ text, extra })
    queueMicrotask(() => this.onDeliver(agent))
  }
  async inject() {}
  cancel() {}
  async readLog() { return [] }
  selectModel() {}
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** A fake Bilibili: the endpoints the adapter uses, with recorded paths. */
function fakeBilibili(video: string | undefined) {
  const seen: string[] = []
  const view = (bvid: string) => ({ bvid, aid: 11, cid: 22, title: bvid === SHORT ? '猫弹琴' : '三小时长视频', desc: 'a cat plays', duration: bvid === SHORT ? 20 : 1500, owner: { name: 'Mao' }, tname: '动物圈', stat: { view: 12345, like: 600, coin: 7, favorite: 8, reply: 9, danmaku: 3 }, pubdate: 1762700000, pages: [{ cid: 22, duration: bvid === SHORT ? 20 : 1500 }] })
  const handler = async (input: string | URL) => {
    const url = new URL(String(input))
    seen.push(url.pathname)
    switch (url.pathname) {
      case '/': return new Response('', { headers: { 'set-cookie': 'buvid3=dev; path=/' } })
      case '/x/web-interface/nav': return json({ code: -101, data: { isLogin: false, wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } })
      case '/x/web-interface/popular': return json({ code: 0, data: { list: [{ ...view(SHORT), duration: 20 }], no_more: true } })
      case '/x/web-interface/wbi/search/all/v2': return json({ code: 0, data: { numPages: 3, result: [{ result_type: 'user', data: [] }, { result_type: 'video', data: [{ bvid: SHORT, title: '<em class="keyword">猫</em>弹琴', author: 'Mao', duration: '0:20', play: 5, danmaku: 1, description: 'd' }] }] } })
      case '/x/polymer/web-dynamic/v1/feed/all': return json({ code: -101, message: '账号未登录' })
      case '/x/web-interface/view': return json({ code: 0, data: view(url.searchParams.get('bvid')!) })
      case '/x/player/wbi/v2': return json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: 'http://api.test/sub.json' }] } } })
      case '/sub.json': return new Response(JSON.stringify({ body: [{ from: 0, to: 4, content: '大家好' }, { from: 12, to: 16, content: '换一个画面' }] }))
      case '/x/v1/dm/list.so': return new Response('<i><d p="1.0,1,25,1,0,0,a,1,10">哈哈</d><d p="15.0,1,25,1,0,0,a,2,10">好看</d></i>')
      case '/x/v2/reply/wbi/main': return json({ code: 0, data: { replies: [{ member: { uname: 'fan' }, content: { message: '太可爱了' }, like: 42, rcount: 2 }], cursor: { is_end: true } } })
      case '/x/player/wbi/playurl': return json({ code: 0, data: { quality: 16, durl: [{ url: 'http://cdn.test/video.mp4', size: video === undefined ? 1 : statSync(video).size }] } })
      case '/video.mp4': return new Response(readFileSync(video!), { headers: { 'content-length': String(statSync(video!).size) } })
      default: return json({ code: -404, message: `no route ${url.pathname}` })
    }
  }
  return { seen, fetch: handler as unknown as typeof fetch }
}

async function setup(options: { core?: Record<string, unknown>; bili?: Record<string, unknown>; video?: string } = {}) {
  const dataDir = temp()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir, clock: { speed: 1, start: '2026-11-10T10:00' }, ...options.core })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  const saved: { name?: string; bytes: number }[] = []
  ctx.provide('attachments')
  ctx.set('attachments', { saveImage: async (input: { data: Uint8Array; name?: string }) => { saved.push({ name: input.name, bytes: input.data.length }); return { attachmentId: `a${saved.length}`, mediaType: 'image/jpeg', bytes: input.data.length, width: 160, height: 90 } } })
  const api = fakeBilibili(options.video)
  const fiber = await ctx.plugin(bili, {
    config: { minGapMs: 0, closeView: { enabled: hasFfmpeg, framesPerView: 4, fallbackEverySeconds: 5, frameWidth: 160 }, ...options.bili },
    client: { origins: { api: 'http://api.test', passport: 'http://passport.test', www: 'http://www.test' }, fetch: api.fetch },
  })
  await new Promise(resolve => setTimeout(resolve, 5))
  return { ctx, host, api, saved, fiber, dataDir, self: ctx.animaLife.waking.current! }
}

let n = 0
async function call(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const visible = [...toolSet.view(agent).keys()]
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`b${++n}`), name, arguments: args, agent, toolSet, signal })
    return { isError: result.isError, text: result.content.map(block => (block as { text?: string }).text ?? '').join(''), visible }
  } finally {
    toolSet.dispose()
  }
}

describe('Bilibili adapter', () => {
  it('offers its observe behaviors in her waking session, and never in a plain DSH session', async () => {
    const { ctx, self } = await setup()
    const popular = await call(ctx, self, 'bili_popular')
    expect(popular.visible).toEqual(expect.arrayContaining(['bili_feed', 'bili_popular', 'bili_search', 'bili_watch', 'bili_comments']))
    expect(popular.text).toBe(`${SHORT} «猫弹琴» — Mao · 0:20, 1.2万 views, 600 likes, 3 danmaku — a cat plays`)
    const inChat = await call(ctx, 'plain-dsh-session', 'bili_popular')
    expect(inChat.isError).toBe(true)
    expect(inChat.visible.filter((name: string) => name.startsWith('bili_'))).toEqual([])
  })

  it('searches with WBI and reports a missing login on the feed plainly', async () => {
    const { ctx, self, api } = await setup()
    const search = await call(ctx, self, 'bili_search', { query: '猫' })
    expect(search.text).toBe(`${SHORT} «猫弹琴» — Mao · 0:20, 5 views, 1 danmaku — d\n(more: pass page "2")`)
    expect(api.seen).toContain('/x/web-interface/nav')
    const feed = await call(ctx, self, 'bili_feed')
    expect(feed.text).toMatch(/^Error: anima\/bili-login-needed: .*\/anima bili login/)
  })

  it('watches as a text digest', async () => {
    const { ctx, self } = await setup()
    const watch = await call(ctx, self, 'bili_watch', { bvid: SHORT })
    expect(watch.text).toContain('# 猫弹琴 (BV1xx411c7mD)')
    expect(watch.text).toContain('## Subtitles (AI 中文（自动生成）)\n[0:00] 大家好 换一个画面')
    expect(watch.text).toContain('[0:15] 好看')
    expect(watch.text).toContain('- fan (42 likes, 2 replies): 太可爱了')
    expect(ctx.anima.selfState().needs.curiosity).toBeLessThan(0.3)
    const bad = await call(ctx, self, 'bili_watch', { bvid: 'not-a-bvid' })
    expect(bad.text).toMatch(/^Error: .*is not a bvid/)
  })

  it('uses the length of part 1 for multi-part videos', async () => {
    const { ctx, self } = await setup()
    const api = new bili.BiliApi(new bili.BiliClient({ minGapMs: 0, timeoutMs: 1000, backoffMs: 1, maxBackoffMs: 1, fetch: (async () => json({ code: 0, data: { bvid: SHORT, aid: 1, cid: 5, duration: 90000, pages: [{ cid: 5, duration: 300 }, { cid: 6, duration: 89700 }] } })) as typeof fetch }))
    ;(api.client as unknown as { setCookies(c: Record<string, string>): void }).setCookies({ buvid3: 'x' })
    expect(await api.view(SHORT)).toMatchObject({ durationSeconds: 300, parts: 2 })
    void ctx; void self
  })

  it('reports the facts of a close view before it runs, for limits kept outside', async () => {
    const { ctx, api } = await setup()
    const facts = await ctx.anima.behavior('bili_view_closely')!.facts!({ bvid: LONG })
    expect(facts).toMatchObject({ durationSeconds: 1500 })
    expect(api.seen).not.toContain('/x/player/wbi/playurl')
  })

  it.skipIf(!hasFfmpeg)('views closely: frames with subtitles go to a subagent; only the note comes back; files are deleted', async () => {
    const work = temp()
    const video = join(work, 'v.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=12', '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=10:duration=8', '-filter_complex', '[0][1]concat=n=2:v=1', '-pix_fmt', 'yuv420p', video])
    const { ctx, self, saved, dataDir } = await setup({ video })
    const started: { request: { parent: { id: string }; agentPreset: string; prompt: { type: string; text?: string }[] } }[] = []
    ctx.provide('subagents' as never)
    ctx.set('subagents' as never, {
      startActivation: async (spec: never) => {
        started.push(spec)
        return { result: Promise.resolve({ output: [{ type: 'text', text: 'Test patterns, then colour bars; the cat never shows up.' }], stopReason: 'completed' }), dispose: async () => {} }
      },
    } as never)
    const result = await call(ctx, self, 'bili_view_closely', { bvid: SHORT, focus: 'is there a cat' })
    expect(result.text).toBe('Your viewing note on BV1xx411c7mD «猫弹琴»:\nTest patterns, then colour bars; the cat never shows up.')
    const { request } = started[0]!
    expect(request.parent.id).toBe(self)
    expect(request.agentPreset).toBe('anima-viewing')
    const [first, ...parts] = request.prompt
    expect(first!.text).toContain('What you wanted to look at: is there a cat')
    expect(first!.text).toContain('Subtitles: AI 中文（自动生成）')
    expect(first!.text).toContain('write your viewing note in your own voice')
    const captions = parts.filter(block => block.type === 'text').map(block => block.text!)
    expect(captions[0]).toBe('Frame 1 of 4, at 0:00 — said: "大家好"')
    expect(captions.some(text => /at 0:12 — said: "换一个画面"/.test(text))).toBe(true)
    expect(parts.filter(block => block.type === 'image')).toHaveLength(4)
    expect(saved).toHaveLength(4)
    expect(readdirSync(join(dataDir, 'bili', 'cache'))).toEqual([])
  })

  it.each([false, true])('logs in by QR, stores the cookies 0600 and shows the login in status (webserver: %s)', async (withWeb) => {
    const dataDir = temp()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const routes = new Map<string, (request: Request) => Promise<Response>>()
    if (withWeb) {
      ctx.provide('webServer')
      ctx.set('webServer', {
        getOrigin: () => 'http://127.0.0.1:3080',
        register: (route: { path: string; resource: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.resource)
          return () => { routes.delete(route.path) }
        },
      })
    }
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
    await ctx.plugin(AnimaLife, { host: new FakeHost() as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
    let polls = 0
    let loggedIn = false
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/') return new Response('', { headers: { 'set-cookie': 'buvid3=dev' } })
      if (url.pathname === '/x/web-interface/nav') return json(loggedIn ? { code: 0, data: { isLogin: true, uname: '小鲸鱼', mid: 777, wbi_img: { img_url: 'a/b.png', sub_url: 'c/d.png' } } } : { code: -101, data: { isLogin: false } })
      if (url.pathname.endsWith('/qrcode/generate')) return json({ code: 0, data: { url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=k1', qrcode_key: 'k1' } })
      if (url.pathname.endsWith('/qrcode/poll')) {
        polls += 1
        if (polls < 2) return json({ code: 0, data: { code: 86090 } })
        loggedIn = true
        return new Response(JSON.stringify({ code: 0, data: { code: 0, url: 'https://x/?SESSDATA=fromurl&bili_jct=j', refresh_token: 'rt' } }), { headers: { 'set-cookie': 'SESSDATA=sess%2C1; path=/; HttpOnly', 'content-type': 'application/json' } })
      }
      return json({ code: -404 })
    }) as typeof fetch
    await ctx.plugin(bili, { config: { minGapMs: 0, closeView: { enabled: false } }, client: { origins: { api: 'http://api.test', passport: 'http://passport.test', www: 'http://www.test' }, fetch: fetchImpl } })
    // The subcommand the adapter offers the outside, run as `/anima bili …` would.
    const invoke = (raw: string) => ctx.anima.platforms().find(p => p.platform === 'bili')!.subcommands![0]!.run(raw.trim().replace(/^bili\s*/, ''), { rawInput: raw } as unknown as CommandInvocation)
    const started = await invoke(' bili login') as { kind: string; text: string }
    expect(started.kind).toBe('success')
    if (withWeb) {
      // The web UI cannot scan a text QR; she gets a one-time link instead.
      const link = /Open this in your browser: (http:\/\/127\.0\.0\.1:3080(\/anima\/bili\/qr\/[0-9a-f]{32}\.svg))/.exec(started.text)
      expect(link).not.toBeNull()
      expect(started.text).not.toMatch(/[▀▄█]/)
      const served = await routes.get(link![2]!)!(new Request(link![1]!))
      expect(served.headers.get('content-type')).toBe('image/svg+xml')
      expect(await served.text()).toMatch(/^<svg [\s\S]*<rect x=/)
    } else {
      expect(started.text).toMatch(/HER account[^\n]*minutes\.\n[ ▀▄█\n]+\nIf it does not scan/)
    }
    expect(existsSync(join(dataDir, 'bili', 'login-qr.svg'))).toBe(true)
    await vi.waitFor(() => expect(loggedIn && existsSync(join(dataDir, 'bili', 'cookie.json'))).toBe(true), { timeout: 8000, interval: 100 })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('Bilibili: logged in as 小鲸鱼 (777)'), { timeout: 4000 })
    expect(routes.size).toBe(0)
    const file = join(dataDir, 'bili', 'cookie.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored).toMatchObject({ cookies: { SESSDATA: 'sess%2C1', bili_jct: 'j', buvid3: 'dev' }, refreshToken: 'rt' })
    const out = await invoke(' bili logout') as { text: string }
    expect(out.text).toMatch(/Logged out/)
    expect(existsSync(file)).toBe(false)
  })

  it('removes its behaviors and status on unload', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.anima.behavior('bili_watch')).toBeDefined()
    expect(ctx.anima.platforms().some(p => p.subcommands?.some(sub => sub.name === 'bili'))).toBe(true)
    await fiber.dispose()
    expect(ctx.anima.behavior('bili_watch')).toBeUndefined()
    expect(ctx.anima.behavior('bili_view_closely')).toBeUndefined()
    expect(ctx.anima.platforms().some(p => p.platform === 'bili')).toBe(false)
    expect(ctx.anima.statusLines().join('\n')).not.toContain('Bilibili')
  })
})
