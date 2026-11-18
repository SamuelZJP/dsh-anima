import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { closesTurn, costOf, primerText, SAY_META, SAY_PARAMETERS, sayMessages, type BehaviorMeta } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupCore, textOf } from './helpers.ts'

const chat = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '2' }, channelKey: 'qq:1:private:2' } as const

async function withSay(config: Parameters<typeof setupCore>[0] = {}) {
  const ctx = await setupCore(config)
  provideSessions(ctx, { c1: chat })
  const sent: string[][] = []
  ctx.anima.registerBehavior(defineTool({
    name: 'qq_say',
    description: 'say',
    parameters: { ...SAY_PARAMETERS },
    output: { schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', required: true } } }, render: (_a, v) => [{ type: 'text', text: `sent ${v.n}` }] },
    async execute(args) {
      sent.push(sayMessages(args))
      return { n: sayMessages(args).length }
    },
  }), { platform: 'qq', effect: 'express', sessions: ['conversation'], ...SAY_META })
  return { ctx, sent }
}

describe('say helpers (DESIGN §6, Turn shape)', () => {
  it('reads one message or a list, dropping blanks', () => {
    expect(sayMessages({ text: 'hi' })).toEqual(['hi'])
    expect(sayMessages({ text: 'a', also: [' ', 'b '] })).toEqual(['a', 'b'])
    expect(sayMessages({ text: ['x', 'y'] })).toEqual(['x', 'y'])
    expect(sayMessages({})).toEqual([])
  })

  it('closes unless more: true, and costs one per say', () => {
    const meta: BehaviorMeta = { effect: 'express', sessions: ['conversation'], ...SAY_META }
    expect(closesTurn(meta, { text: 'x' })).toBe(true)
    expect(closesTurn(meta, { text: 'x', more: true })).toBe(false)
    expect(costOf(meta, { text: 'a', also: ['b', 'c'] })).toBe(1)
    expect(costOf(meta, { text: '' })).toBe(1)
    expect(closesTurn({ effect: 'express', sessions: ['conversation'] })).toBe(false)
    expect(costOf({ effect: 'express', sessions: ['conversation'], cost: 2 })).toBe(2)
  })
})

describe('closing behaviors through the pipeline', () => {
  it('concludes the turn after a successful say, not with more: true', async () => {
    const { ctx, sent } = await withSay()
    const closing = await callAs(ctx, 'c1', 'qq_say', { text: '在的' })
    expect(closing.isError).toBe(false)
    expect(closing.concludesTurn).toBe(true)
    const open = await callAs(ctx, 'c1', 'qq_say', { text: '等下', also: ['我看看'], more: true })
    expect(open.isError).toBe(false)
    expect(open.concludesTurn).toBeUndefined()
    expect(sent).toEqual([['在的'], ['等下', '我看看']])
  })

  it('leaves the turn open for behaviors without closes', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { c1: chat })
    registerEcho(ctx, 'qq_poke', { platform: 'qq', effect: 'express', sessions: ['conversation'] })
    const result = await callAs(ctx, 'c1', 'qq_poke')
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBeUndefined()
  })
})

describe('environment primer (DESIGN §9)', () => {
  async function world() {
    const ctx = await setupCore()
    const channels: Record<string, { isOwner: boolean; display: string; note?: string }> = {
      'qq:1:private:2': { isOwner: true, display: 'Sam' },
      'qq:1:group:9': { isOwner: false, display: 'Book club' },
      'demo:owner:private:owner': { isOwner: true, display: 'Owner (demo)', note: '主人在网页里读这个聊天。' },
    }
    ctx.anima.provideChannels(key => channels[key], () => Object.keys(channels))
    const qqPrivate = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '2' }, channelKey: 'qq:1:private:2' } as const
    const qqGroup = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'group', id: '9' }, channelKey: 'qq:1:group:9' } as const
    const local = { kind: 'conversation', channel: { platform: 'demo', account: 'owner', kind: 'private', id: 'owner' }, channelKey: 'demo:owner:private:owner' } as const
    provideSessions(ctx, { p: qqPrivate, g: qqGroup, l: local, s: { kind: 'self' } })
    const conv = { sessions: ['conversation'] } as const
    registerEcho(ctx, 'qq_say', { platform: 'qq', effect: 'express', ...conv, ...SAY_META })
    registerEcho(ctx, 'qq_poke', { platform: 'qq', effect: 'express', ...conv })
    registerEcho(ctx, 'qq_look', { platform: 'qq', effect: 'observe', ...conv })
    registerEcho(ctx, 'demo_say', { platform: 'demo', effect: 'express', ...conv, ...SAY_META })
    registerEcho(ctx, 'end_turn', { effect: 'internal', ...conv, closes: true })
    registerEcho(ctx, 'memory_recall', { effect: 'observe', sessions: ['conversation', 'self'] })
    registerEcho(ctx, 'open_conversation', { effect: 'initiate', sessions: ['self'] })
    registerEcho(ctx, 'rest', { effect: 'internal', sessions: ['self', 'triage'], closes: true })
    registerEcho(ctx, 'bili_feed', { platform: 'bili', effect: 'observe', sessions: ['self'] })
    return ctx
  }
  const text = (ctx: Awaited<ReturnType<typeof world>>, id: string, kind: 'conversation' | 'self') => animaPrimer(ctx, id, kind)

  it('tells a QQ private chat with the owner where she is and how to speak and close', async () => {
    const ctx = await world()
    const t = text(ctx, 'p', 'conversation')
    expect(t).toContain('- 这里是 QQ 私聊「Sam」（频道 `qq:1:private:2`）。')
    expect(t).toContain('- 这是和主人的私聊：只有你们两个，对方就是主人。')
    expect(t).toContain('- 怎么说话：`qq_say`。')
    expect(t).toContain('- 不说话或不再说：`end_turn`，它结束这一轮。')
    expect(t).toContain('- 其他动作（不结束这一轮）：`qq_poke`。')
    expect(t).toContain('- 能看的：`qq_look`、`memory_recall`。')
    // No limits of her own: what may stop her here is told only from outside.
    expect(t).not.toContain('外面可能拦住你的事')
    expect(t).not.toContain('demo_say')
    expect(t).not.toContain('open_conversation')
  })

  it('says everyone in a group reads her, and gives a chat its adapter note', async () => {
    const ctx = await world()
    const group = text(ctx, 'g', 'conversation')
    expect(group).toContain('- 这里是 QQ 群「Book club」')
    expect(group).toContain('群里每个人都读得到你发的每条消息')
    expect(group).toContain('只会在这个群里再想起来')
    const local = text(ctx, 'l', 'conversation')
    expect(local).toContain('- 主人在网页里读这个聊天。')
    expect(local).toContain('- 怎么说话：`demo_say`。')
    expect(local).not.toContain('qq_')
  })

  it('tells Self which platforms it can reach and which it can only watch', async () => {
    const ctx = await world()
    const t = text(ctx, 's', 'self')
    expect(t).toContain('- 这里是你的 Self：你的内心。')
    expect(t).toContain('- QQ：你能联系 2 个频道，用 `open_conversation` 去那里说话。')
    expect(t).toContain('- demo：你能联系 1 个频道')
    expect(t).toContain('- B站：你只能看，那里没有人看得到你，你也不能在那里说话。')
    expect(t).toContain('- 去和人说话：`open_conversation`。')
    expect(t).toContain('- 结束：`rest`。')
    expect(t).not.toContain('qq_say')
  })

  it('is the persona section of the session, with optional runtime context suppressed', async () => {
    const ctx = await world()
    const key = { id: 'p' } as never
    const { createScope } = await import('@deepseek-ai/dsh-scope')
    const persona = await import('../src/persona.ts')
    let scope!: { ctx: typeof ctx }
    await ctx.plugin(Object.assign((inner: typeof ctx) => { scope = createScope(inner, key) as never }, { inject: ['tools', 'systemPrompt', 'anima'] }))
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const spy = vi.spyOn(SystemPrompt.prototype, 'section')
    onTestFinished(() => spy.mockRestore())
    await scope.ctx.plugin(persona, { kind: 'conversation' })
    const section = spy.mock.calls.map(([sec]) => sec).find(sec => sec.complete === true)!
    const textOf = section.text as (context: object) => string
    expect(textOf({ agent: key })).toContain('- 这里是 QQ 私聊「Sam」')
    expect(textOf({ agent: { id: 'g' } })).toContain('- 这里是 QQ 群「Book club」')
    // Optional runtime contexts are dropped in her sessions; required ones stay.
    ctx.systemPrompt.context({ name: 'harness-dev', order: 10, text: 'checkout at /x' })
    ctx.systemPrompt.context({ name: 'cwd', order: 11, text: 'cwd /y', required: true })
    const refreshed = ctx.systemPrompt.refreshContext({ sections: [], tools: [], variables: {}, contexts: [{ name: 'harness-dev', text: 'x' }, { name: 'cwd', text: 'y' }] } as never, { scope: key } as never)
    expect(refreshed.contexts.map(c => c.name)).toEqual(['cwd', 'anima-self-model'])
  })
})

function animaPrimer(ctx: Awaited<ReturnType<typeof setupCore>>, id: string, kind: 'conversation' | 'self'): string {
  return primerText('# Rin', ctx.anima.placeFacts(id, kind))
}
