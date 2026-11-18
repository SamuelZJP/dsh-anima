/** The OneBot v11 backend against a fake OneBot server: auth, mapping both ways, dialect, health, reconnects; and the adapter over it end to end. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as animaCore from '@anima/core'
import { AnimaLife, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as qq from '../src/index.ts'
import type { QqEvent } from '../src/backend.ts'
import { authHeaders, backoff, emojiId, OneBotBackend, parseCQ, qqSegments } from '../src/index.ts'
import { FakeOneBot } from './fake-onebot.ts'
import { ACCOUNT, callAs, FakeHost, OWNER, ownerSession } from './helpers.ts'

async function connect(options: { token?: string; heartbeatGrace?: number; selfId?: string } = {}) {
  const server = new FakeOneBot(options.selfId ?? ACCOUNT)
  const url = await server.listen()
  onTestFinished(() => server.close())
  const backend = new OneBotBackend({ url, accessToken: options.token, callTimeoutMs: 2000, maxBackoffMs: 1000, minBackoffMs: 50, heartbeatGrace: options.heartbeatGrace ?? 2.5 })
  onTestFinished(() => backend.stop())
  const events: QqEvent[] = []
  const seen = { open: 0, close: 0, health: 0 }
  backend.start({ event: e => events.push(e), open: () => { seen.open += 1 }, close: () => { seen.close += 1 }, health: () => { seen.health += 1 } })
  await vi.waitFor(() => expect(seen.open).toBe(1))
  return { server, backend, events, seen, url }
}

describe('OneBot v11 backend: connection', () => {
  it('sends the token as a Bearer header, never in the URL, and names itself without it', async () => {
    const { server, backend, url } = await connect({ token: 's3cret' })
    expect(server.authorizations).toEqual(['Bearer s3cret'])
    expect(server.connections).toEqual([''])
    expect(backend.name).toBe(`OneBot v11 at ${url}`)
    expect(authHeaders(undefined)).toEqual({})
  })

  it('reads the login, friends and groups', async () => {
    const { server, backend } = await connect()
    server.respond('get_friend_list', () => [{ user_id: 20002, nickname: 'sam' }, { user_id: 30003, nickname: 'cat', remark: 'Cat' }, { nickname: 'no id' }])
    server.respond('get_group_list', () => [{ group_id: 40004, group_name: 'Test group' }])
    expect(await backend.login()).toEqual({ userId: ACCOUNT, nickname: 'Anima' })
    expect(await backend.friends()).toEqual([{ userId: '20002', name: 'sam' }, { userId: '30003', name: 'Cat' }])
    expect(await backend.groups()).toEqual([{ groupId: '40004', name: 'Test group' }])
  })

  it('fails a refused call with anima/qq-failed, and calls while down with anima/qq-offline', async () => {
    const { server, backend } = await connect()
    await expect(backend.history('private', '1', 5)).rejects.toThrow(/anima\/qq-failed.*retcode 1404/)
    server.dropAll()
    await vi.waitFor(() => expect(backend.health.state).not.toBe('open'))
    await expect(backend.send('private', '1', [{ type: 'text', text: 'x' }])).rejects.toThrow(/anima\/qq-offline/)
  })

  it('reconnects with backoff after the runtime drops', async () => {
    const { server, backend, seen } = await connect()
    server.dropAll()
    await vi.waitFor(() => expect(seen.close).toBe(1))
    await vi.waitFor(() => expect(seen.open).toBe(2), { timeout: 3000 })
    expect(backend.health.connects).toBe(2)
    expect([0, 1, 2, 3, 10].map(n => backoff(n, 1000, 60_000))).toEqual([1000, 2000, 4000, 8000, 60_000])
  })

  it('reads bot_offline and heartbeats as account health, and drops a silent connection', async () => {
    const { server, backend, seen } = await connect({ heartbeatGrace: 1.5 })
    server.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(ACCOUNT), tag: 'kicked', message: 'logged in elsewhere' })
    await vi.waitFor(() => expect(backend.health.online).toBe(false))
    expect(backend.health.lastError).toBe('bot offline: logged in elsewhere')
    server.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 100, status: { online: true, good: true } })
    await vi.waitFor(() => expect(backend.health.online).toBe(true))
    expect(seen.health).toBeGreaterThanOrEqual(2)
    // No further heartbeat within 1.5 intervals: the connection counts as lost and is reopened.
    await vi.waitFor(() => expect(seen.close).toBe(1), { timeout: 2000 })
    expect(backend.health.lastError ?? '').toMatch(/heartbeat lost|closed/)
    await vi.waitFor(() => expect(seen.open).toBe(2), { timeout: 3000 })
  })
})

describe('OneBot v11 backend: events in QQ terms', () => {
  it('maps messages (arrays and CQ strings), pokes, recalls, typing, requests; drops another account and meta events', async () => {
    const { server, backend, events } = await connect()
    await backend.login()
    server.push({ post_type: 'message', message_type: 'group', message_id: -55, group_id: 300, user_id: 2002, time: 1_700_000_000, sender: { user_id: 2002, nickname: 'bobby', card: 'Bob' }, message: [
      { type: 'reply', data: { id: '7' } }, { type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' hi' } },
      { type: 'image', data: { file: 'x.jpg', url: 'http://x/x.jpg', summary: '[pic]' } }, { type: 'mface', data: { url: 'http://x/s.gif', summary: '[doge]' } },
      { type: 'forward', data: { id: 'res-1' } }, { type: 'record', data: {} }, { type: 'json', data: {} }, { type: 'dice', data: {} },
    ] })
    server.push({ post_type: 'message', message_type: 'private', message_id: 1, user_id: 3003, sender: { nickname: 'Cat' }, message: 'hello [CQ:face,id=1]' })
    server.push({ post_type: 'message', message_type: 'private', message_id: 2, user_id: 3003, self_id: 99999, message: 'not hers' })
    server.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true } })
    server.push({ post_type: 'message_sent', message_type: 'private', user_id: 3003, message: 'own' })
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 20002, target_id: 10001 })
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 300, user_id: 2002, target_id: 2003 })
    server.push({ post_type: 'notice', notice_type: 'friend_recall', user_id: 20002, message_id: 5 })
    server.push({ post_type: 'notice', notice_type: 'group_recall', group_id: 300, user_id: 2002, operator_id: 2004, message_id: 6 })
    // NotRainMeow mirrors NapCat's input status: group_id 0, status_text empty when the person stops.
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', user_id: 20002, group_id: 0, event_type: 1, status_text: '对方正在输入...' })
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', user_id: 20002, group_id: 0, event_type: 2, status_text: '' })
    server.push({ post_type: 'request', request_type: 'friend', user_id: 77777, comment: ' hi ', flag: 'f1' })
    server.push({ post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: 77777, group_id: 500, flag: 'g1' })
    await vi.waitFor(() => expect(events).toHaveLength(10))
    expect(events[0]).toEqual({ type: 'message', message: { kind: 'group', chatId: '300', userId: '2002', displayName: 'Bob', messageId: '-55', time: 1_700_000_000_000, segments: [
      { type: 'reply', messageId: '7' }, { type: 'mention', userId: '10001' }, { type: 'text', text: ' hi' },
      { type: 'image', sticker: false, file: 'x.jpg', url: 'http://x/x.jpg', summary: '[pic]' }, { type: 'image', sticker: true, url: 'http://x/s.gif', summary: '[doge]' },
      { type: 'forward', id: 'res-1' }, { type: 'voice' }, { type: 'card' }, { type: 'other', name: 'dice' },
    ] } })
    expect(events[1]).toMatchObject({ type: 'message', message: { kind: 'private', chatId: '3003', displayName: 'Cat', segments: [{ type: 'text', text: 'hello ' }, { type: 'face' }] } })
    expect(events.slice(2, 8)).toEqual([
      { type: 'poke', kind: 'private', chatId: '20002', userId: '20002', targetId: '10001' },
      { type: 'poke', kind: 'group', chatId: '300', userId: '2002', targetId: '2003' },
      { type: 'recall', kind: 'private', chatId: '20002', operatorId: '20002', messageId: '5' },
      { type: 'recall', kind: 'group', chatId: '300', operatorId: '2004', messageId: '6' },
      { type: 'typing', userId: '20002', typing: true },
      { type: 'typing', userId: '20002', typing: false },
    ])
    expect(events[8]).toMatchObject({ type: 'friend-request', userId: '77777', comment: 'hi' })
    expect(events[9]).toEqual({ type: 'group-invite', userId: '77777', groupId: '500' })
    server.respond('set_friend_add_request', () => null)
    await (events[8] as Extract<QqEvent, { type: 'friend-request' }>).answer!(false)
    expect(server.callsOf('set_friend_add_request')[0]!.params).toEqual({ flag: 'f1', approve: false })
  })

  it('reads forwards in both shapes, nested content included', () => {
    expect(qqSegments([{ type: 'forward', data: { id: 'res-8', content: [
      { type: 'node', data: { nickname: 'Ann', content: [{ type: 'text', data: { text: 'outer' } }] } },
      { type: 'node', data: { user_id: 5, content: [{ type: 'forward', data: { content: [{ sender: { nickname: 'Dee' }, message: [{ type: 'text', data: { text: 'inner' } }] }] } }] } },
    ] } }])).toEqual([{ type: 'forward', id: 'res-8', content: [
      { name: 'Ann', segments: [{ type: 'text', text: 'outer' }] },
      { name: '5', segments: [{ type: 'forward', content: [{ name: 'Dee', segments: [{ type: 'text', text: 'inner' }] }] }] },
    ] }])
    expect(parseCQ('hi [CQ:at,qq=10001] &#91;x&#93; [CQ:reply,id=5]ok')).toEqual([
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' [x] ' } },
      { type: 'reply', data: { id: '5' } },
      { type: 'text', data: { text: 'ok' } },
    ])
  })
})

describe('OneBot v11 backend: actions', () => {
  it('maps every QQ action to its OneBot call', async () => {
    const { server, backend } = await connect()
    for (const action of ['friend_poke', 'group_poke', 'set_msg_emoji_like', 'mark_private_msg_as_read', 'mark_group_msg_as_read', 'set_input_status']) server.respond(action, () => null)
    expect(await backend.send('group', '300', [{ type: 'reply', messageId: '-7' }, { type: 'mention', userId: '2002' }, { type: 'text', text: 'hi' }])).toMatch(/^\d+$/)
    expect(server.callsOf('send_group_msg')[0]!.params).toEqual({ group_id: 300, message: [{ type: 'reply', data: { id: '-7' } }, { type: 'at', data: { qq: '2002' } }, { type: 'text', data: { text: 'hi' } }] })
    await backend.send('private', '20002', [{ type: 'text', text: 'yo' }])
    expect(server.callsOf('send_private_msg')[0]!.params).toEqual({ user_id: 20002, message: [{ type: 'text', data: { text: 'yo' } }] })

    server.respond('get_friend_msg_history', () => ({ messages: [{ message_id: 1, user_id: 20002, time: 1_762_740_000, sender: { nickname: 'sam' }, message: [{ type: 'text', data: { text: 'old' } }] }] }))
    expect(await backend.history('private', '20002', 5)).toEqual([{ kind: 'private', chatId: '20002', userId: '20002', displayName: 'sam', messageId: '1', time: 1_762_740_000_000, segments: [{ type: 'text', text: 'old' }] }])
    expect(server.callsOf('get_friend_msg_history')[0]!.params).toEqual({ user_id: 20002, count: 5 })
    server.respond('get_group_msg_history', () => ({ messages: [] }))
    await backend.history('group', '300', 3)
    expect(server.callsOf('get_group_msg_history')[0]!.params).toEqual({ group_id: 300, count: 3 })

    server.respond('get_msg', () => ({ message_id: 77, user_id: 30003, sender: { user_id: 30003, nickname: 'cat' }, message: [{ type: 'text', data: { text: 'q' } }] }))
    expect(await backend.message('77')).toMatchObject({ userId: '30003', displayName: 'cat', segments: [{ type: 'text', text: 'q' }] })
    expect(server.callsOf('get_msg')[0]!.params).toEqual({ message_id: 77 })

    server.respond('get_image', () => ({ base64: Buffer.from('png').toString('base64') }))
    expect(Buffer.from((await backend.image('b.png')).bytes!).toString()).toBe('png')
    server.respond('get_image', () => ({ url: 'https://x/y.png' }))
    expect(await backend.image('b.png')).toEqual({ url: 'https://x/y.png' })
    server.respond('get_image', () => ({ file: '/local/path' }))
    expect(await backend.image('b.png')).toEqual({})

    server.respond('get_forward_msg', () => ({ messages: [{ sender: { nickname: 'Ann' }, message: [{ type: 'text', data: { text: 'a' } }] }] }))
    expect(await backend.forward('res-7')).toEqual([{ name: 'Ann', segments: [{ type: 'text', text: 'a' }] }])
    expect(server.callsOf('get_forward_msg')[0]!.params).toEqual({ id: 'res-7', message_id: 'res-7' })

    await backend.poke('private', '20002', '20002')
    await backend.poke('group', '300', '2002')
    expect(server.callsOf('friend_poke')[0]!.params).toEqual({ user_id: 20002 })
    expect(server.callsOf('group_poke')[0]!.params).toEqual({ group_id: 300, user_id: 2002 })
    await backend.react('-123', '👍')
    await backend.react('5', '76')
    expect(server.callsOf('set_msg_emoji_like').map(c => c.params)).toEqual([{ message_id: -123, emoji_id: '128077', set: true }, { message_id: 5, emoji_id: '76', set: true }])
    await backend.markRead('private', '20002')
    await backend.markRead('group', '300')
    expect(server.callsOf('mark_private_msg_as_read')[0]!.params).toEqual({ user_id: 20002 })
    expect(server.callsOf('mark_group_msg_as_read')[0]!.params).toEqual({ group_id: 300 })
    await backend.typing('20002')
    expect(server.callsOf('set_input_status')[0]!.params).toEqual({ user_id: 20002, event_type: 1 })
    expect(emojiId('❤️')).toBe('10084')
    expect(emojiId('👍👍')).toBeUndefined()
  })
})

describe('the adapter over OneBot v11, end to end', () => {
  it('receives a message from the runtime and sends her reply through it', async () => {
    const server = new FakeOneBot(ACCOUNT)
    const url = await server.listen()
    onTestFinished(() => server.close())
    server.respond('get_friend_list', () => [{ user_id: Number(OWNER), nickname: 'sam' }])
    server.respond('get_group_list', () => [])
    server.respond('mark_private_msg_as_read', () => null)
    const dataDir = mkdtempSync(join(tmpdir(), 'anima-qq-e2e-'))
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
    const host = new FakeHost()
    await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
    const fiber = await ctx.plugin(qq, { backend: { url, accessToken: 'tok', callTimeoutSeconds: 2, reconnect: { maxSeconds: 1 } }, account: ACCOUNT, owner: OWNER, ownerName: 'Sam' })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toMatch(new RegExp(`QQ: connected to OneBot v11 at ${url} as ${ACCOUNT} \\(Anima\\)`)))
    expect(server.authorizations).toEqual(['Bearer tok'])
    expect(ctx.anima.statusLines().join('\n')).not.toContain('tok')
    server.push({ post_type: 'message', message_type: 'private', message_id: 1, user_id: Number(OWNER), sender: { nickname: 'sam' }, message: [{ type: 'text', data: { text: 'morning!' } }] })
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('Sam（主人） [msg 1] 对你说: morning!')
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: '早' })).isError).toBe(false)
    expect(server.callsOf('send_private_msg')[0]!.params).toEqual({ user_id: Number(OWNER), message: [{ type: 'text', data: { text: '早' } }] })
    await fiber.dispose()
    await vi.waitFor(() => expect(server.open).toBe(0))
  })
})
