import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BiliClient, extractFrames, ffmpegArgs, isVoucherOnly, mixinKey, parseDanmaku, parseDuration, parseSubtitle, pickSpread, sampleEvenly, signQuery, subtitleAt, videoLine, watchDigest, checkFfmpeg, countText } from '../src/index.ts'
import { alignmentPositions, codewords, dataBytes, dataCodewords, dataPositions, encodeQr, formatBits, gfMul, maskHit, renderQr, rsDivisor } from '../src/qr.ts'

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-bili-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('WBI signing', () => {
  it('matches the documented example', () => {
    const mixin = mixinKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')
    expect(mixin).toBe('ea1db124af3c7062474693fa704f4ff8')
    expect(signQuery({ foo: '114', bar: '514', zab: 1919810 }, mixin, 1702204169))
      .toBe('bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
  })

  it('drops the characters the player drops and encodes the rest', () => {
    expect(signQuery({ keyword: "猫(cat)!'*" }, 'k', 1)).toMatch(/^keyword=%E7%8C%ABcat&wts=1&w_rid=[0-9a-f]{32}$/)
  })
})

/** Read a QR matrix back: format bits, unmask, codewords, de-interleave check, byte-mode payload. */
function readBack(modules: readonly (readonly boolean[])[], version: number): { mask: number; text: string; words: number[] } {
  const size = modules.length
  let format = 0
  for (let i = 0; i < 15; i++) {
    const [x, y] = i < 8 ? [size - 1 - i, 8] : [8, size - 15 + i]
    if (modules[y]![x]) format |= 1 << i
  }
  const mask = ((format ^ 0x5412) >>> 10) & 7
  // Function modules: rebuild by encoding an empty payload of the same version is not possible, so mark them by geometry.
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y]![x] = true }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy)
  const align = alignmentPositions(version)
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(align[i]! + dx, align[j]! + dy)
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8) }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i) }
  if (version >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)) }
  const order = dataPositions(size, fn)
  const bits = order.map(([x, y]) => modules[y]![x]! !== maskHit(mask, x, y))
  const words: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | (b ? 1 : 0), 0))
  // Single-block versions only (enough for the test payloads): data first.
  const data = words.slice(0, dataCodewords(version))
  const bitstream = data.flatMap(w => Array.from({ length: 8 }, (_, k) => (w >>> (7 - k)) & 1))
  const read = (from: number, n: number) => bitstream.slice(from, from + n).reduce((acc, b) => (acc << 1) | b, 0)
  expect(read(0, 4)).toBe(0b0100)
  const length = read(4, 8)
  const bytes = Array.from({ length }, (_, i) => read(12 + i * 8, 8))
  return { mask, text: new TextDecoder().decode(new Uint8Array(bytes)), words }
}

describe('QR encoder', () => {
  it('builds GF(256) Reed–Solomon codes whose syndromes vanish', () => {
    expect(gfMul(0x53, 0xca)).toBe(gfMul(0xca, 0x53))
    const data = dataBytes(new TextEncoder().encode('hello'), 1)
    const all = codewords(data, 1)
    expect(all).toHaveLength(26)
    // Evaluate the codeword polynomial at α^0..α^6: all zero for a valid RS code.
    for (let i = 0, root = 1; i < 7; i++, root = gfMul(root, 2)) {
      let value = 0
      for (const word of all) value = gfMul(value, root) ^ word
      expect(value).toBe(0)
    }
    expect(rsDivisor(7)).toHaveLength(7)
  })

  it('places finders, format bits and the payload so it reads back', () => {
    const text = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=0123456789abcdef0123456789abcdef&from='
    const qr = encodeQr(text)
    expect(qr.version).toBe(6)
    expect(qr.size).toBe(41)
    // Finder corners: dark ring, light ring, dark centre.
    for (const [x, y] of [[0, 0], [qr.size - 7, 0], [0, qr.size - 7]] as const) {
      expect(qr.modules[y]![x]).toBe(true)
      expect(qr.modules[y + 1]![x + 1]).toBe(false)
      expect(qr.modules[y + 3]![x + 3]).toBe(true)
    }
    expect(qr.modules[qr.size - 8]![8]).toBe(true)
    expect(formatBits(qr.mask) >>> 0).toBeLessThan(1 << 15)
    const short = encodeQr('hello')
    expect(short.version).toBe(1)
    expect(readBack(short.modules, 1)).toMatchObject({ mask: short.mask, text: 'hello' })
    expect(renderQr(short).split('\n')).toHaveLength(Math.ceil((short.size + 4) / 2))
  })

  it('reads back every mask at version 2', () => {
    const text = 'anima says hi to the QR scanner'
    const qr = encodeQr(text)
    expect(qr.version).toBe(2)
    expect(readBack(qr.modules, 2).text).toBe(text)
  })
})

describe('digest helpers', () => {
  it('parses durations, counts, danmaku and subtitles', () => {
    expect(parseDuration('1:02:03')).toBe(3723)
    expect(parseDuration('4:05')).toBe(245)
    expect(parseDuration('bad')).toBeUndefined()
    expect(countText('1.2万')).toBe(12000)
    const dm = parseDanmaku('<i><d p="12.5,1,25,16777215,0,0,x,1,10">哈哈&amp;好</d><d p="3,1,25,1,0,0,x,2,10">first</d></i>')
    expect(dm).toEqual([{ from: 3, text: 'first' }, { from: 12.5, text: '哈哈&好' }])
    const subs = parseSubtitle(JSON.stringify({ body: [{ from: 0, to: 2, content: '你好' }, { from: 10, to: 12, content: '再见' }] }))
    expect(subtitleAt(subs, 1)).toBe('你好')
    expect(subtitleAt(subs, 8)).toBe('再见')
    expect(subtitleAt(subs, 30)).toBeUndefined()
    expect(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9])
  })

  it('writes compact lines and a capped digest', () => {
    expect(videoLine({ bvid: 'BV1xx411c7mD', title: '<em class="keyword">猫</em>弹琴', author: 'Mao', durationSeconds: 73, views: 1_078_530, likes: 300, danmaku: 80, description: 'a cat' }))
      .toBe('BV1xx411c7mD «猫弹琴» — Mao · 1:13, 107.9万 views, 300 likes, 80 danmaku — a cat')
    const digest = watchDigest({
      item: { bvid: 'BV1xx411c7mD', title: 'T', author: 'A', durationSeconds: 600, views: 1, likes: 1, danmaku: 2, description: 'd'.repeat(500) },
      subtitles: Array.from({ length: 200 }, (_, i) => ({ from: i * 3, to: i * 3 + 2, text: '字幕内容' })),
      subtitleNote: 'AI 中文',
      danmaku: Array.from({ length: 100 }, (_, i) => ({ from: i * 6, text: `d${i}` })),
      comments: Array.from({ length: 20 }, (_, i) => ({ author: `u${i}`, text: 'nice '.repeat(100), likes: i })),
      caps: { descriptionChars: 50, subtitleChars: 300, danmakuItems: 5, commentItems: 3, commentChars: 40 },
    })
    expect(digest).toContain('## Subtitles (AI 中文)')
    expect(digest).toContain('## Danmaku (5 of 100, spread over the video)')
    expect(digest.match(/^- u\d+/gm)).toHaveLength(3)
    expect(digest.split('## Subtitles')[1]!.split('## Danmaku')[0]!.length).toBeLessThan(330)
  })
})

function envelope(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('BiliClient', () => {
  function client(handler: (url: URL) => Response, now = { t: 1_000_000 }) {
    const seen: string[] = []
    const c = new BiliClient({
      minGapMs: 0, timeoutMs: 1000, backoffMs: 60_000, maxBackoffMs: 3_600_000, now: () => now.t,
      origins: { api: 'http://api.test', passport: 'http://passport.test', www: 'http://www.test' },
      fetch: (async (input: string | URL) => { const url = new URL(String(input)); seen.push(url.pathname + url.search); return handler(url) }) as typeof fetch,
    })
    return { c, seen, now }
  }

  it('gets device cookies from the homepage first, then sends them', async () => {
    const { c, seen } = client((url) => {
      if (url.host === 'www.test') return new Response('', { headers: { 'set-cookie': 'buvid3=abc; path=/; domain=.bilibili.com' } })
      return envelope({ code: 0, data: { list: [] } })
    })
    await c.request('/x/web-interface/popular', { ps: 1 })
    expect(seen).toEqual(['/', '/x/web-interface/popular?ps=1'])
    expect(c.cookies()).toEqual({ buvid3: 'abc' })
  })

  it('backs off on -352 and on a voucher-only answer, doubling, and says so', async () => {
    let code = -352
    const { c, now } = client((url) => url.host === 'www.test' ? new Response('') : envelope(code === 0 ? { code: 0, data: { v_voucher: 'x' } } : { code }))
    c.setCookies({ buvid3: 'x' })
    await expect(c.request('/x/a')).rejects.toThrow(/anima\/bili-risk-control: .*-352 on \/x\/a.*about 1 min/)
    await expect(c.request('/x/b')).rejects.toThrow(/backing off for about 1 min more/)
    now.t += 61_000
    code = 0
    await expect(c.request('/x/c')).rejects.toThrow(/about 2 min/)
    expect(c.risk.hits).toBe(2)
    expect(isVoucherOnly({ code: 0, data: { v_voucher: 'x' } })).toBe(true)
    expect(isVoucherOnly({ code: 0, data: { v_voucher: 'x', result: [] } })).toBe(false)
  })

  it('reports -101 as a missing login', async () => {
    const { c } = client(() => envelope({ code: -101, message: '账号未登录' }))
    c.setCookies({ buvid3: 'x' })
    await expect(c.request('/x/polymer/web-dynamic/v1/feed/all')).rejects.toThrow(/anima\/bili-login-needed: .*\/anima bili login/)
  })

  it('signs WBI requests with keys from nav', async () => {
    const { c, seen } = client((url) => url.pathname === '/x/web-interface/nav'
      ? envelope({ code: -101, data: { isLogin: false, wbi_img: { img_url: 'https://x/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://x/4932caff0ff746eab6f01bf08b70ac45.png' } } })
      : envelope({ code: 0, data: {} }))
    c.setCookies({ buvid3: 'x' })
    await c.request('/x/player/wbi/v2', { bvid: 'BV1', cid: 2 }, { wbi: true })
    expect(seen[1]).toMatch(/^\/x\/player\/wbi\/v2\?bvid=BV1&cid=2&wts=\d+&w_rid=[0-9a-f]{32}$/)
    expect(c.login.isLogin).toBe(false)
  })

  it('refuses a stream larger than the cache allows', async () => {
    const { c } = client(() => new Response(new Uint8Array(2000), { headers: { 'content-length': '2000' } }))
    await expect(c.download('http://cdn.test/v.mp4', join(temp(), 'v.mp4'), 1000)).rejects.toThrow(/anima\/bili-too-large/)
  })
})

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe('frames', () => {
  it('fails loud with a hint when ffmpeg is missing', () => {
    expect(() => checkFfmpeg('/nonexistent/ffmpeg')).toThrow(/anima\/ffmpeg-missing: .*sudo apt install ffmpeg.*closeView.enabled: false/)
  })

  it('picks frames spread over time', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ file: `f${i}`, t: i }))
    expect(pickSpread(frames, 4).map(f => f.t)).toEqual([0, 13, 26, 39])
    expect(pickSpread(frames.slice(0, 3), 12)).toHaveLength(3)
    expect(ffmpegArgs({ ffmpeg: 'ffmpeg', input: 'in.mp4', outDir: 'o', everySeconds: 20, sceneThreshold: 0.3, width: 512, maxCandidates: 48 }).join(' '))
      .toContain("select='isnan(prev_selected_t)+gt(scene\\,0.3)+gte(t-prev_selected_t\\,20)',scale=512:-2,showinfo")
  })

  it.skipIf(!hasFfmpeg)('extracts the first frame, scene cuts and fallback frames with timestamps', async () => {
    const dir = temp()
    const video = join(dir, 't.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=12', '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=10:duration=8', '-filter_complex', '[0][1]concat=n=2:v=1', '-pix_fmt', 'yuv420p', video])
    const frames = await extractFrames({ ffmpeg: 'ffmpeg', input: video, outDir: dir, everySeconds: 5, sceneThreshold: 0.3, width: 160, maxCandidates: 20 })
    expect(frames.map(f => Math.round(f.t))).toEqual([0, 5, 10, 12, 17])
    expect(frames.every(f => existsSync(f.file))).toBe(true)
    expect(readdirSync(dir).filter(name => name.endsWith('.jpg'))).toHaveLength(5)
  })
})
