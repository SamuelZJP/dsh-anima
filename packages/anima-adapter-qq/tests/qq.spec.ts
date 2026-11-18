import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { AnimaLife, conversationSessionId, groupTriageSessionId, selfSessionId, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as qq from '../src/index.ts'
import { FakeOneBot } from './fake-onebot.ts'

const ACCOUNT = '10001'
const OWNER = '20002'
const FRIEND = '30003'
const GROUP = '40004'
const ownerKey = `qq:${ACCOUNT}:private:${OWNER}`
const groupKey = `qq:${ACCOUNT}:group:${GROUP}`
const ownerSession = conversationSessionId('anima', ownerKey)
const groupSession = conversationSessionId('anima', groupKey)

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

async function setup(extra: Record<string, unknown> = {}, life: Record<string, unknown> = {}) {
  const server = new FakeOneBot(ACCOUNT)
  const url = await server.listen()
  server.respond('get_friend_list', () => [{ user_id: Number(OWNER), nickname: 'sam' }, { user_id: Number(FRIEND), nickname: 'cat', remark: 'Cat' }])
  server.respond('get_group_list', () => [{ group_id: Number(GROUP), group_name: 'Test group' }])
  onTestFinished(() => server.close())
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-qq-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 }, groupTriage: { windowSeconds: 0.05 }, ...life } })
  const fiber = await ctx.plugin(qq, {
    url, accessToken: 'tok', account: ACCOUNT, owner: OWNER, ownerName: 'Sam',
    callTimeoutSeconds: 2, reconnect: { maxSeconds: 1 },
    ...extra,
  })
  await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toMatch(/QQ: connected .* \(Anima\)/))
  // The adapter publishes every friend and group the account has once it is logged in.
  await vi.waitFor(() => expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:group:${GROUP}`)).toBeDefined())
  return { ctx, host, server, fiber }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`q${++calls}`), name, arguments: args, agent, toolSet, signal })
    const block = result.content[0] as { text?: string } | undefined
    return { isError: result.isError, text: block?.text ?? '' }
  } finally {
    toolSet.dispose()
  }
}

function privateMessage(userId: string, text: string, id = ++calls) {
  return { post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: id, user_id: Number(userId), sender: { user_id: Number(userId), nickname: userId === OWNER ? 'sam' : 'someone' }, message: [{ type: 'text', data: { text } }] }
}

function groupMessage(groupId: string, userId: string, segments: unknown[], id = ++calls) {
  return { post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: id, group_id: Number(groupId), user_id: Number(userId), sender: { user_id: Number(userId), nickname: 'bob', card: 'Bob' }, message: segments }
}

describe('QQ adapter', () => {
  it('connects with the access token, verifies the account and publishes every friend and group', async () => {
    const { ctx, server } = await setup()
    expect(server.connections[0]).toBe('?access_token=tok')
    expect(server.callsOf('get_login_info')).toHaveLength(1)
    expect(ctx.anima.describeSession(ownerSession)).toMatchObject({ kind: 'conversation', channelKey: ownerKey })
    expect(ctx.anima.channelInfo(ownerKey)).toMatchObject({ isOwner: true, display: 'Sam (QQ)' })
    // Every chat of the account, with its name; which ones may reach her is decided outside.
    expect(ctx.anima.channelInfo(groupKey)).toMatchObject({ isOwner: false, display: 'Test group (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:private:${FRIEND}`)).toMatchObject({ isOwner: false, display: 'Cat (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:group:999`)).toBeUndefined()
    expect(ctx.anima.statusLines().join('\n')).not.toContain('allowlist')
    expect(ctx.anima.ownerLine?.name).toContain('QQ private chat with the owner')
  })

  it('delivers every chat, a new one included: the adapter filters nothing', async () => {
    const { ctx, host, server } = await setup()
    server.push(privateMessage(OWNER, 'morning!'))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toMatch(/\[QQ 私聊「Sam」\] Sam（主人） \[msg \d+\] 对你说: morning!\n在这里回应：用 qq_say 说话（只有对方看得到），或用 end_turn 结束不说。只写文字没有人看得到。$/)
    server.push(privateMessage(FRIEND, 'hi there'))
    await vi.waitFor(() => expect(host.inbox(conversationSessionId('anima', `qq:${ACCOUNT}:private:${FRIEND}`))).toHaveLength(1))
    server.push(privateMessage('55555', 'spam'))
    server.push(groupMessage('999', '2002', [{ type: 'at', data: { qq: ACCOUNT } }]))
    server.push(privateMessage(ACCOUNT, 'my own echo'))
    await vi.waitFor(() => expect([...host.sessions.keys()]).toHaveLength(4))
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:private:55555`)).toMatchObject({ display: 'someone (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:group:999`)).toMatchObject({ display: 'group 999 (QQ)' })
  })

  it('wakes a group when she is @-mentioned or replied to, and triages other chatter', async () => {
    const { ctx, host, server } = await setup({}, { groupTriage: { windowSeconds: 30 } })
    server.push(groupMessage(GROUP, '2002', [{ type: 'text', data: { text: 'lunch?' } }]))
    server.push(groupMessage(GROUP, '2002', [{ type: 'at', data: { qq: ACCOUNT } }, { type: 'text', data: { text: ' you in?' } }]))
    await vi.waitFor(() => expect(host.inbox(groupSession)).toHaveLength(1))
    expect(host.inbox(groupSession)[0]).toMatch(/2 条消息（Bob 2 条）：\n  \d\d:\d\d Bob \[qq 2002, msg \d+\]: lunch\?\n  \d\d:\d\d Bob \[qq 2002, msg \d+\] 叫你: @Anima you in\?\n（群里所有人都会看到你的回答。）\n在这里回应：用 qq_say 说话（群里所有人都看得到）/)
    // The chat that woke her is marked read (Phase 9).
    await vi.waitFor(() => expect(server.callsOf('mark_group_msg_as_read')).toEqual([expect.objectContaining({ params: { group_id: Number(GROUP) } })]))

    // She speaks; a reply to her message wakes the group.
    const said = await callAs(ctx, groupSession, 'qq_say', { text: 'sure!', replyTo: '7', mention: ['2002'] })
    expect(said.isError).toBe(false)
    const send = server.callsOf('send_group_msg')[0]!
    expect(send.params).toEqual({ group_id: Number(GROUP), message: [{ type: 'reply', data: { id: '7' } }, { type: 'at', data: { qq: '2002' } }, { type: 'text', data: { text: ' ' } }, { type: 'text', data: { text: 'sure!' } }] })
    const mine = /msg (\d+)/.exec(said.text)![1]!
    server.push(groupMessage(GROUP, '2002', [{ type: 'reply', data: { id: mine } }, { type: 'text', data: { text: 'great' } }]))
    await vi.waitFor(() => expect(host.inbox(groupSession)).toHaveLength(2))
    expect(host.inbox(groupSession)[1]).toContain(`(replying to you, msg ${mine}: "sure!") great`)

    // A reply to someone else's message is chatter (get_msg says it is not hers).
    server.respond('get_msg', () => ({ sender: { user_id: 2002 } }))
    server.push(groupMessage(GROUP, '2002', [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: 'lol' } }]))
    await vi.waitFor(() => expect(ctx.animaLife.triage.open()).toEqual([{ channelKey: groupKey, messages: 1 }]))
  })

  it('sends chatter batches to group triage', async () => {
    const { host, server } = await setup()
    server.push(groupMessage(GROUP, '2002', [{ type: 'text', data: { text: 'anyone seen the match?' } }]))
    const triage = groupTriageSessionId('anima', '2026-11-10')
    await vi.waitFor(() => expect(host.inbox(triage)).toHaveLength(1))
    expect(host.inbox(triage)[0]).toContain('qq group "Test group (QQ)", 1 message nobody addressed to you')
  })

  it('turns pokes into waking messages and recalls into context', async () => {
    const { host, server } = await setup()
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: Number(OWNER), target_id: Number(ACCOUNT) })
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('Sam（主人） 对你说: [戳了戳你]')
    server.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: Number(GROUP), user_id: 2002, target_id: 2003 })
    server.push({ post_type: 'notice', notice_type: 'friend_recall', user_id: Number(OWNER), message_id: 5 })
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(2))
    expect(host.inbox(ownerSession)[1]).toMatch(/^\(inject\) .*\[事件\] Sam recalled a message \(msg 5\)\.（只是上下文，不需要回答。）$/)
    expect(host.sessions.has(groupSession)).toBe(false)
  })

  it('reads chat history for the current chat', async () => {
    const { ctx, server } = await setup()
    server.respond('get_friend_msg_history', () => ({ messages: [
      { message_id: 1, user_id: Number(OWNER), time: 1_762_740_000, sender: { nickname: 'sam' }, message: [{ type: 'text', data: { text: 'old one' } }] },
      { message_id: 2, user_id: Number(ACCOUNT), time: 1_762_740_060, sender: { nickname: 'Anima' }, message: [{ type: 'text', data: { text: 'my answer' } }] },
    ] }))
    const result = await callAs(ctx, ownerSession, 'qq_history', { count: 5 })
    expect(result.text).toMatch(/Sam \(owner\) \[msg 1\]: old one\n.* you \[msg 2\]: my answer$/)
    expect(server.callsOf('get_friend_msg_history')[0]!.params).toEqual({ user_id: Number(OWNER), count: 5 })
  })

  it('sends a list as messages in order, replyTo and mention on the first only, and reports a partial send', async () => {
    const { ctx, server } = await setup()
    const said = await callAs(ctx, ownerSession, 'qq_say', { text: '在的', also: ['怎么啦'], replyTo: '5' })
    expect(said.isError).toBe(false)
    expect(said.text).toMatch(/^sent 2 messages \(msg \d+, \d+\)$/)
    expect(server.callsOf('send_private_msg').map(call => call.params.message)).toEqual([
      [{ type: 'reply', data: { id: '5' } }, { type: 'text', data: { text: '在的' } }],
      [{ type: 'text', data: { text: '怎么啦' } }],
    ])
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: ' ' })).text).toContain('call end_turn instead')
    let n = 0
    server.respond('send_private_msg', () => {
      if (++n === 2) throw new Error('rate limited')
      return { message_id: 9500 + n }
    })
    const partial = await callAs(ctx, ownerSession, 'qq_say', { text: 'a', also: ['b', 'c'] })
    expect(partial.isError).toBe(true)
    expect(partial.text).toContain('anima/partly-sent: 1 of 3 messages went out (msg 9501); message 2 failed')
  })

  it('refuses qq_say outside QQ sessions and mentions in private chats', async () => {
    const { ctx } = await setup()
    expect((await callAs(ctx, selfSessionId('anima'), 'qq_say', { text: 'x' })).text).toContain('anima/wrong-session')
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'x', mention: ['2002'] })).text).toContain('mention works only in group chats')
    // open_conversation to a QQ group nobody published is refused by the gate, listing the real channels.
    expect((await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: `qq:${ACCOUNT}:group:999`, intent: 'hi' })).text).toContain(`anima/unknown-channel: 没有「qq:${ACCOUNT}:group:999」这个地方。你能去的地方：qq:${ACCOUNT}:private:${OWNER}`)
  })

  it('hands friend requests and owner replies to the outside', async () => {
    const { ctx, server, host } = await setup()
    server.respond('set_friend_add_request', () => null)
    // A stand-in for the outside: it takes the request, writes on the owner line, and consumes the owner's reply.
    let request: { summary: string; answer(accept: boolean): Promise<void> } | undefined
    ctx.on('anima/friend-request', (r) => { request = r; void ctx.anima.ownerLine!.send(`[Anima approval a1] ${r.summary}`); return true })
    ctx.on('anima/owner-message', text => text === 'yes a1' ? 'Allowed a1.' : undefined)
    server.push({ post_type: 'request', request_type: 'friend', user_id: 77777, comment: 'hi, from the book club', flag: 'f1' })
    await vi.waitFor(() => expect(server.callsOf('send_private_msg')).toHaveLength(1))
    const ask = server.callsOf('send_private_msg')[0]!
    expect(ask.params.user_id).toBe(Number(OWNER))
    expect(JSON.stringify(ask.params.message)).toContain('QQ user 77777 (\\"hi, from the book club\\") wants to add her')
    server.push(privateMessage(OWNER, 'yes a1'))
    await vi.waitFor(() => expect(JSON.stringify(server.callsOf('send_private_msg')[1]?.params.message)).toContain('Allowed a1.'))
    // The reply never reached her.
    expect(host.sessions.has(ownerSession)).toBe(false)
    await request!.answer(true)
    expect(server.callsOf('set_friend_add_request')[0]!.params).toEqual({ flag: 'f1', approve: true })
  })

  it('leaves a friend request unanswered when nothing outside takes it', async () => {
    const { ctx, server } = await setup()
    server.push({ post_type: 'request', request_type: 'friend', user_id: 77777, comment: '', flag: 'f1' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(server.callsOf('set_friend_add_request')).toHaveLength(0)
    expect(server.callsOf('send_private_msg')).toHaveLength(0)
  })

  it('reconnects after the runtime drops, and reports health', async () => {
    const { ctx, server } = await setup()
    server.push({ post_type: 'notice', notice_type: 'bot_offline', user_id: Number(ACCOUNT), tag: 'kicked', message: 'logged in elsewhere' })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('account OFFLINE'))
    expect(ctx.anima.statusLines().join('\n')).toContain('QQ last error: bot offline: logged in elsewhere')
    server.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000, status: { online: true, good: true } })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('account online'))

    server.dropAll()
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toMatch(/QQ: closed, retry in/))
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'x' })).text).toContain('anima/qq-offline')
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('connects 2'), { timeout: 4000 })
    await vi.waitFor(() => expect(server.callsOf('get_login_info')).toHaveLength(2))
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'back' })).isError).toBe(false)
  })

  it('drops a connection whose heartbeats stop', async () => {
    const { ctx, server } = await setup({ heartbeatGrace: 1.5 })
    server.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 100, status: { online: true } })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('heartbeat lost'), { timeout: 2000 })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('connects 2'), { timeout: 4000 })
  })

  it('refuses to deliver when logged in as another account', async () => {
    const server = new FakeOneBot('99999')
    const url = await server.listen()
    onTestFinished(() => server.close())
    const dataDir = mkdtempSync(join(tmpdir(), 'anima-qq-'))
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir })
    const host = new FakeHost()
    await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
    await ctx.plugin(qq, { url, account: ACCOUNT, owner: OWNER })
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toContain('QQ problem: the runtime is logged in as 99999'))
    server.push({ ...privateMessage(OWNER, 'hi'), self_id: 99999 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(host.sessions.size).toBe(0)
  })

  it('removes its registrations on unload', async () => {
    const { ctx, fiber, server } = await setup()
    expect(ctx.anima.behavior('qq_say')).toMatchObject({ platform: 'qq', effect: 'express' })
    await fiber.dispose()
    expect(ctx.anima.behavior('qq_say')).toBeUndefined()
    expect(ctx.tools.get('qq_history')).toBeUndefined()
    expect(ctx.anima.ownerLine).toBeUndefined()
    expect(ctx.anima.channelInfo(groupKey)).toBeUndefined()
    expect(ctx.anima.describeSession(ownerSession)).toBeUndefined()
    await vi.waitFor(() => expect(server.open).toBe(0))
  })
})
