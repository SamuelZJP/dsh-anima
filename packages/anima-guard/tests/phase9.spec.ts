import type { ActivityRecord, BehaviorMeta } from '@anima/core'
import { describe, expect, it } from 'vitest'
import { decide, GuardCode, QuotaBook, summarize } from '../src/index.ts'
import { invoke, setupGuarded } from './helpers.ts'

describe('refusals from outside, in her language', () => {
  const chat = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '2' }, channelKey: 'qq:1:private:2' } as const
  const say: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['conversation'] }
  const call = (name: string, meta: BehaviorMeta) => ({ name, meta, session: chat, now: 0, args: {} })

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

describe('day summary (Phase 9)', () => {
  it('counts sleeps, wakes, inbox holds and releases, and backstop refusals', () => {
    const base = { at: 0, real: 0 }
    const records: ActivityRecord[] = [
      { ...base, type: 'sleep', by: 'her' },
      { ...base, type: 'woken', until: 1 },
      { ...base, type: 'sleep', by: 'latest' },
      { ...base, type: 'inbox-held', channel: 'c', reason: 'asleep' },
      { ...base, type: 'inbox-held', channel: 'c', reason: 'asleep' },
      { ...base, type: 'inbox-release', channel: 'c', reason: 'answer', count: 2 },
      { ...base, type: 'gate', behavior: 'qq_say', decision: 'refused', code: 'anima/paused', session: 'conversation' },
    ]
    expect(summarize('d', records, { tokens: { day: 0, night: 0 }, initiates: 0, nightWakes: 0 }).sleep).toEqual({ byHer: 1, atLatest: 1, woken: 1, held: 2, answered: 2, released: 2, backstop: { night: 0, paused: 1 } })
  })
})

describe('wake from outside', () => {
  it('logs a deliberate wake as an owner action', async () => {
    const ctx = await setupGuarded({}, { clock: { speed: 1, start: '2026-11-11T02:00' } })
    expect((await invoke(ctx, 'wake')).text).toMatch(/^She is awake now, until she sleeps again or 2026-11-11 02:30\./)
    expect((await invoke(ctx, 'wake')).text).toBe('She is not asleep.')
    expect(ctx.animaGuard.daySummary('2026-11-10').sleep).toMatchObject({ woken: 1 })
  })
})
