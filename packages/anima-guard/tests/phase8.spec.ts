import { primerText, SAY_META, SAY_PARAMETERS, sayMessages } from '@anima/core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { resolveGuardConfig } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupGuarded, textOf } from './helpers.ts'

const chat = { kind: 'waking', current: true } as const
const C = 'qq:1:private:2'

async function withSay(config: Parameters<typeof setupGuarded>[0] = {}) {
  // This chat is on the allowlist; the allowlist itself is tested in allowlist.spec.ts.
  const ctx = await setupGuarded({ allowlist: { qq: { open: true, users: [], groups: [] } }, ...config })
  provideSessions(ctx, { c1: chat })
  ctx.anima.provideChannels(key => key === C ? { isOwner: true, display: 'Sam' } : undefined, () => [C])
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

describe('closing behaviors through the guard', () => {
  it('does not conclude a refused say, and counts a say once however many messages it sends', async () => {
    const { ctx } = await withSay({ quotas: [{ effect: 'express', per: 'channel', limit: 2, windowMinutes: 60 }] })
    expect((await callAs(ctx, 'c1', 'qq_say', { channel: C, text: 'a', also: ['b', 'c'] })).isError).toBe(false)
    expect((await callAs(ctx, 'c1', 'qq_say', { channel: C, text: 'd', also: ['e'] })).isError).toBe(false)
    const refused = await callAs(ctx, 'c1', 'qq_say', { channel: C, text: 'f' })
    expect(refused.isError).toBe(true)
    expect(refused.concludesTurn).toBeUndefined()
    expect(textOf(refused)).toContain('anima/over-quota')
  })

  it('refuses more than five messages in one say by default', async () => {
    const { ctx } = await withSay()
    const result = await callAs(ctx, 'c1', 'qq_say', { channel: C, text: '1', also: ['2', '3', '4', '5', '6'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('anima/over-limit')
    expect(textOf(result)).toContain('messages 最多 5')
  })

  it('lets a turn closer through while paused, and nothing else', async () => {
    const { ctx, sent } = await withSay()
    registerEcho(ctx, 'end_turn', { effect: 'internal', sessions: ['waking'], closes: true })
    await ctx.animaGuard.ownerAction('pause', {}, 'command')
    const say = await callAs(ctx, 'c1', 'qq_say', { channel: C, text: '在的' })
    expect(say.isError).toBe(true)
    expect(textOf(say)).toContain('anima/paused')
    const end = await callAs(ctx, 'c1', 'end_turn')
    expect(end.isError).toBe(false)
    expect(end.concludesTurn).toBe(true)
    expect(sent).toEqual([])
  })
})

describe('anima/admit wakes (not tool calls)', () => {
  it('counts group_attention per channel, records every decision, and refuses while paused', async () => {
    const ctx = await setupGuarded({ quotas: [
      { behavior: 'group_attention', per: 'channel', limit: 2, windowMinutes: 60 },
      { per: 'global', limit: 1, windowMinutes: 60 },
    ] })
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'qq:1:group:9' })).toBeUndefined()
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'qq:1:group:9' })).toBeUndefined()
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'qq:1:group:9' })).toMatchObject({ code: 'anima/over-quota' })
    // Another group has its own counter; the global ceiling does not count admissions.
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'qq:1:group:8' })).toBeUndefined()
    await ctx.animaGuard.ownerAction('pause', {}, 'command')
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'qq:1:group:7' })).toMatchObject({ code: 'anima/paused' })
    const records = ctx.animaGuard.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'gate')
    expect(records.map(r => [(r as { decision: string }).decision, (r as { code?: string }).code])).toEqual([
      ['allowed', undefined], ['allowed', undefined], ['refused', 'anima/over-quota'], ['allowed', undefined], ['refused', 'anima/paused'],
    ])
    expect(records[0]).toMatchObject({ behavior: 'group_attention', channel: 'qq:1:group:9' })
  })

  it('has no default quota on speech or attention: that is her tiredness (R6)', () => {
    const quotas = resolveGuardConfig({}).quotas
    expect(quotas.some(rule => rule.effect === 'express' || rule.per === 'global' && rule.behavior === undefined && rule.platform === undefined)).toBe(false)
    expect(quotas.some(rule => rule.behavior === 'group_attention' || rule.behavior === 'group_wake' || rule.behavior === 'alarm_set')).toBe(false)
  })
})

describe('closing without speech is never refused by a quota', () => {
  it('lets end_turn through when the global ceiling is spent, and does not count it', async () => {
    const ctx = await setupGuarded({ quotas: [{ per: 'global', limit: 2, windowMinutes: 24 * 60 }], allowlist: { qq: { open: true, users: [], groups: [] } } })
    provideSessions(ctx, { c1: chat })
    registerEcho(ctx, 'qq_react', { platform: 'qq', effect: 'express', sessions: ['waking'] })
    registerEcho(ctx, 'end_turn', { effect: 'internal', sessions: ['waking'], closes: true })
    for (let i = 0; i < 3; i++) expect((await callAs(ctx, 'c1', 'end_turn')).isError).toBe(false)
    expect((await callAs(ctx, 'c1', 'qq_react')).isError).toBe(false)
    expect((await callAs(ctx, 'c1', 'qq_react')).isError).toBe(false)
    expect(textOf(await callAs(ctx, 'c1', 'qq_react'))).toContain('anima/over-quota')
    const closed = await callAs(ctx, 'c1', 'end_turn')
    expect(closed.isError).toBe(false)
    expect(closed.concludesTurn).toBe(true)
  })
})

describe('limits in her prompt, told from outside', () => {
  it('adds the owner rules of a place under their own heading', async () => {
    const ctx = await setupGuarded()
    ctx.anima.provideChannels(key => key === 'qq:1:private:2' ? { isOwner: true, display: 'Sam' } : undefined, () => ['qq:1:private:2'])
    provideSessions(ctx, { p: chat, s: { kind: 'waking', current: true } })
    const conv = { sessions: ['waking'] } as const
    registerEcho(ctx, 'qq_say', { platform: 'qq', effect: 'express', ...conv, ...SAY_META })
    registerEcho(ctx, 'qq_poke', { platform: 'qq', effect: 'express', ...conv })
    const t = primerText('# Rin', ctx.anima.placeFacts('p', 'waking'))
    expect(t).toContain('- 外面可能拦住你的事（主人定的规矩，不是你的身体）：')
    expect(t).toContain('`qq_say`：一次最多 5 条消息。')
    expect(t).toContain('`qq_poke`：每个频道分开算，每小时最多 3 次。')
    expect(t).not.toContain('表达类')
    expect(t).toContain('在 30 分钟里没有人找过你、你也没说过话的聊天里开口，算你主动找人：每天最多 3 次，只在主人允许的聊天里；这样的消息会先在发件箱里等 45 秒，主人可以取消。')
  })
})
