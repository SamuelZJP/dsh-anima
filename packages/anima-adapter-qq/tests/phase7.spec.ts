/**
 * Phase 7 (QQ refinement), over a fake backend: images she chooses to look at,
 * forwards, quoted replies, pokes and reactions, typing while the outside holds
 * her message, offline notices, and the Self report knowing a reply was
 * already sent.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { conversationSessionId, selfSessionId } from '@anima/life'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { QqSegment } from '../src/backend.ts'
import { MediaBook, reactionOf } from '../src/media.ts'
import { textMessage } from './fake-backend.ts'
import { ACCOUNT, callAs, FRIEND, friendSession, GROUP, groupKey, groupSession, nextId, OWNER, ownerKey, ownerSession, setup } from './helpers.ts'

const selfId = selfSessionId('anima')

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

async function imageServer() {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    if (req.url === '/big.png') { res.writeHead(200, { 'content-length': String(10_000_000) }); res.end(); return }
    if (req.url === '/gone.png') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits: () => hits }
}

function privateMessage(userId: string, segments: QqSegment[], id = nextId()) {
  return textMessage('private', userId, userId, segments, { messageId: id, displayName: userId === OWNER ? 'sam' : 'cat' })
}

const image = (file: string, url?: string, summary?: string): QqSegment => ({ type: 'image', sticker: false, file, ...url === undefined ? {} : { url }, ...summary === undefined ? {} : { summary } })
const text = (t: string): QqSegment => ({ type: 'text', text: t })

function event(ctx: Context, sessionId: string, type: string, data: unknown) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

/** Open an intent from Self into a chat and let its conversation turn claim it. */
describe('images she chooses to look at', () => {
  it('gives image and sticker placeholders ids and never attaches them on its own', async () => {
    const { host, backend } = await setup()
    backend.push(privateMessage(OWNER, [
      text('look '),
      image('abc.jpg', 'http://x/abc.jpg', '[cat photo]'),
      { type: 'image', sticker: true, url: 'http://x/s.gif', summary: '[doge]' },
    ]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('look [image #i1: cat photo][sticker #i2: doge]')
  })

  it('reuses an id for the same image in the same chat, and keeps ids across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anima-media-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'qq', 'media.json')
    const book = new MediaBook(path, 3)
    expect(book.idFor('a', 'image', { file: 'x.jpg' })).toBe('i1')
    expect(book.idFor('a', 'image', { file: 'x.jpg' })).toBe('i1')
    expect(book.idFor('b', 'image', { file: 'x.jpg' })).toBe('i2')
    expect(book.idFor('a', 'forward', { id: 'res1' })).toBe('f1')
    expect(book.idFor('a', 'image', {})).toBeUndefined()
    const again = new MediaBook(path, 3)
    expect(again.get('a', '#I1')?.file).toBe('x.jpg')
    expect(again.idFor('a', 'image', { file: 'y.jpg' })).toBe('i3')
    // Bounded: the oldest is forgotten.
    expect(again.get('a', 'i1')).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(3)
  })

  it('shows the image to her chat model and caches the stored attachment', async () => {
    const images = await imageServer()
    const { ctx, host, backend, saved } = await setup()
    backend.push(privateMessage(OWNER, [image('a.png', `${images.base}/a.png`, '')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    const result = await callAs(ctx, ownerSession, 'qq_look', { id: '#i1' })
    expect(result.isError).toBe(false)
    expect(result.content).toContainEqual({ type: 'image', attachment: expect.objectContaining({ attachmentId: 'att1', mediaType: 'image/png' }) })
    expect(saved).toEqual([{ name: 'qq-i1.png', bytes: PNG.length, mediaType: 'image/png' }])
    await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })
    expect(images.hits()).toBe(1)
  })

  it('falls back to the backend when the URL has expired', async () => {
    const images = await imageServer()
    const { ctx, host, backend } = await setup()
    backend.respond('image', () => ({ bytes: new Uint8Array(PNG) }))
    backend.push(privateMessage(OWNER, [image('b.png', `${images.base}/gone.png`)]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).isError).toBe(false)
    expect(backend.callsOf('image')[0]!.args).toEqual(['b.png'])
  })

  it('refuses another chat\'s image, a model that cannot see, and images over the size cap', async () => {
    const images = await imageServer()
    const { ctx, host, backend } = await setup({ qq: { look: { maxBytes: 1_000_000 } }, without: ['image'] })
    backend.push(privateMessage(FRIEND, [image('secret.png', `${images.base}/a.png`)]))
    backend.push(privateMessage(OWNER, [image('big.png', `${images.base}/big.png`)]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).text).toContain('anima/no-image')
    expect((await callAs(ctx, friendSession, 'qq_look', { id: 'i1' }, 'blind')).text).toContain('anima/no-vision')
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i2' })).text).toContain('anima/look-too-large')
    expect((await callAs(ctx, selfId, 'qq_look', { id: 'i1' })).text).toContain('anima/wrong-session')
  })

  it('has no limit of its own on looks (limits are the outside\'s)', async () => {
    const images = await imageServer()
    const { ctx, host, backend } = await setup()
    backend.push(privateMessage(OWNER, [image('a.png', `${images.base}/a.png`)]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).isError).toBe(false)
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).isError).toBe(false)
  })
})

describe('forwards and quoted replies', () => {
  it('reads a forward by id through the backend, capped, with ids for its images', async () => {
    const { ctx, host, backend } = await setup({ qq: { forward: { maxMessages: 2, maxChars: 4000 } } })
    backend.respond('forward', () => [
      { name: 'Ann', segments: [text('first')] },
      { name: 'Ben', segments: [image('f.png', 'http://x/f.png')] },
      { name: 'Cy', segments: [text('third')] },
    ])
    backend.push(privateMessage(OWNER, [{ type: 'forward', id: 'res-7' }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('[forwarded messages #f1]')
    const result = await callAs(ctx, ownerSession, 'qq_read_forward', { id: '#f1' })
    expect(result.text).toBe('Forwarded messages #f1:\nAnn: first\nBen: [image #i1]\n(1 more message not shown)')
    expect(backend.callsOf('forward')[0]!.args).toEqual(['res-7'])
    expect((await callAs(ctx, friendSession, 'qq_read_forward', { id: 'f1' })).text).toContain('anima/no-forward')
  })

  it('uses inline forward content without a call, nested forwards included', async () => {
    const { ctx, host, backend } = await setup()
    backend.push(privateMessage(OWNER, [{ type: 'forward', id: 'res-8', content: [
      { name: 'Ann', segments: [text('outer')] },
      { name: 'Ben', segments: [{ type: 'forward', content: [{ name: 'Dee', segments: [text('inner')] }] }] },
    ] }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('[forwarded messages #f1: 2 messages]')
    const result = await callAs(ctx, ownerSession, 'qq_read_forward', { id: 'f1' })
    expect(result.text).toBe('Forwarded messages #f1:\nAnn: outer\nBen: [forwarded messages]\n  Dee: inner')
    expect(backend.callsOf('forward')).toHaveLength(0)
  })

  it('shows a short snippet of the quoted message, from the cache or the backend', async () => {
    const { host, backend } = await setup({ qq: { quoteChars: 5 } })
    backend.push(privateMessage(OWNER, [text('the original words')], '501'))
    backend.push(privateMessage(OWNER, [{ type: 'reply', messageId: '501' }, text('see above')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(2))
    expect(host.inbox(ownerSession)[1]).toContain('(replying to Sam, msg 501: "the o…") see above')
    backend.respond('message', () => ({ kind: 'private', chatId: OWNER, userId: FRIEND, displayName: 'cat', messageId: '77', segments: [text('old')] }))
    backend.push(privateMessage(OWNER, [{ type: 'reply', messageId: '77' }, text('and this')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(3))
    expect(host.inbox(ownerSession)[2]).toContain('(replying to cat, msg 77: "old") and this')
  })
})

describe('pokes and reactions', () => {
  it('pokes the other person privately and a named member in a group', async () => {
    const { ctx, backend } = await setup()
    expect((await callAs(ctx, ownerSession, 'qq_poke')).text).toBe('poked Sam')
    expect(backend.callsOf('poke')[0]!.args).toEqual(['private', OWNER, OWNER])
    expect((await callAs(ctx, ownerSession, 'qq_poke', { userId: FRIEND })).text).toContain('only poke the person you are talking with')
    expect((await callAs(ctx, groupSession, 'qq_poke')).text).toContain('needs the user id')
    expect((await callAs(ctx, groupSession, 'qq_poke', { userId: '2002' })).isError).toBe(false)
    expect(backend.callsOf('poke')[1]!.args).toEqual(['group', GROUP, '2002'])
  })

  it('reacts with one emoji or a face id', async () => {
    const { ctx, backend } = await setup()
    expect((await callAs(ctx, groupSession, 'qq_react', { messageId: '-123', emoji: ' 👍' })).text).toBe('reacted 👍 to msg -123')
    expect(backend.callsOf('react')[0]!.args).toEqual(['-123', '👍'])
    expect((await callAs(ctx, groupSession, 'qq_react', { messageId: '123', emoji: 'nice!' })).text).toContain('exactly one emoji')
    expect(reactionOf('❤️')).toBe('❤️')
    expect(reactionOf('76')).toBe('76')
    expect(reactionOf('👍👍')).toBeUndefined()
  })

  it('passes her body check: only in QQ chats she has', async () => {
    const { ctx, backend } = await setup()
    expect((await callAs(ctx, ownerSession, 'qq_poke')).isError).toBe(false)
    expect((await callAs(ctx, ownerSession, 'qq_react', { messageId: '1', emoji: '😂' })).isError).toBe(false)
    expect((await callAs(ctx, friendSession, 'qq_poke')).isError).toBe(false)
    expect((await callAs(ctx, selfId, 'qq_poke')).text).toContain('anima/wrong-session')
    const stranger = conversationSessionId('anima', `qq:${ACCOUNT}:private:55555`)
    expect((await callAs(ctx, stranger, 'qq_react', { messageId: '1', emoji: '😂' })).isError).toBe(true)
    expect(backend.callsOf('poke')).toHaveLength(2)
  })
})

describe('typing while the outside holds her message', () => {
  const held = (ctx: Awaited<ReturnType<typeof setup>>['ctx'], channelKey: string, ms: number) => {
    let done!: () => void
    ctx.emit('anima/outgoing-held', { channelKey, sendsAt: Date.now() + ms, done: new Promise<void>((resolve) => { done = resolve }) })
    return () => done()
  }

  it('shows typing shortly before a held message in a private chat goes out', async () => {
    const { ctx, backend } = await setup({ qq: { typing: { enabled: true, leadSeconds: 5 } } })
    const finish = held(ctx, ownerKey, 300)
    await vi.waitFor(() => expect(backend.callsOf('typing').map(c => c.args)).toEqual([[OWNER]]))
    finish()
  })

  it('never shows typing in groups, and not after the hold ended', async () => {
    const { ctx, backend } = await setup({ qq: { typing: { enabled: true, leadSeconds: 0.01 } } })
    held(ctx, groupKey, 50)
    held(ctx, ownerKey, 200)()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(backend.callsOf('typing')).toHaveLength(0)
  })
})

describe('offline notices', () => {
  it('tells her Self session when QQ goes down and comes back, and the page says why', async () => {
    const { ctx, host, backend, recorded } = await setup()
    await host.create(selfId)
    backend.setOnline(false, 'bot offline: kicked')
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('[notice] QQ went offline') && line.includes('the runtime reports the QQ account offline (bot offline: kicked)'))).toBe(true))
    const qqView = await ctx.anima.platforms().find(p => p.platform === 'qq')!.view() as { summary: string; details: { offline: { reason: string } | null; backend: string } }
    expect(qqView.summary).toMatch(/^OFFLINE since .*: the runtime reports the QQ account offline/)
    expect(qqView.details.backend).toBe('fake QQ backend')
    expect(qqView.details.offline?.reason).toContain('kicked')
    expect(ctx.anima.statusLines().join('\n')).toContain('QQ OFFLINE since')
    backend.setOnline(true)
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('[notice] QQ is back online'))).toBe(true))
    expect(host.inbox(selfId).every(line => line.startsWith('(inject)'))).toBe(true)
    // Each transition after connecting is reported for the log outside.
    const records = recorded.filter(record => record.type === 'platform')
    expect(records.map(r => r.online)).toEqual([false, true])
    expect(records[0]!.reason).toContain('kicked')
  })

  it('stays quiet about drops shorter than noticeAfterSeconds', async () => {
    const { host, backend } = await setup({ life: { platforms: { noticeAfterSeconds: 5 } } })
    await host.create(selfId)
    backend.drop()
    await new Promise(resolve => setTimeout(resolve, 300))
    backend.connect()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(host.inbox(selfId).filter(line => line.includes('QQ'))).toEqual([])
  })
})

describe('duplicate replies', () => {
  it('puts a reply her conversation already sent into the Self report', async () => {
    const { ctx, host, backend } = await setup()
    backend.push(privateMessage(OWNER, [text('hello?')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    event(ctx, ownerSession, 'tool/call', { callId: 'r1', name: 'qq_say', arguments: '{"text":"hi!"}' })
    event(ctx, ownerSession, 'tool/result', { message: { toolCallId: 'r1', isError: false, content: [{ type: 'text', text: 'sent (msg 9001)' }] } })
    event(ctx, ownerSession, 'tool/call', { callId: 'r2', name: 'qq_say', arguments: '{"text":"more"}' })
    event(ctx, ownerSession, 'tool/result', { message: { toolCallId: 'r2', isError: false, content: [{ type: 'text', text: 'sent (msg 9002)' }] } })
    await ctx.animaLife.beat()
    const report = host.inbox(Object.keys(Object.fromEntries(host.sessions)).find(id => id.startsWith('anima-t-'))!).at(-1)!
    expect(report).toContain('Sam (owner) wrote to you in Sam (QQ)')
    expect(report.match(/You responded in Sam \(QQ\) at .* \(qq_say\); that conversation already handled what came in there\./g)).toHaveLength(1)
  })
})

describe('Phase 9: typing keeps the window open, spaced messages, read marks', () => {
  it('keeps a private burst waiting while the runtime reports that the owner types', async () => {
    const { ctx, host, backend } = await setup({ life: { conversation: { settleSeconds: 0.12, settleMaxSeconds: 3 } } })
    backend.push(privateMessage(OWNER, [text('我跟你说')]))
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 70))
      backend.push({ type: 'typing', userId: OWNER, typing: true })
    }
    expect(host.inbox(ownerSession)).toEqual([])
    backend.push(privateMessage(OWNER, [text('今天好好笑')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toMatch(/Sam（主人）发来 2 条：\n.*我跟你说\n.*今天好好笑/)
    expect(ctx.anima.statusLines().join('\n')).toContain('Settle window: 0.12 s quiet, at most 3 s')
  })

  it('spaces the messages of one say by a typing time, showing typing in private chats', async () => {
    const { ctx, host, backend } = await setup({ qq: { pacing: { baseSeconds: 0.05, perCharSeconds: 0.01, maxSeconds: 1 } } })
    backend.push(privateMessage(OWNER, [text('hi')]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    const started = Date.now()
    const said = await callAs(ctx, ownerSession, 'qq_say', { text: '在的', also: ['刚醒', '你呢'] })
    expect(said.isError).toBe(false)
    // Two waits of 0.05 + 0.02 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(130)
    expect(backend.callsOf('send').map(c => (c.args[2] as { text: string }[]).at(-1)!.text)).toEqual(['在的', '刚醒', '你呢'])
    expect(backend.callsOf('typing')).toHaveLength(2)
  })

  it('marks a chat read when it wakes her, and leaves messages held at night unread', async () => {
    const { host, backend } = await setup({ core: { clock: { speed: 1, start: '2026-11-11T02:00' } } })
    backend.push(privateMessage(OWNER, [text('睡了吗')]))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(host.inbox(ownerSession)).toEqual([])
    expect(backend.callsOf('markRead')).toEqual([])
  })
})
