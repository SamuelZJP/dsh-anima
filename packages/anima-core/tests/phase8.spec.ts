import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { closesTurn, costOf, primerText, SAY_META, SAY_PARAMETERS, sayMessages, type BehaviorMeta } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupCore, textOf } from './helpers.ts'

const waking = { kind: 'waking', current: true } as const

async function withSay(config: Parameters<typeof setupCore>[0] = {}) {
  const ctx = await setupCore(config)
  provideSessions(ctx, { c1: waking })
  ctx.anima.provideChannels(key => key === 'qq:1:private:2' ? { isOwner: true } : undefined, () => ['qq:1:private:2'])
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
  }), { platform: 'qq', effect: 'express', sessions: ['waking'], ...SAY_META })
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
    const meta: BehaviorMeta = { effect: 'express', sessions: ['waking'], ...SAY_META }
    expect(closesTurn(meta, { text: 'x' })).toBe(true)
    expect(closesTurn(meta, { text: 'x', more: true })).toBe(false)
    expect(costOf(meta, { text: 'a', also: ['b', 'c'] })).toBe(1)
    expect(costOf(meta, { text: '' })).toBe(1)
    expect(closesTurn({ effect: 'express', sessions: ['waking'] })).toBe(false)
    expect(costOf({ effect: 'express', sessions: ['waking'], cost: 2 })).toBe(2)
    expect(meta.target?.({ channel: ' qq:1:private:2 ' })).toBe('qq:1:private:2')
  })
})

describe('closing behaviors through the pipeline', () => {
  it('concludes the turn after a successful say, not with more: true', async () => {
    const { ctx, sent } = await withSay()
    const closing = await callAs(ctx, 'c1', 'qq_say', { channel: 'qq:1:private:2', text: '在的' })
    expect(closing.isError).toBe(false)
    expect(closing.concludesTurn).toBe(true)
    const open = await callAs(ctx, 'c1', 'qq_say', { channel: 'qq:1:private:2', text: '等下', also: ['我看看'], more: true })
    expect(open.isError).toBe(false)
    expect(open.concludesTurn).toBeUndefined()
    expect(sent).toEqual([['在的'], ['等下', '我看看']])
    // A channel that does not exist is her body's plumbing: there is nowhere to say it.
    expect(textOf(await callAs(ctx, 'c1', 'qq_say', { channel: 'qq:1:private:9', text: 'x' }))).toMatch(/^Error: anima\/unknown-channel/)
  })

  it('leaves the turn open for behaviors without closes', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { c1: waking })
    registerEcho(ctx, 'qq_poke', { platform: 'qq', effect: 'express', sessions: ['waking'] })
    const result = await callAs(ctx, 'c1', 'qq_poke')
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBeUndefined()
  })
})

describe('environment primer (docs/design/persona.md)', () => {
  async function world() {
    const ctx = await setupCore()
    const channels: Record<string, { isOwner: boolean; display: string }> = {
      'qq:1:private:2': { isOwner: true, display: 'Sam' },
      'qq:1:private:3': { isOwner: false, display: 'Alice' },
      'qq:1:group:9': { isOwner: false, display: 'Book club' },
    }
    ctx.anima.provideChannels(key => channels[key], () => Object.keys(channels))
    provideSessions(ctx, { w: { kind: 'waking', current: true }, m: { kind: 'consolidation' } })
    const awake = { sessions: ['waking'] } as const
    registerEcho(ctx, 'qq_say', { platform: 'qq', effect: 'express', ...awake, ...SAY_META })
    registerEcho(ctx, 'qq_poke', { platform: 'qq', effect: 'express', ...awake })
    registerEcho(ctx, 'qq_look', { platform: 'qq', effect: 'observe', ...awake })
    registerEcho(ctx, 'end_turn', { effect: 'internal', ...awake, closes: true })
    registerEcho(ctx, 'memory_recall', { effect: 'observe', ...awake })
    registerEcho(ctx, 'memory_write', { effect: 'internal', sessions: ['consolidation'] })
    registerEcho(ctx, 'bili_feed', { platform: 'bili', effect: 'observe', ...awake })
    return ctx
  }

  it('tells her waking self her world, where she can go and how to speak there', async () => {
    const ctx = await world()
    const t = primerText('# Rin', ctx.anima.placeFacts('w', 'waking'))
    expect(t).toContain('## 你的世界')
    expect(t).toContain('只有一份注意力')
    expect(t).toContain('够困了才睡得着')
    expect(t).toContain('- QQ：你能去 2 个私聊、1 个群。')
    expect(t).toContain('- B站：你只能看，那里没有人看得到你，你也不能在那里说话。')
    expect(t).toContain('- 怎么说话：`qq_say`，`channel` 写那个地方的频道号。')
    expect(t).toContain('- 其他动作（不结束这一轮）：`qq_poke`。')
    expect(t).toContain('- 能看的：`alarm_list`、`qq_look`、`memory_recall`、`bili_feed`。')
    expect(t).toContain('`sleep`')
    expect(t).toContain('- 结束这一轮：`end_turn`。')
    expect(t).toContain('群里每个人都读得到你发的每条消息')
    expect(t).toContain('## 醒着的时候')
    expect(t).not.toContain('memory_write')
    // No limits of her own and no clock rule: what may stop her is told only from outside.
    expect(t).not.toContain('外面可能拦住你的事')
    expect(t).not.toMatch(/最早|最晚|Self|open_conversation|不要/)
  })

  it('tells sleep\'s consolidation only its own place', async () => {
    const ctx = await world()
    const t = primerText('# Rin', ctx.anima.placeFacts('m', 'consolidation'))
    expect(t).not.toContain('## 你的世界')
    expect(t).toContain('- 这里是睡着时整理记忆的地方，没有人听得到。')
    expect(t).toContain('`memory_write`')
    expect(t).not.toContain('qq_say')
  })

  it('is the persona section of the session, with optional runtime context suppressed', async () => {
    const ctx = await world()
    const key = { id: 'w' } as never
    const { createScope } = await import('@deepseek-ai/dsh-scope')
    const persona = await import('../src/persona.ts')
    let scope!: { ctx: typeof ctx }
    await ctx.plugin(Object.assign((inner: typeof ctx) => { scope = createScope(inner, key) as never }, { inject: ['tools', 'systemPrompt', 'anima'] }))
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const spy = vi.spyOn(SystemPrompt.prototype, 'section')
    onTestFinished(() => spy.mockRestore())
    await scope.ctx.plugin(persona, { kind: 'waking' })
    const section = spy.mock.calls.map(([sec]) => sec).find(sec => sec.complete === true)!
    const textOf = section.text as (context: object) => string
    expect(textOf({ agent: key })).toContain('- QQ：你能去 2 个私聊、1 个群。')
    // A session not known yet (just created) still gets the waking prompt from its preset.
    expect(textOf({ agent: { id: 'new' } })).toContain('## 醒着的时候')
    // Optional runtime contexts are dropped in her sessions; required ones stay.
    ctx.systemPrompt.context({ name: 'harness-dev', order: 10, text: 'checkout at /x' })
    ctx.systemPrompt.context({ name: 'cwd', order: 11, text: 'cwd /y', required: true })
    const refreshed = ctx.systemPrompt.refreshContext({ sections: [], tools: [], variables: {}, contexts: [{ name: 'harness-dev', text: 'x' }, { name: 'cwd', text: 'y' }] } as never, { scope: key } as never)
    expect(refreshed.contexts.map(c => c.name)).toEqual(['cwd', 'anima-self-model'])
  })
})
