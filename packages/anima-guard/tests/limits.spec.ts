import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as animaCore from '@anima/core'
import type { BehaviorMeta } from '@anima/core'
import * as animaGuard from '../src/index.ts'
import { decide, GuardCode, QuotaBook, resolveGuardConfig } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupGuarded, tempDataDir, textOf } from './helpers.ts'

const SELF = 'self-1'
const watch: BehaviorMeta = { platform: 'bili', effect: 'observe', sessions: ['self'] }

describe('fact limits (DESIGN §10)', () => {
  it('refuses a call whose facts exceed an owner limit, before it runs', async () => {
    const ctx = await setupGuarded({ limits: [{ behavior: 'bili_view_closely', fact: 'durationSeconds', max: 1200 }] })
    provideSessions(ctx, { [SELF]: { kind: 'self' } })
    const seen: unknown[] = []
    registerEcho(ctx, 'bili_view_closely', { ...watch, facts: async (args) => { seen.push(args); return { durationSeconds: Number(args.text) } } })
    const long = await callAs(ctx, SELF, 'bili_view_closely', { text: '1500' })
    expect(long.isError).toBe(true)
    expect(textOf(long)).toMatch(/^Error: anima\/over-limit: （外面拦住了你，不是你自己的身体）主人定的限制：bili_view_closely 的 durationSeconds 最多 1200，这次是 1500/)
    const short = await callAs(ctx, SELF, 'bili_view_closely', { text: '600' })
    expect(short.isError).toBe(false)
    expect(seen).toHaveLength(2)
  })

  it('turns a failure to find facts into a refusal with its code', async () => {
    const ctx = await setupGuarded()
    provideSessions(ctx, { [SELF]: { kind: 'self' } })
    registerEcho(ctx, 'bili_view_closely', { ...watch, facts: async () => { throw new animaCore.AnimaError('anima/bad-args', 'not a bvid.') } })
    const result = await callAs(ctx, SELF, 'bili_view_closely', { text: 'x' })
    expect(textOf(result)).toBe('Error: anima/bad-args: not a bvid.')
  })

  it('has default limits of 12 frames and 20 minutes for close views, and 5 messages per say', () => {
    const config = resolveGuardConfig({})
    expect(config.limits).toEqual([
      { behavior: 'bili_view_closely', fact: 'frames', max: 12 },
      { behavior: 'bili_view_closely', fact: 'durationSeconds', max: 1200 },
      { behavior: 'qq_say', fact: 'messages', max: 5 },
    ])
    const verdict = decide({ name: 'bili_view_closely', meta: watch, session: { kind: 'self' }, now: 0, facts: { frames: 13 } }, { quotas: [], allow: [], limits: config.limits }, new QuotaBook())
    expect(verdict).toMatchObject({ allowed: false, code: GuardCode.overLimit })
  })
})

describe('platform quotas', () => {
  it('counts every behavior of a platform against a per-platform rule', () => {
    const book = new QuotaBook()
    const quotas = [{ platform: 'bili', per: 'platform' as const, limit: 2, windowMinutes: 60 }]
    const call = (name: string, platform = 'bili') => ({ name, meta: { ...watch, platform }, session: { kind: 'self' as const }, now: 1000 })
    for (const name of ['bili_popular', 'bili_watch']) {
      expect(decide(call(name), { quotas, allow: [] }, book)).toEqual({ allowed: true })
      book.record(call(name), quotas)
    }
    expect(decide(call('bili_search'), { quotas, allow: [] }, book)).toMatchObject({ allowed: false, code: GuardCode.overQuota })
    // Another platform's behaviors are not counted.
    expect(decide(call('qq_history', 'qq'), { quotas, allow: [] }, book)).toEqual({ allowed: true })
  })

  it('keeps quota counters across a restart (close views per day)', async () => {
    const dataDir = tempDataDir()
    const config = { dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } }
    const guard = { quotas: [{ behavior: 'bili_view_closely', per: 'global' as const, limit: 1, windowMinutes: 1440 }] }
    const boot = async () => {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(Tools)
      await ctx.plugin(animaCore, config)
      const fiber = await ctx.plugin(animaGuard, guard)
      provideSessions(ctx, { [SELF]: { kind: 'self' } })
      registerEcho(ctx, 'bili_view_closely', watch)
      return { ctx, fiber }
    }
    const first = await boot()
    expect((await callAs(first.ctx, SELF, 'bili_view_closely')).isError).toBe(false)
    await first.fiber.dispose()
    await first.ctx.fiber.dispose()
    const second = await boot()
    const again = await callAs(second.ctx, SELF, 'bili_view_closely')
    expect(textOf(again)).toMatch(/^Error: anima\/over-quota: （外面拦住了你，不是你自己的身体）主人定的限制：bili_view_closely 每天总共最多 1 次/)
  })
})
