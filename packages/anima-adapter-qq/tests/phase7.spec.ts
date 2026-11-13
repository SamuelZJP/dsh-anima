/**
 * Phase 7 (QQ refinement): images she chooses to look at, forwards, quoted
 * replies, pokes and reactions through the gate, typing only during the
 * outbox hold, the outbox through a disconnect, offline notices, and the
 * Self report knowing a reply was already sent.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { AnimaLife, conversationSessionId, selfSessionId, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as qq from '../src/index.ts'
import { emojiId, MediaBook } from '../src/media.ts'
import { FakeOneBot } from './fake-onebot.ts'

const ACCOUNT = '10001'
const OWNER = '20002'
const FRIEND = '30003'
const GROUP = '40004'
const ownerKey = `qq:${ACCOUNT}:private:${OWNER}`
const friendKey = `qq:${ACCOUNT}:private:${FRIEND}`
const groupKey = `qq:${ACCOUNT}:group:${GROUP}`
const ownerSession = conversationSessionId('anima', ownerKey)
const friendSession = conversationSessionId('anima', friendKey)
const groupSession = conversationSessionId('anima', groupKey)
const selfId = selfSessionId('anima')

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

interface FakeAgent { id: string; inbox: string[] }

class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent>()
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string) { this.sessions.set(id, { id, inbox: [] }); return id }
  isArchived() { return false }
  rename() {}
  async deliver(agent: FakeAgent, text: string) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, text: string) { agent.inbox.push(`(inject) ${text}`) }
  selectModel() {}
  isBusy() { return false }
  inbox(id: string) { return this.sessions.get(id)?.inbox ?? [] }
}

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

async function setup(extra: Record<string, unknown> = {}, life: Record<string, unknown> = {}, core: Record<string, unknown> = {}) {
  const server = new FakeOneBot(ACCOUNT)
  const url = await server.listen()
  onTestFinished(() => server.close())
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-qq7-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const saved: { name?: string; bytes: number; mediaType: string }[] = []
  ctx.provide('attachments')
  ctx.set('attachments', { saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
    saved.push({ name: input.name, bytes: input.data.length, mediaType: input.mediaType })
    return { attachmentId: `att${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
  } })
  ctx.provide('llm')
  ctx.set('llm', { resolveModelInfo: async (_provider: string, model: string) => ({ inputModalities: model === 'blind' ? ['text'] : ['text', 'image'] }) })
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' }, approvals: { timeoutSeconds: 5 }, ...core })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 }, groupTriage: { windowSeconds: 0.05 }, outbox: { delaySeconds: 0 }, platforms: { noticeAfterSeconds: 0 }, ...life } })
  await ctx.plugin(qq, {
    url, accessToken: 'tok', account: ACCOUNT, owner: OWNER, ownerName: 'Sam',
    allow: { users: [{ id: FRIEND, name: 'Cat' }], groups: [{ id: GROUP, name: 'Test group' }] },
    callTimeoutSeconds: 2, reconnect: { maxSeconds: 1 },
    ...extra,
  })
  await vi.waitFor(() => expect(ctx.anima.statusText()).toMatch(/QQ: connected .* \(Anima\)/))
  return { ctx, host, server, dataDir, saved }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}, model = 'vision') {
  const agent = { id: sessionId, session: { requestHeader: () => ({ config: { provider: 't', model } }) } } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`p${++calls}`), name, arguments: args, agent, toolSet, signal })
    const text = result.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    return { isError: result.isError, text, content: result.content }
  } finally {
    toolSet.dispose()
  }
}

function privateMessage(userId: string, segments: unknown[], id = ++calls) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: id, user_id: Number(userId), sender: { user_id: Number(userId), nickname: userId === OWNER ? 'sam' : 'cat' }, message: segments }
}

function groupMessage(userId: string, segments: unknown[], id = ++calls) {
  return { post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: id, group_id: Number(GROUP), user_id: Number(userId), sender: { user_id: Number(userId), nickname: 'bob', card: 'Bob' }, message: segments }
}

function event(ctx: Context, sessionId: string, type: string, data: unknown) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

/** Open an intent from Self into a chat and let its conversation turn claim it. */
async function intentInto(ctx: Context, key: string, session: string) {
  const opened = await callAs(ctx, selfId, 'open_conversation', { channel: key, intent: 'say hi' })
  expect(opened.isError).toBe(false)
  const id = /Intent (i\d+)/.exec(opened.text)![1]!
  event(ctx, session, 'user/message', { source: { kind: 'anima-stimulus', ref: id } })
  return id
}

describe('images she chooses to look at', () => {
  it('gives image and sticker placeholders ids and never attaches them on its own', async () => {
    const { host, server } = await setup()
    server.push(privateMessage(OWNER, [
      { type: 'text', data: { text: 'look ' } },
      { type: 'image', data: { file: 'abc.jpg', url: 'http://x/abc.jpg', summary: '[cat photo]' } },
      { type: 'mface', data: { url: 'http://x/s.gif', summary: '[doge]' } },
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
    const { ctx, host, server, saved } = await setup()
    server.push(privateMessage(OWNER, [{ type: 'image', data: { file: 'a.png', url: `${images.base}/a.png`, summary: '' } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    const result = await callAs(ctx, ownerSession, 'qq_look', { id: '#i1' })
    expect(result.isError).toBe(false)
    expect(result.content).toContainEqual({ type: 'image', attachment: expect.objectContaining({ attachmentId: 'att1', mediaType: 'image/png' }) })
    expect(saved).toEqual([{ name: 'qq-i1.png', bytes: PNG.length, mediaType: 'image/png' }])
    await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })
    expect(images.hits()).toBe(1)
  })

  it('falls back to get_image when the URL has expired', async () => {
    const images = await imageServer()
    const { ctx, host, server } = await setup()
    server.respond('get_image', () => ({ file: '/remote/path.png', base64: PNG.toString('base64') }))
    server.push(privateMessage(OWNER, [{ type: 'image', data: { file: 'b.png', url: `${images.base}/gone.png` } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).isError).toBe(false)
    expect(server.callsOf('get_image')[0]!.params).toEqual({ file: 'b.png' })
  })

  it('refuses another chat\'s image, a model that cannot see, and images over the size cap', async () => {
    const images = await imageServer()
    const { ctx, host, server } = await setup({ look: { maxBytes: 1_000_000 } })
    server.push(privateMessage(FRIEND, [{ type: 'image', data: { file: 'secret.png', url: `${images.base}/a.png` } }]))
    server.push(privateMessage(OWNER, [{ type: 'image', data: { file: 'big.png', url: `${images.base}/big.png` } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).text).toContain('anima/no-image')
    expect((await callAs(ctx, friendSession, 'qq_look', { id: 'i1' }, 'blind')).text).toContain('anima/no-vision')
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i2' })).text).toContain('anima/look-too-large')
    expect((await callAs(ctx, selfId, 'qq_look', { id: 'i1' })).text).toContain('anima/wrong-session')
  })

  it('counts looks against the gate quota', async () => {
    const images = await imageServer()
    const { ctx, host, server } = await setup({}, {}, { quotas: [{ behavior: 'qq_look', per: 'channel', limit: 1, windowMinutes: 60 }] })
    server.push(privateMessage(OWNER, [{ type: 'image', data: { file: 'a.png', url: `${images.base}/a.png` } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).isError).toBe(false)
    expect((await callAs(ctx, ownerSession, 'qq_look', { id: 'i1' })).text).toContain('anima/over-quota')
  })
})

describe('forwards and quoted replies', () => {
  it('reads a forward by id through get_forward_msg, capped, with ids for its images', async () => {
    const { ctx, host, server } = await setup({ forward: { maxMessages: 2, maxChars: 4000 } })
    server.respond('get_forward_msg', () => ({ messages: [
      { sender: { nickname: 'Ann', user_id: 1 }, message: [{ type: 'text', data: { text: 'first' } }] },
      { sender: { nickname: 'Ben', user_id: 2 }, message: [{ type: 'image', data: { file: 'f.png', url: 'http://x/f.png' } }] },
      { sender: { nickname: 'Cy', user_id: 3 }, message: [{ type: 'text', data: { text: 'third' } }] },
    ] }))
    server.push(privateMessage(OWNER, [{ type: 'forward', data: { id: 'res-7' } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('[forwarded messages #f1]')
    const result = await callAs(ctx, ownerSession, 'qq_read_forward', { id: '#f1' })
    expect(result.text).toBe('Forwarded messages #f1:\nAnn: first\nBen: [image #i1]\n(1 more message not shown)')
    expect(server.callsOf('get_forward_msg')[0]!.params).toMatchObject({ id: 'res-7' })
    expect((await callAs(ctx, friendSession, 'qq_read_forward', { id: 'f1' })).text).toContain('anima/no-forward')
  })

  it('uses inline forward content without a call, nested forwards included', async () => {
    const { ctx, host, server } = await setup()
    server.push(privateMessage(OWNER, [{ type: 'forward', data: { id: 'res-8', content: [
      { type: 'node', data: { nickname: 'Ann', content: [{ type: 'text', data: { text: 'outer' } }] } },
      { type: 'node', data: { nickname: 'Ben', content: [{ type: 'forward', data: { content: [{ type: 'node', data: { nickname: 'Dee', content: [{ type: 'text', data: { text: 'inner' } }] } }] } }] } },
    ] } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('[forwarded messages #f1: 2 messages]')
    const result = await callAs(ctx, ownerSession, 'qq_read_forward', { id: 'f1' })
    expect(result.text).toBe('Forwarded messages #f1:\nAnn: outer\nBen: [forwarded messages]\n  Dee: inner')
    expect(server.callsOf('get_forward_msg')).toHaveLength(0)
  })

  it('shows a short snippet of the quoted message, from the cache or get_msg', async () => {
    const { host, server } = await setup({ quoteChars: 5 })
    server.push(privateMessage(OWNER, [{ type: 'text', data: { text: 'the original words' } }], 501))
    server.push(privateMessage(OWNER, [{ type: 'reply', data: { id: '501' } }, { type: 'text', data: { text: 'see above' } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(2))
    expect(host.inbox(ownerSession)[1]).toContain('(replying to Sam, msg 501: "the o…") see above')
    server.respond('get_msg', () => ({ message_id: 77, user_id: Number(FRIEND), sender: { user_id: Number(FRIEND), nickname: 'cat' }, message: [{ type: 'text', data: { text: 'old' } }] }))
    server.push(privateMessage(OWNER, [{ type: 'reply', data: { id: '77' } }, { type: 'text', data: { text: 'and this' } }]))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(3))
    expect(host.inbox(ownerSession)[2]).toContain('(replying to cat, msg 77: "old") and this')
  })
})

describe('pokes and reactions', () => {
  it('pokes the other person privately and a named member in a group', async () => {
    const { ctx, server } = await setup()
    server.respond('friend_poke', () => null)
    server.respond('group_poke', () => null)
    expect((await callAs(ctx, ownerSession, 'qq_poke')).text).toBe('poked Sam')
    expect(server.callsOf('friend_poke')[0]!.params).toEqual({ user_id: Number(OWNER) })
    expect((await callAs(ctx, ownerSession, 'qq_poke', { userId: FRIEND })).text).toContain('only poke the person you are talking with')
    expect((await callAs(ctx, groupSession, 'qq_poke')).text).toContain('needs the user id')
    expect((await callAs(ctx, groupSession, 'qq_poke', { userId: '2002' })).isError).toBe(false)
    expect(server.callsOf('group_poke')[0]!.params).toEqual({ group_id: Number(GROUP), user_id: 2002 })
  })

  it('reacts with one emoji as its code point, or a face id', async () => {
    const { ctx, server } = await setup()
    server.respond('set_msg_emoji_like', () => ({ result: true }))
    expect((await callAs(ctx, groupSession, 'qq_react', { messageId: '123', emoji: '👍' })).text).toBe('reacted 👍 to msg 123')
    expect(server.callsOf('set_msg_emoji_like')[0]!.params).toEqual({ message_id: 123, emoji_id: '128077', set: true })
    expect((await callAs(ctx, groupSession, 'qq_react', { messageId: '123', emoji: 'nice!' })).text).toContain('exactly one emoji')
    expect(emojiId('❤️')).toBe('10084')
    expect(emojiId('76')).toBe('76')
    expect(emojiId('👍👍')).toBeUndefined()
  })

  it('goes through the gate: own quota keys, allowlist and session checks', async () => {
    const { ctx, server } = await setup({}, {}, { quotas: [{ behavior: 'qq_poke', per: 'channel', limit: 1, windowMinutes: 60 }, { behavior: 'qq_react', per: 'channel', limit: 1, windowMinutes: 60 }] })
    server.respond('friend_poke', () => null)
    server.respond('set_msg_emoji_like', () => ({ result: true }))
    expect((await callAs(ctx, ownerSession, 'qq_poke')).isError).toBe(false)
    expect((await callAs(ctx, ownerSession, 'qq_poke')).text).toContain('anima/over-quota')
    // A reaction has its own key, and pokes elsewhere count separately.
    expect((await callAs(ctx, ownerSession, 'qq_react', { messageId: '1', emoji: '😂' })).isError).toBe(false)
    expect((await callAs(ctx, ownerSession, 'qq_react', { messageId: '2', emoji: '😂' })).text).toContain('anima/over-quota')
    expect((await callAs(ctx, friendSession, 'qq_poke')).isError).toBe(false)
    expect((await callAs(ctx, selfId, 'qq_poke')).text).toContain('anima/wrong-session')
    const stranger = conversationSessionId('anima', `qq:${ACCOUNT}:private:55555`)
    expect((await callAs(ctx, stranger, 'qq_react', { messageId: '1', emoji: '😂' })).isError).toBe(true)
    expect(server.callsOf('friend_poke')).toHaveLength(2)
  })
})

describe('typing and the outbox', () => {
  it('shows typing only while her chosen message waits in a private outbox', async () => {
    const { ctx, server } = await setup({ typing: { enabled: true, leadSeconds: 5 } }, { outbox: { delaySeconds: 0.3 } })
    server.respond('set_input_status', () => null)
    // A direct reply is not held, so no typing.
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'reply' })).isError).toBe(false)
    expect(server.callsOf('set_input_status')).toHaveLength(0)
    await intentInto(ctx, ownerKey, ownerSession)
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'good morning' })).isError).toBe(false)
    expect(server.callsOf('set_input_status').map(c => c.params)).toEqual([{ user_id: Number(OWNER), event_type: 1 }])
    const typed = server.calls.findIndex(c => c.action === 'set_input_status')
    const sent = server.calls.findIndex(c => c.action === 'send_private_msg' && JSON.stringify(c.params).includes('good morning'))
    expect(typed).toBeLessThan(sent)
  })

  it('never shows typing in groups', async () => {
    const { ctx, server } = await setup({}, { outbox: { delaySeconds: 0.2 } }, { initiate: { consent: { owner: true, channels: [groupKey] } }, approve: [] })
    server.respond('set_input_status', () => null)
    await intentInto(ctx, groupKey, groupSession)
    expect((await callAs(ctx, groupSession, 'qq_say', { text: 'hi all' })).isError).toBe(false)
    expect(server.callsOf('set_input_status')).toHaveLength(0)
  })

  it('holds her message through a disconnect and sends it when QQ is back', async () => {
    const { ctx, host, server } = await setup({}, { outbox: { delaySeconds: 0.05, offlineHoldMinutes: 1 } })
    await host.create(selfId)
    await intentInto(ctx, ownerKey, ownerSession)
    server.accepting = false
    server.dropAll()
    await vi.waitFor(() => expect(ctx.anima.statusText()).toContain('QQ OFFLINE since'))
    const said = callAs(ctx, ownerSession, 'qq_say', { text: 'still here' })
    await vi.waitFor(() => expect(ctx.animaLife.outbox.list()[0]?.offlineSince).toBeDefined())
    server.accepting = true
    const result = await said
    expect(result.isError).toBe(false)
    expect(server.callsOf('send_private_msg').some(c => JSON.stringify(c.params).includes('still here'))).toBe(true)
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('QQ is back online') && line.includes('1 held message went out now'))).toBe(true))
  })

  it('expires a held message when QQ stays offline, and tells her', async () => {
    const { ctx, host, server } = await setup({}, { outbox: { delaySeconds: 0.05, offlineHoldMinutes: 0.01 } })
    await host.create(selfId)
    await intentInto(ctx, ownerKey, ownerSession)
    server.accepting = false
    server.dropAll()
    await vi.waitFor(() => expect(ctx.anima.statusText()).toContain('QQ OFFLINE since'))
    const said = await callAs(ctx, ownerSession, 'qq_say', { text: 'lost' })
    expect(said.text).toContain('anima/outbox-expired')
    // The tool/result event is what tells her Self the intent expired.
    event(ctx, ownerSession, 'tool/call', { callId: 'x1', name: 'qq_say', arguments: '{}' })
    event(ctx, ownerSession, 'tool/result', { message: { toolCallId: 'x1', isError: true, content: [{ type: 'text', text: said.text }] } })
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('expired — the platform stayed offline'))).toBe(true))
    expect(server.callsOf('send_private_msg').some(c => JSON.stringify(c.params).includes('lost'))).toBe(false)
  })
})

describe('offline notices', () => {
  it('tells her Self session when QQ goes down and comes back, and the page says why', async () => {
    const { ctx, host, server, dataDir } = await setup()
    await host.create(selfId)
    server.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(ACCOUNT), message: 'kicked' })
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('[notice] QQ went offline') && line.includes('NapCat reports the account offline (bot offline: kicked)'))).toBe(true))
    const views = await ctx.anima.ownerView('platforms') as { platform: string; view: { summary: string; details: { offline: { reason: string } | null } } }[]
    const qqView = views.find(p => p.platform === 'qq')!.view
    expect(qqView.summary).toMatch(/^OFFLINE since .*: NapCat reports the account offline/)
    expect(qqView.details.offline?.reason).toContain('kicked')
    expect(ctx.anima.statusText()).toContain('QQ OFFLINE since')
    server.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true } })
    await vi.waitFor(() => expect(host.inbox(selfId).some(line => line.includes('[notice] QQ is back online'))).toBe(true))
    expect(host.inbox(selfId).every(line => line.startsWith('(inject)'))).toBe(true)
    // Each transition is in the activity log (the formal test's evidence).
    const { readdirSync } = await import('node:fs')
    const records = readdirSync(join(dataDir, 'activity')).flatMap(file => readFileSync(join(dataDir, 'activity', file), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string; online?: boolean; reason?: string }))
      .filter(record => record.type === 'platform')
    expect(records.map(r => r.online)).toEqual([false, true, false, true])
    expect(records[2]!.reason).toContain('kicked')
  })

  it('stays quiet about drops shorter than noticeAfterSeconds', async () => {
    const { host, server } = await setup({}, { platforms: { noticeAfterSeconds: 5 } })
    await host.create(selfId)
    server.dropAll()
    await new Promise(resolve => setTimeout(resolve, 1500))
    await vi.waitFor(() => expect(server.open).toBe(1), { timeout: 3000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(host.inbox(selfId).filter(line => line.includes('QQ'))).toEqual([])
  })
})

describe('duplicate replies', () => {
  it('puts a reply her conversation already sent into the Self report', async () => {
    const { ctx, host, server } = await setup()
    server.push(privateMessage(OWNER, [{ type: 'text', data: { text: 'hello?' } }]))
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
