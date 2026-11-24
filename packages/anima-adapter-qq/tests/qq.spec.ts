/** The QQ adapter over a fake backend: channels, stimuli, speech, history, friend requests, health, unload. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as qq from '../src/index.ts'
import type { QqSegment } from '../src/backend.ts'
import { textMessage } from './fake-backend.ts'
import { ACCOUNT, callAs, FRIEND, friendKey, GROUP, groupKey, groupSession, nextId, OWNER, ownerKey, ownerSession, plainSession, setup } from './helpers.ts'

const fromOwner = (text: string, messageId = nextId()) => textMessage('private', OWNER, OWNER, text, { messageId, displayName: 'sam' })
const inGroup = (userId: string, segments: QqSegment[], messageId = nextId(), group = GROUP) => textMessage('group', group, userId, segments, { messageId, displayName: 'Bob' })
const status = (ctx: Context) => ctx.anima.statusLines().join('\n')

describe('QQ adapter', () => {
  it('verifies the account and publishes every friend and group', async () => {
    const { ctx, backend } = await setup()
    expect(backend.callsOf('login')).toHaveLength(1)
    expect(ctx.anima.describeSession(ctx.animaLife.waking.current!)).toEqual({ kind: 'waking', current: true })
    expect(ctx.anima.channelInfo(ownerKey)).toMatchObject({ isOwner: true, display: 'Sam (QQ)' })
    // Every chat of the account, with its name; which ones may reach her is decided outside.
    expect(ctx.anima.channelInfo(groupKey)).toMatchObject({ isOwner: false, display: 'Test group (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:private:${FRIEND}`)).toMatchObject({ isOwner: false, display: 'Cat (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:group:999`)).toBeUndefined()
    expect(status(ctx)).not.toContain('allowlist')
    expect(ctx.anima.ownerLine?.name).toContain('QQ private chat with the owner')
  })

  it('delivers every chat, a new one included: the adapter filters nothing', async () => {
    const { ctx, host, backend } = await setup()
    backend.push(fromOwner('morning!'))
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toMatch(/\[QQ 私聊「Sam」 qq:10001:private:20002\] Sam（主人） \[msg \d+\] 对你说: morning!$/)
    backend.push(textMessage('private', FRIEND, FRIEND, 'hi there'))
    await vi.waitFor(() => expect(host.inbox(friendKey)).toHaveLength(1))
    backend.push(textMessage('private', '55555', '55555', 'spam', { displayName: 'someone' }))
    backend.push(inGroup('2002', [{ type: 'mention', userId: ACCOUNT }], nextId(), '999'))
    backend.push(textMessage('private', OWNER, ACCOUNT, 'my own echo'))
    // Every chat arrives in the one waking session; her own echo does not.
    await vi.waitFor(() => expect(host.all()).toHaveLength(4))
    expect([...host.sessions.keys()]).toHaveLength(1)
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:private:55555`)).toMatchObject({ display: 'someone (QQ)' })
    expect(ctx.anima.channelInfo(`qq:${ACCOUNT}:group:999`)).toMatchObject({ display: 'group 999 (QQ)' })
  })

  it('reaches her from a group when she is @-mentioned or replied to; other chatter waits unread', async () => {
    const { ctx, host, backend } = await setup({ life: { groups: { attentionSeconds: 0 } } })
    backend.push(inGroup('2002', [{ type: 'text', text: 'lunch?' }]))
    backend.push(inGroup('2002', [{ type: 'mention', userId: ACCOUNT }, { type: 'text', text: ' you in?' }]))
    await vi.waitFor(() => expect(host.inbox(groupSession)).toHaveLength(1))
    expect(host.inbox(groupSession)[0]).toMatch(/2 条消息（Bob 2 条）：\n  \d\d:\d\d Bob \[qq 2002, msg \d+\]: lunch\?\n  \d\d:\d\d Bob \[qq 2002, msg \d+\] 叫你: @Anima you in\?\n（群里所有人都会看到你的回答。）$/)
    // The chat that woke her is marked read (Phase 9).
    await vi.waitFor(() => expect(backend.callsOf('markRead').map(c => c.args)).toEqual([['group', GROUP]]))

    // She speaks; a reply to her message wakes the group.
    const said = await callAs(ctx, groupSession, 'qq_say', { text: 'sure!', replyTo: '7', mention: ['2002'] })
    expect(said.isError).toBe(false)
    expect(backend.callsOf('send')[0]!.args).toEqual(['group', GROUP, [{ type: 'reply', messageId: '7' }, { type: 'mention', userId: '2002' }, { type: 'text', text: ' ' }, { type: 'text', text: 'sure!' }]])
    const mine = /msg (\d+)/.exec(said.text)![1]!
    backend.push(inGroup('2002', [{ type: 'reply', messageId: mine }, { type: 'text', text: 'great' }]))
    await vi.waitFor(() => expect(host.inbox(groupSession)).toHaveLength(2))
    expect(host.inbox(groupSession)[1]).toContain(`(replying to you, msg ${mine}: "sure!") great`)

    // A reply to someone else's message is chatter (the backend says it is not hers).
    backend.respond('message', () => ({ kind: 'group', chatId: GROUP, userId: '2002', displayName: 'Bob', messageId: '1', segments: [] }))
    backend.push(inGroup('2002', [{ type: 'reply', messageId: '1' }, { type: 'text', text: 'lol' }]))
    await vi.waitFor(() => expect(ctx.animaLife.groups.unread()).toEqual({ [groupKey]: 1 }))
    expect(host.inbox(groupSession)).toHaveLength(2)
  })

  it('turns pokes into waking messages and recalls into context', async () => {
    const { host, backend } = await setup()
    backend.push({ type: 'poke', kind: 'private', chatId: OWNER, userId: OWNER, targetId: ACCOUNT })
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(1))
    expect(host.inbox(ownerSession)[0]).toContain('Sam（主人） 对你说: [戳了戳你]')
    backend.push({ type: 'poke', kind: 'group', chatId: GROUP, userId: '2002', targetId: '2003' })
    backend.push({ type: 'recall', kind: 'private', chatId: OWNER, operatorId: OWNER, messageId: '5' })
    await vi.waitFor(() => expect(host.inbox(ownerSession)).toHaveLength(2))
    expect(host.inbox(ownerSession)[1]).toMatch(/^\(inject\) .*\[事件\] Sam recalled a message \(msg 5\)\.（只是上下文，不需要回答。）$/)
    expect(host.inbox(groupSession)).toHaveLength(0)
  })

  it('reads a chat\'s history by its channel key', async () => {
    const { ctx, backend } = await setup()
    backend.respond('history', () => [
      { kind: 'private', chatId: OWNER, userId: OWNER, displayName: 'sam', messageId: '1', time: 1_762_740_000_000, segments: [{ type: 'text', text: 'old one' }] },
      { kind: 'private', chatId: OWNER, userId: ACCOUNT, displayName: 'Anima', messageId: '2', time: 1_762_740_060_000, segments: [{ type: 'text', text: 'my answer' }] },
    ])
    const result = await callAs(ctx, ownerSession, 'qq_history', { count: 5 })
    expect(result.text).toMatch(/Sam \(owner\) \[msg 1\]: old one\n.* you \[msg 2\]: my answer$/)
    expect(backend.callsOf('history')[0]!.args).toEqual(['private', OWNER, 5])
  })

  it('gives her life the chats\' history: the latest lines, or those before a message', async () => {
    const { ctx, backend } = await setup()
    backend.respond('history', () => [1, 2, 3].map(n => ({ kind: 'private', chatId: OWNER, userId: OWNER, displayName: 'sam', messageId: String(n), time: 1_762_740_000_000 + n, segments: [{ type: 'text', text: `line ${n}` }] })))
    const key = `qq:${ACCOUNT}:private:${OWNER}`
    expect((await ctx.animaLife.history(key, { count: 2 }))!.map(line => line.text)).toEqual(['line 2', 'line 3'])
    expect((await ctx.animaLife.history(key, { count: 5, before: '3' }))!.map(line => `${line.who}: ${line.text}`)).toEqual(['Sam (owner): line 1', 'Sam (owner): line 2'])
  })

  it('sends a list as messages in order, replyTo and mention on the first only, and reports a partial send', async () => {
    const { ctx, backend } = await setup()
    const said = await callAs(ctx, ownerSession, 'qq_say', { text: '在的', also: ['怎么啦'], replyTo: '5' })
    expect(said.isError).toBe(false)
    expect(said.text).toMatch(/^sent 2 messages \(msg \d+, \d+\)$/)
    expect(backend.callsOf('send').map(call => call.args[2])).toEqual([
      [{ type: 'reply', messageId: '5' }, { type: 'text', text: '在的' }],
      [{ type: 'text', text: '怎么啦' }],
    ])
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: ' ' })).text).toContain('call end_turn instead')
    let n = 0
    backend.respond('send', () => {
      if (++n === 2) throw new Error('rate limited')
      return String(9500 + n)
    })
    const partial = await callAs(ctx, ownerSession, 'qq_say', { text: 'a', also: ['b', 'c'] })
    expect(partial.isError).toBe(true)
    expect(partial.text).toContain('anima/partly-sent: 1 of 3 messages went out (msg 9501); message 2 failed')
  })

  it('refuses qq_say outside her sessions, to a chat that does not exist, and mentions in private chats', async () => {
    const { ctx } = await setup()
    expect((await callAs(ctx, plainSession, 'qq_say', { channel: ownerKey, text: 'x' })).text).toContain('anima/not-anima-session')
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'x', mention: ['2002'] })).text).toContain('mention works only in group chats')
    // A QQ group nobody published is refused by the body check, listing the real channels.
    expect((await callAs(ctx, ownerSession, 'qq_say', { channel: `qq:${ACCOUNT}:group:999`, text: 'hi' })).text).toContain(`anima/unknown-channel: 没有「qq:${ACCOUNT}:group:999」这个地方。你能去的地方：qq:${ACCOUNT}:private:${OWNER}`)
  })

  it('hands friend requests and owner replies to the outside', async () => {
    const { ctx, backend, host } = await setup()
    const answers: boolean[] = []
    // A stand-in for the outside: it takes the request, writes on the owner line, and consumes the owner's reply.
    let request: { summary: string; answer(accept: boolean): Promise<void> } | undefined
    ctx.on('anima/friend-request', (r) => { request = r; void ctx.anima.ownerLine!.send(`[Anima approval a1] ${r.summary}`); return true })
    ctx.on('anima/owner-message', text => text === 'yes a1' ? 'Allowed a1.' : undefined)
    backend.push({ type: 'friend-request', userId: '77777', comment: 'hi, from the book club', answer: async (accept) => { answers.push(accept) } })
    await vi.waitFor(() => expect(backend.callsOf('send')).toHaveLength(1))
    const ask = backend.callsOf('send')[0]!
    expect(ask.args.slice(0, 2)).toEqual(['private', OWNER])
    expect(JSON.stringify(ask.args[2])).toContain('QQ user 77777 (\\"hi, from the book club\\") wants to add her')
    backend.push(fromOwner('yes a1'))
    await vi.waitFor(() => expect(JSON.stringify(backend.callsOf('send')[1]?.args[2])).toContain('Allowed a1.'))
    // The reply never reached her.
    expect(host.sessions.has(ownerSession)).toBe(false)
    await request!.answer(true)
    expect(answers).toEqual([true])
  })

  it('leaves a friend request unanswered when nothing outside takes it, or the backend cannot answer', async () => {
    const { ctx, backend } = await setup()
    let asked = 0
    backend.push({ type: 'friend-request', userId: '77777', comment: '', answer: async () => {} })
    await new Promise(resolve => setTimeout(resolve, 30))
    ctx.on('anima/friend-request', () => { asked += 1; return true })
    backend.push({ type: 'friend-request', userId: '77778', comment: '' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(asked).toBe(0)
    expect(backend.callsOf('send')).toHaveLength(0)
  })

  it('reports health, refuses to send while down, and checks the login again on reconnect', async () => {
    const { ctx, backend } = await setup()
    backend.setOnline(false, 'bot offline: logged in elsewhere')
    await vi.waitFor(() => expect(status(ctx)).toContain('account OFFLINE'))
    expect(status(ctx)).toContain('QQ OFFLINE since')
    expect(status(ctx)).toContain('the runtime reports the QQ account offline (bot offline: logged in elsewhere)')
    backend.setOnline(true)
    await vi.waitFor(() => expect(status(ctx)).toContain('account online'))

    backend.drop()
    await vi.waitFor(() => expect(status(ctx)).toMatch(/QQ: closed/))
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'x' })).text).toContain('anima/qq-offline')
    backend.connect()
    await vi.waitFor(() => expect(backend.callsOf('login')).toHaveLength(2))
    await vi.waitFor(() => expect(status(ctx)).toContain('connects 2'))
    expect((await callAs(ctx, ownerSession, 'qq_say', { text: 'back' })).isError).toBe(false)
  })

  it('refuses to deliver when logged in as another account', async () => {
    const { ctx, host, backend } = await setup({ loggedInAs: '99999', ready: false })
    await vi.waitFor(() => expect(status(ctx)).toContain('QQ problem: the runtime is logged in as 99999'))
    backend.push(fromOwner('hi'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(host.all()).toEqual([])
  })

  it('registers no behavior the backend cannot do', async () => {
    const { ctx } = await setup({ without: ['history', 'poke', 'react'] })
    for (const name of [qq.HISTORY_TOOL, qq.POKE_TOOL, qq.REACT_TOOL]) expect(ctx.anima.behavior(name)).toBeUndefined()
    for (const name of [qq.SAY_TOOL, qq.LOOK_TOOL, qq.FORWARD_TOOL]) expect(ctx.anima.behavior(name)).toBeDefined()
  })

  it('removes its registrations on unload and stops the backend', async () => {
    const { ctx, fiber, backend } = await setup()
    expect(ctx.anima.behavior('qq_say')).toMatchObject({ platform: 'qq', effect: 'express' })
    await fiber.dispose()
    expect(ctx.anima.behavior('qq_say')).toBeUndefined()
    expect(ctx.tools.get('qq_history')).toBeUndefined()
    expect(ctx.anima.ownerLine).toBeUndefined()
    expect(ctx.anima.channelInfo(groupKey)).toBeUndefined()
    expect(ctx.anima.describeSession(ownerSession)).toBeUndefined()
    expect(backend.started).toBe(false)
  })
})
