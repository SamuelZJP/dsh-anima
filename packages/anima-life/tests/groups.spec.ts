import { describe, expect, it } from 'vitest'
import { GroupBuffers, type MessageStimulus } from '../src/index.ts'
import { at, callAs, GROUP, GROUP_KEY, message, settle, setup } from './helpers.ts'

const line = (text: string, ts: number, id: string, extra: Partial<MessageStimulus> = {}) => message(GROUP, text, ts, { messageId: id, ...extra }) as MessageStimulus

describe('group buffers', () => {
  it('keeps the last lines per group, counts unread, and marks a group read when she reads it', () => {
    const buffers = new GroupBuffers(3)
    for (let i = 1; i <= 4; i++) buffers.add(line(`m${i}`, i, `${i}`))
    expect(buffers.unread()).toEqual({ [GROUP_KEY]: 3 })
    const glance = buffers.glance(2)
    expect(glance.groups[0]!.latest.map(m => m.text)).toEqual(['m3', 'm4'])
    expect(glance.fresh.map(m => m.text)).toEqual(['m3', 'm4'])
    // A second glance shows the same lines but nothing new to her.
    expect(buffers.glance(2).fresh).toEqual([])
    const read = buffers.read(GROUP_KEY, 10)!
    expect(read.lines.map(m => m.text)).toEqual(['m2', 'm3', 'm4'])
    expect(read.fresh.map(m => m.text)).toEqual(['m2'])
    expect(buffers.unread()).toEqual({})
    expect(buffers.read(GROUP_KEY, 1, '4')!.lines.map(m => m.text)).toEqual(['m3'])
    expect(buffers.read('demo:me:group:none', 5)).toBeUndefined()
  })
})

describe('groups in her waking session', () => {
  it('keeps unaddressed lines out of her session until she glances or reads, and records only what she saw', async () => {
    const { ctx, clock, current, stimuli } = await setup('2026-11-10T08:00')
    const id = ctx.animaLife.waking.current!
    const before = current().inbox.length
    clock.now = at('2026-11-10T09:00')
    for (let i = 1; i <= 5; i++) await ctx.animaLife.deliver(line(`闲聊 ${i}`, clock.now + i * 60_000, `${i}`))
    expect(current().inbox).toHaveLength(before)
    expect(stimuli.filter(s => s.type === 'message')).toEqual([])
    const glance = await callAs(ctx, id, 'groups_glance')
    expect(glance.text).toBe([
      '[demo 群「Book club」 demo:me:group:club] 5 条未读，最近的：',
      '  09:03 Alice [demo alice, msg 3]: 闲聊 3',
      '  09:04 Alice [demo alice, msg 4]: 闲聊 4',
      '  09:05 Alice [demo alice, msg 5]: 闲聊 5',
    ].join('\n'))
    expect(stimuli.filter(s => s.type === 'message').map(s => `${s.delivery}:${s.text}`)).toEqual(['context:闲聊 3', 'context:闲聊 4', 'context:闲聊 5'])
    const read = await callAs(ctx, id, 'group_read', { channel: GROUP_KEY, count: 1, before: '3' })
    expect(read.text).toBe('[demo 群「Book club」 demo:me:group:club]（更早的还有）：\n  09:02 Alice [demo alice, msg 2]: 闲聊 2')
    expect(stimuli.filter(s => s.type === 'message').map(s => s.text)).toEqual(['闲聊 3', '闲聊 4', '闲聊 5', '闲聊 2'])
    expect((await callAs(ctx, id, 'groups_glance')).text).toBe('没有未读的群消息。')
  })

  it('brings the unseen lines along when someone in the group addresses her', async () => {
    const { ctx, clock, current } = await setup('2026-11-10T08:00')
    await ctx.animaLife.deliver(line('有人看过这本书吗', clock.now, '1'))
    await ctx.animaLife.deliver(line('@Anima 你看过吗', clock.now + 60_000, '2', { addressed: true }))
    const burst = current().inbox.at(-1)!
    expect(burst).toContain('[demo 群「Book club」 demo:me:group:club] 2 条消息（Alice 2 条）：')
    expect(burst).toContain('有人看过这本书吗')
    expect(burst).toContain('Alice [demo alice, msg 2] 叫你: @Anima 你看过吗')
    expect(burst).toContain('（群里所有人都会看到你的回答。）')
    expect(ctx.animaLife.groups.unread()).toEqual({})
  })

  it('lets a group\'s new lines reach her for a while after she spoke there, unless the outside holds them', async () => {
    const { ctx, clock, current, outside } = await setup('2026-11-10T08:00')
    const id = ctx.animaLife.waking.current!
    await callAs(ctx, id, 'demo_say', { channel: GROUP_KEY, text: '我看过！' })
    await ctx.animaLife.deliver(line('真的吗', clock.now, '7'))
    await settle()
    expect(current().inbox.at(-1)).toContain('（这条没有叫你；你刚在这个群里说过话，所以它直接到了你这里。）')
    outside.refuse = request => request.kind === 'wake' ? { reason: 'quota' } as never : undefined
    const count = current().inbox.length
    await ctx.animaLife.deliver(line('讲讲？', clock.now, '8'))
    await settle()
    expect(current().inbox).toHaveLength(count)
    expect(ctx.animaLife.groups.unread()).toEqual({ [GROUP_KEY]: 1 })
  })
})
