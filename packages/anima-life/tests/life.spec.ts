import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { stimulusText, wakingSessionId } from '../src/index.ts'
import { ALICE, ALICE_KEY, at, callAs, event, message, OWNER, OWNER_KEY, settle, setup } from './helpers.ts'

const HOUR = 3_600_000

describe('one waking session for everything', () => {
  it('opens her first waking with what is true when she wakes', async () => {
    const { ctx, host, current, recorded } = await setup('2026-11-10T08:00')
    const id = ctx.animaLife.waking.current!
    expect(id).toBe(wakingSessionId('anima', at('2026-11-10T08:00')))
    expect(host.order).toEqual([id])
    expect(current().inbox).toHaveLength(1)
    expect(current().inbox[0]).toMatch(/^\[Tue 2026-11-10 08:00\] \[醒来\]\n现在是 2026-11-10 08:00。你醒着。这是你第一次在这里醒来。\n收件箱是空的。$/)
    expect(current().title).toBe('Anima · 11-10 08:00')
    expect(ctx.anima.describeSession(id)).toEqual({ kind: 'waking', current: true })
    expect(recorded.filter(r => r.type === 'wake')).toEqual([expect.objectContaining({ stimulus: 'waking', session: 'waking', sessionId: id })])
  })

  it('takes every chat into the same session, each arrival naming its place and channel key', async () => {
    const { ctx, clock, current, stimuli } = await setup('2026-11-10T08:00')
    clock.now = at('2026-11-10T09:00')
    await ctx.animaLife.deliver(message(ALICE, '今天去看展了', clock.now))
    await ctx.animaLife.deliver(message(OWNER, '在吗', clock.now))
    await ctx.animaLife.deliver({ type: 'channel-event', channel: ALICE, text: 'Alice 撤回了一条消息', ts: clock.now })
    expect(current().inbox.slice(1)).toEqual([
      '[Tue 2026-11-10 09:00] [demo 私聊「Alice」 demo:me:private:alice] Alice 对你说: 今天去看展了',
      '[Tue 2026-11-10 09:00] [demo 私聊「Sam」 demo:me:private:owner] Sam（主人） 对你说: 在吗',
      '(inject) [Tue 2026-11-10 09:00] [demo 私聊「Alice」 demo:me:private:alice] [事件] Alice 撤回了一条消息（只是上下文，不需要回答。）',
    ])
    expect(stimuli.filter(s => s.type === 'message').map(s => s.delivery)).toEqual(['wake', 'wake'])
    expect(ctx.animaLife.lastHeard(ALICE_KEY)).toBe(clock.now)
  })

  it('gives a plain DSH session nothing of hers', async () => {
    const { ctx } = await setup('2026-11-10T08:00')
    expect(ctx.anima.describeSession('plain-dsh')).toBeUndefined()
    expect((await callAs(ctx, 'plain-dsh', 'wait', { seconds: 1 })).isError).toBe(true)
  })
})

describe('falling asleep and waking', () => {
  async function asleepAt(time: string) {
    const env = await setup('2026-11-10T08:00')
    const { ctx, clock, host } = env
    const first = ctx.animaLife.waking.current!
    host.alarms.set('s1', first)
    clock.now = at(time)
    event(ctx, first, 'turn/start')
    const slept = await callAs(ctx, first, 'sleep', { note: '今天看了展' })
    expect(slept.text).toBe('你睡着了。')
    await settle()
    return { ...env, first, next: ctx.animaLife.waking.current! }
  }

  it('prepares the next waking, moves her alarms, and archives the ended session after its last turn', async () => {
    const { ctx, host, first, next, recorded } = await asleepAt('2026-11-10T20:00')
    expect(next).toBe(wakingSessionId('anima', at('2026-11-10T20:00')))
    expect(host.sessions.get(next)).toMatchObject({ preset: 'anima-waking', inbox: [], title: 'Anima · next waking' })
    expect(host.alarms.get('s1')).toBe(next)
    // The sleep call's turn is still running: archive waits for it.
    expect(host.archived.has(first)).toBe(false)
    event(ctx, first, 'turn/end')
    await settle()
    expect(host.archived.has(first)).toBe(true)
    expect(recorded.filter(r => r.type === 'waking-open' || r.type === 'waking-archive').map(r => r.type)).toEqual(['waking-open', 'waking-archive'])
  })

  it('holds chats in her inbox while she sleeps, and opens the next waking when she is rested', async () => {
    const { ctx, clock, host, first, next, stimuli } = await asleepAt('2026-11-10T20:00')
    event(ctx, first, 'turn/end')
    clock.now = at('2026-11-10T22:00')
    await ctx.animaLife.deliver(message(ALICE, '睡了吗', clock.now))
    expect(host.sessions.get(next)!.inbox).toEqual([])
    expect(stimuli.at(-1)).toMatchObject({ type: 'message', delivery: 'record' })
    expect(ctx.animaLife.inbox.size()).toBe(1)
    await ctx.animaLife.beat()
    expect(host.sessions.get(next)!.inbox).toEqual([])
    // 0.75 at 20:00 (0.15 at 08:00, rising 0.05 an hour), falling 0.1 an hour: rested at 02:30.
    clock.now = at('2026-11-11T02:20')
    ctx.anima.checkSleep()
    expect(ctx.anima.asleep()).toBe(true)
    clock.now = at('2026-11-11T02:40')
    ctx.anima.checkSleep()
    await settle()
    expect(ctx.anima.asleep()).toBe(false)
    const opening = host.sessions.get(next)!.inbox[0]!
    expect(opening).toContain('[醒来]\n现在是 2026-11-11 02:40。你睡醒了。')
    expect(opening).toContain('你 2026-11-10 20:00 睡着（你自己上床睡的），睡了 6 h 40 min。睡前你写下：「今天看了展」')
    expect(opening).toContain('收件箱：Alice 1 条（最后 22:00，channel "demo:me:private:alice"）。')
    expect(opening).toContain('最近联系过的地方：[demo 私聊「Alice」 demo:me:private:alice]（最后 11-10 22:00）')
    // The chat writes again: what waited comes with the new message, marked.
    await ctx.animaLife.deliver(message(ALICE, '醒了没', clock.now))
    const burst = host.sessions.get(next)!.inbox[1]!
    expect(burst).toContain('Alice发来 2 条：')
    expect(burst).toContain('22:00（你睡着时收到） 睡了吗')
    expect(ctx.animaLife.inbox.size()).toBe(0)
  })

  it('is woken by the owner at night into the prepared session', async () => {
    const { ctx, clock, host, next } = await asleepAt('2026-11-10T20:00')
    clock.now = at('2026-11-10T21:00')
    expect(ctx.anima.wakeByOwner()).toEqual({ woken: true })
    await settle()
    expect(host.sessions.get(next)!.inbox[0]).toContain('现在是 2026-11-10 21:00。主人把你叫醒了。')
    expect(host.sessions.get(next)!.title).toBe('Anima · 11-10 21:00')
  })

  it('wakes her by an alarm that rings while she sleeps, with the waking context first', async () => {
    const { ctx, clock, next } = await asleepAt('2026-11-10T20:00')
    clock.now = at('2026-11-10T23:00')
    const alarm = createUserMessage({ content: [{ type: 'text', text: 'reminder_prompt_json: "叫主人起床"' }], source: { kind: 'schedule' } as never })
    const decision = await (ctx.animaLife as unknown as { preStep: (p: unknown, n: () => Promise<unknown>) => Promise<{ messages: { content: { text: string }[] }[] }> })
      .preStep({ agent: { id: next }, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [alarm] }))
    expect(ctx.anima.sleepInfo()).toMatchObject({ asleep: false, by: 'alarm' })
    const texts = decision.messages.map(m => m.content[0]!.text)
    expect(texts[0]).toContain('你定的闹钟把你叫醒了。')
    expect(texts[1]).toBe('reminder_prompt_json: "叫主人起床"')
    expect(texts[2]).toBe('[Tue 2026-11-10 23:00] [闹钟] 你定的闹钟响了：「叫主人起床」')
    expect(ctx.animaLife.waking.opened).toBe(true)
  })

  it('does not take DSH\'s notice that an alarm was moved for an alarm', async () => {
    const { ctx, clock, next } = await asleepAt('2026-11-10T20:00')
    clock.now = at('2026-11-10T21:00')
    const notice = createUserMessage({ content: [{ type: 'text', text: '[SCHEDULE CHANGE]\nA scheduled task involving this session was changed outside this session. This notice is not a delivery of the task and needs no action.' }], source: { kind: 'schedule' } as never })
    const decision = await (ctx.animaLife as unknown as { preStep: (p: unknown, n: () => Promise<unknown>) => Promise<{ messages: unknown[] }> })
      .preStep({ agent: { id: next }, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [notice] }))
    expect(ctx.anima.asleep()).toBe(true)
    expect(decision.messages).toHaveLength(1)
  })

  it('rings an alarm that DSH had queued in the ended waking in her new one instead, and it wakes her there', async () => {
    const { ctx, clock, host, first, next } = await asleepAt('2026-11-10T20:00')
    clock.now = at('2026-11-10T20:05')
    const alarm = createUserMessage({ content: [{ type: 'text', text: 'reminder_prompt_json: "看看 Sam 写完没"' }], source: { kind: 'schedule' } as never })
    const decision = await (ctx.animaLife as unknown as { preStep: (p: unknown, n: () => Promise<unknown>) => Promise<{ kind: string }> })
      .preStep({ agent: { id: first }, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [alarm] }))
    await settle()
    expect(decision).toEqual({ kind: 'reject' })
    expect(ctx.anima.sleepInfo()).toMatchObject({ asleep: false, by: 'alarm' })
    const opening = host.sessions.get(next)!.inbox[0]!
    expect(opening).toContain('你定的闹钟把你叫醒了。')
    expect(opening).toContain('[闹钟] 你定的闹钟响了：「看看 Sam 写完没」')
    expect(ctx.animaLife.waking.current).toBe(next)
  })

  it('makes the next waking hers the moment she falls asleep, before its session exists', async () => {
    const { ctx, clock } = await setup('2026-11-10T08:00')
    const first = ctx.animaLife.waking.current!
    clock.now = at('2026-11-10T20:00')
    const sleeping = ctx.animaLife.waking.sleep(clock.now, () => true)
    expect(ctx.animaLife.waking.current).toBe(wakingSessionId('anima', clock.now))
    expect(ctx.anima.describeSession(first)).toEqual({ kind: 'waking', current: false })
    await sleeping
  })

  it('lets overwhelming sleep wait for a turn still running in the waking that just ended', async () => {
    const { ctx, clock } = await setup('2026-11-10T07:00')
    const first = ctx.animaLife.waking.current!
    clock.now = at('2026-11-10T20:00')
    event(ctx, first, 'turn/start')
    await callAs(ctx, first, 'sleep', {})
    await settle()
    // She woke at once (an alarm, the owner), while the ended session's turn still runs.
    ctx.anima.wakeByOwner()
    await settle()
    clock.now = at('2026-11-11T01:00')
    ctx.anima.checkSleep()
    expect(ctx.anima.asleep()).toBe(false)
    event(ctx, first, 'turn/end')
    await settle()
    expect(ctx.anima.sleepInfo().by).toBe('overwhelmed')
  })

  it('is taken by sleep when it overwhelms her, once her turn ends', async () => {
    const { ctx, clock, current } = await setup('2026-11-10T07:00')
    const id = ctx.animaLife.waking.current!
    event(ctx, id, 'turn/start')
    clock.now = at('2026-11-10T23:30')
    ctx.anima.checkSleep()
    expect(ctx.anima.asleep()).toBe(false)
    event(ctx, id, 'turn/end')
    await settle()
    expect(ctx.anima.sleepInfo().by).toBe('overwhelmed')
    expect(ctx.animaLife.waking.current).not.toBe(id)
    expect(current().id).not.toBe(id)
  })
})

describe('her heartbeat', () => {
  it('stirs her awake and idle with her state; beats without a turn asleep or while she is in one', async () => {
    const { ctx, clock, current } = await setup('2026-11-10T08:00')
    const id = ctx.animaLife.waking.current!
    clock.now = at('2026-11-10T09:00')
    await ctx.animaLife.beat()
    expect(current().inbox[1]).toMatch(/^\[Tue 2026-11-10 09:00\] \[心跳\]\nTime Tue 2026-11-10 09:00\.\nsleep pressure 0\.20; energy/)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T10:00'))
    event(ctx, id, 'turn/start')
    await ctx.animaLife.beat()
    expect(current().inbox).toHaveLength(2)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T10:00'))
  })
})

describe('wait', () => {
  it('returns at once when anything arrives, from any chat, and keeps the turn open', async () => {
    const { ctx, clock } = await setup('2026-11-10T08:00')
    const id = ctx.animaLife.waking.current!
    const waiting = callAs(ctx, id, 'wait', { seconds: 600, channel: OWNER_KEY })
    await settle()
    await ctx.animaLife.deliver(message(ALICE, '在吗', clock.now))
    const result = await waiting
    expect(result).toMatchObject({ isError: false, text: '有新消息到了。', concludes: false })
  })

  it('ends the turn when the time runs out with nothing new', async () => {
    const { ctx } = await setup('2026-11-10T08:00')
    const result = await callAs(ctx, ctx.animaLife.waking.current!, 'wait', { seconds: 1 })
    expect(result).toMatchObject({ text: '等到了时间，什么也没来。', concludes: true })
  })
})

describe('speaking anywhere', () => {
  it('says on any channel by its key; a chat she speaks in leaves her inbox', async () => {
    const env = await setup('2026-11-10T08:00')
    const { ctx, clock, sent, recorded } = env
    clock.now = at('2026-11-10T20:00')
    await callAs(ctx, ctx.animaLife.waking.current!, 'sleep', {})
    await settle()
    await ctx.animaLife.deliver(message(ALICE, '明天见', clock.now))
    ctx.anima.wakeByOwner()
    await settle()
    const here = ctx.animaLife.waking.current!
    expect((await callAs(ctx, here, 'inbox_read', {})).text).toContain('[demo 私聊「Alice」 demo:me:private:alice] 1 条：')
    await callAs(ctx, here, 'demo_say', { channel: ALICE_KEY, text: '明天见！' })
    expect(sent).toEqual([{ channel: ALICE_KEY, texts: ['明天见！'] }])
    expect(ctx.animaLife.inbox.size()).toBe(0)
    expect(recorded.filter(r => r.type === 'inbox-release')).toEqual([expect.objectContaining({ channel: ALICE_KEY, reason: 'said', count: 1 })])
    expect(ctx.animaLife.lastSpoke(ALICE_KEY)).toBe(clock.now)
  })

  it('formats a waking arrival as facts', () => {
    expect(stimulusText({ type: 'waking', text: '你睡醒了。', ts: 0 })).toBe('[醒来]\n你睡醒了。')
    expect(stimulusText({ type: 'heartbeat', text: 'Time x.', ts: 0 })).toBe('[心跳]\nTime x.')
  })
})

describe('restart', () => {
  it('keeps her waking session across a restart, and does not open it twice', async () => {
    const first = await setup('2026-11-10T08:00')
    const id = first.ctx.animaLife.waking.current!
    first.ctx.fiber.dispose()
    const second = await setup('2026-11-10T09:00', { dataDir: first.dataDir })
    expect(second.ctx.animaLife.waking.current).toBe(id)
    // The new host (a fresh DSH process here) resolves nothing, so it is made again under the same id, but not opened twice.
    expect(second.host.order).toEqual([id])
    // A beat that came due while it was down stirs her; the waking is not opened again.
    expect(second.current().inbox.every(text => !text.includes('[醒来]'))).toBe(true)
  })
})

void HOUR
