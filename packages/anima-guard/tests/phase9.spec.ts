import type { ActivityRecord, BehaviorMeta } from '@anima/core'
import { describe, expect, it } from 'vitest'
import { decide, GuardCode, QuotaBook, summarize } from '../src/index.ts'
import { invoke, setupGuarded } from './helpers.ts'

describe('refusals from outside, in her language', () => {
  const chat = { kind: 'waking', current: true } as const
  const say: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['waking'], target: args => args.channel as string }
  const call = (name: string, meta: BehaviorMeta) => ({ name, meta, session: chat, now: 0, args: { channel: 'qq:1:private:2' } })

  it('says a spent chat quota as an owner rule, from outside, with the code in front', () => {
    const book = new QuotaBook()
    const policy = { quotas: [{ effect: 'express' as const, per: 'channel' as const, limit: 1, windowMinutes: 60 }], allow: [] }
    book.record(call('qq_say', say), policy.quotas)
    const verdict = decide(call('qq_say', say), policy, book)
    expect(verdict).toEqual({ allowed: false, code: GuardCode.overQuota, hint: '（外面拦住了你，不是你自己的身体）主人定的限制：一个聊天里每小时最多说 1 次，已经到了；大约 60 分钟后才行，现在别再试了。' })
  })

  it('writes every guard hint she can meet in Chinese', () => {
    const book = new QuotaBook()
    const open = { quotas: [], allow: [] }
    const budget = decide(call('qq_say', say), open, book, { overBudget: true, initiatesUsed: 0, mayInitiate: () => true })
    const approval = decide(call('qq_post', { ...say, effect: 'public' }), open, book)
    for (const verdict of [budget, approval]) {
      expect(verdict.allowed).toBe(false)
      if (!verdict.allowed) expect(verdict.hint).toMatch(/[一-鿿]/)
    }
  })
})

describe('day summary', () => {
  it('counts sleeps, wakes, wakings, inbox holds and releases, and backstop refusals', () => {
    const base = { at: 0, real: 0 }
    const records: ActivityRecord[] = [
      { ...base, type: 'sleep', by: 'her' },
      { ...base, type: 'waking-open', sessionId: 'w2' },
      { ...base, type: 'woke', by: 'owner' },
      { ...base, type: 'sleep', by: 'overwhelmed' },
      { ...base, type: 'waking-open', sessionId: 'w3' },
      { ...base, type: 'woke', by: 'rested' },
      { ...base, type: 'inbox-held', channel: 'c', reason: 'asleep' },
      { ...base, type: 'inbox-held', channel: 'c', reason: 'asleep' },
      { ...base, type: 'inbox-release', channel: 'c', reason: 'said', count: 2 },
      { ...base, type: 'gate', behavior: 'qq_say', decision: 'refused', code: 'anima/paused', session: 'waking' },
      { ...base, type: 'gate', behavior: 'qq_say', decision: 'refused', code: 'anima/asleep', session: 'waking' },
    ]
    expect(summarize('d', records, { tokens: { day: 0, night: 0 }, initiates: 0, nightWakes: 0 }).sleep).toEqual({ byHer: 1, overwhelmed: 1, woken: 1, wakings: 2, held: 2, answered: 2, released: 2, backstop: { asleep: 1, paused: 1 } })
  })
})

describe('wake from outside', () => {
  it('wakes her from outside and logs it as an owner action', async () => {
    const ctx = await setupGuarded({}, { clock: { speed: 1, start: '2026-11-11T02:00' }, sleep: { risePerHour: 0.05, fallPerHour: 0.1, fallAsleepAbove: 0.12, overwhelmAbove: 0.95, wakeBelow: 0.01 } })
    expect((await invoke(ctx, 'wake')).text).toBe('She is not asleep.')
    expect(ctx.anima.goToBed()).toBe(true)
    expect((await invoke(ctx, 'wake')).text).toMatch(/^She is awake now/)
    expect(ctx.anima.asleep()).toBe(false)
    expect(ctx.animaGuard.daySummary('2026-11-11').sleep).toMatchObject({ woken: 1 })
  })
})
