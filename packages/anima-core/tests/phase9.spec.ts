import { describe, expect, it } from 'vitest'
import { asleepAt, decide, earliestBedtime, formatLocal, GateCode, latestBedtime, modeAt, phaseAt, QuotaBook, resolveRhythm, summarize, wokenUntil, type ActivityRecord, type BehaviorMeta } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { emptyDay } from '../src/ledger.ts'
import { callAs, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const at = (text: string) => new Date(text).getTime()
const rhythm = resolveRhythm({ wake: '07:30', bedtime: { earliest: '22:30', latest: '00:30', wokenMinutes: 30 }, wakingMinutes: 60, evening: '18:00', windDownMinutes: 60 })

describe('bedtime (DESIGN §7, Phase 9)', () => {
  it('is awake before the earliest bedtime and asleep from the latest, with no record', () => {
    expect(asleepAt(at('2026-11-10T22:00'), rhythm)).toBe(false)
    expect(asleepAt(at('2026-11-10T23:30'), rhythm)).toBe(false)
    expect(phaseAt(at('2026-11-10T23:30'), rhythm)).toBe('winding-down')
    expect(phaseAt(at('2026-11-10T23:00'), rhythm)).toBe('evening')
    expect(asleepAt(at('2026-11-11T00:30'), rhythm)).toBe(true)
    expect(asleepAt(at('2026-11-11T07:29'), rhythm)).toBe(true)
    expect(asleepAt(at('2026-11-11T07:30'), rhythm)).toBe(false)
    expect(formatLocal(earliestBedtime(at('2026-11-10T12:00'), rhythm))).toBe('2026-11-10 22:30')
    expect(formatLocal(latestBedtime(at('2026-11-10T12:00'), rhythm))).toBe('2026-11-11 00:30')
  })

  it('is asleep from the time she chose inside the window, and that record is only for her day', () => {
    const record = { since: at('2026-11-10T22:45'), by: 'her' as const }
    expect(asleepAt(at('2026-11-10T22:40'), rhythm, record)).toBe(false)
    expect(asleepAt(at('2026-11-10T22:50'), rhythm, record)).toBe(true)
    expect(modeAt(at('2026-11-10T23:10'), rhythm, record)).toBe('night')
    // The next evening the old record no longer counts.
    expect(asleepAt(at('2026-11-11T23:00'), rhythm, record)).toBe(false)
  })

  it('keeps her awake after a deliberate wake until it ends or she sleeps again', () => {
    const woke = at('2026-11-11T02:00')
    const until = wokenUntil(woke, rhythm)
    expect(formatLocal(until)).toBe('2026-11-11 02:30')
    // Woken before the latest bedtime: awake until the latest bedtime at least.
    expect(formatLocal(wokenUntil(at('2026-11-10T23:00'), rhythm))).toBe('2026-11-11 00:30')
    const record = { since: at('2026-11-10T23:00'), by: 'her' as const, wokenAt: woke, wokenUntil: until }
    expect(asleepAt(at('2026-11-11T02:10'), rhythm, record)).toBe(false)
    expect(asleepAt(at('2026-11-11T02:31'), rhythm, record)).toBe(true)
    const again = { ...record, since: at('2026-11-11T02:15') }
    expect(asleepAt(at('2026-11-11T02:20'), rhythm, again)).toBe(true)
  })

  it('fails loud on the removed rhythm.sleep and on a window that does not fit', () => {
    expect(() => resolveConfig({ dataDir: tempDataDir(), rhythm: { sleep: '23:30' } } as never)).toThrow(/rhythm.sleep was replaced by rhythm.bedtime/)
    expect(() => resolveRhythm({ wake: '07:30', bedtime: { earliest: '01:00', latest: '00:30', wokenMinutes: 30 }, wakingMinutes: 60, evening: '18:00', windDownMinutes: 60 })).toThrow(/earliest must come before/)
  })
})

describe('sleep, the latest bedtime and the owner wake (Phase 9)', () => {
  const self = { kind: 'self' } as const
  const chat = { kind: 'conversation', channel: { platform: 'local', account: 'owner', kind: 'private', id: 'owner' }, channelKey: 'local:owner:private:owner' } as const

  async function core(start: string) {
    const ctx = await setupCore({ clock: { speed: 1, start } })
    provideSessions(ctx, { s: self, c: chat })
    const clock = { now: at(start) }
    ctx.anima.setClock(() => clock.now)
    return { ctx, clock }
  }

  it('refuses sleep before the earliest bedtime in her words, then lets her sleep and closes the turn', async () => {
    const { ctx, clock } = await core('2026-11-10T21:00')
    const early = await callAs(ctx, 'c', 'sleep', {})
    expect(textOf(early)).toBe('Error: anima/not-bedtime: 还不到睡觉的时候：你今天 07:30 才起床，主人定的最早上床时间是今晚 22:30。')
    clock.now = at('2026-11-10T22:50')
    const slept = await callAs(ctx, 'c', 'sleep', { note: '今天好累' })
    expect(slept.isError).toBe(false)
    expect(slept.concludesTurn).toBe(true)
    expect(ctx.anima.asleep()).toBe(true)
    expect(ctx.anima.bedtimeInfo()).toMatchObject({ asleep: true, since: at('2026-11-10T22:50'), by: 'her' })
    const records = ctx.anima.activity.read('2026-11-10')
    expect(records.filter(r => r.type === 'sleep')).toEqual([expect.objectContaining({ by: 'her', note: '今天好累', sessionId: 'c' })])
    // Asleep, a day behavior meets the night backstop in her words.
    registerEcho(ctx, 'local_say', { platform: 'local', effect: 'express', sessions: ['conversation'] })
    const said = await callAs(ctx, 'c', 'local_say', {})
    expect(textOf(said)).toMatch(/^Error: anima\/night: 你现在睡着了/)
    expect(ctx.anima.daySummary('2026-11-10').sleep).toMatchObject({ byHer: 1, atLatest: 0, backstop: { night: 1, paused: 0 } })
  })

  it('falls asleep at the latest bedtime once, and restores energy only while asleep', async () => {
    const { ctx, clock } = await core('2026-11-10T23:00')
    const slept: string[] = []
    ctx.on('anima/sleep', ({ by }) => { slept.push(by) })
    ctx.anima.checkBedtime()
    expect(slept).toEqual([])
    clock.now = at('2026-11-11T00:31')
    ctx.anima.checkBedtime()
    ctx.anima.checkBedtime()
    expect(slept).toEqual(['latest'])
    expect(ctx.anima.bedtimeInfo()).toMatchObject({ asleep: true, by: 'latest' })
    const before = ctx.anima.selfState().energy
    clock.now = at('2026-11-11T02:31')
    expect(ctx.anima.selfState().energy).toBeCloseTo(Math.min(1, before + 0.3), 5)
  })

  it('lets only the owner wake her: awake for wokenMinutes past the latest bedtime, then asleep again', async () => {
    const { ctx, clock } = await core('2026-11-11T02:00')
    const woken: number[] = []
    ctx.on('anima/woken', ({ until }) => { woken.push(until) })
    const awakeNow = await ctx.anima.ownerAction('wake', {}, 'command')
    expect(awakeNow).toEqual({ woken: true, until: at('2026-11-11T02:30') })
    expect(ctx.anima.mode()).toBe('day')
    expect(ctx.anima.statusText()).toContain('Awake; bedtime 22:30–00:30; woken by the owner at 2026-11-11 02:00 until 2026-11-11 02:30')
    expect(await ctx.anima.ownerAction('wake', {}, 'command')).toEqual({ woken: false })
    expect(woken).toEqual([at('2026-11-11T02:30')])
    clock.now = at('2026-11-11T02:31')
    const slept: string[] = []
    ctx.on('anima/sleep', ({ by }) => { slept.push(by) })
    ctx.anima.checkBedtime()
    expect(slept).toEqual(['latest'])
    expect(ctx.anima.daySummary('2026-11-10').sleep).toMatchObject({ woken: 1, atLatest: 1 })
  })

  it('keeps the sleep record across a restart', async () => {
    const dataDir = tempDataDir()
    const first = await setupCore({ dataDir, clock: { speed: 1, start: '2026-11-10T22:40' } })
    provideSessions(first, { s: self })
    expect((await callAs(first, 's', 'sleep', {})).isError).toBe(false)
    first.fiber.dispose()
    const second = await setupCore({ dataDir, clock: { speed: 1, start: '2026-11-10T23:00' } })
    expect(second.anima.asleep()).toBe(true)
  })
})

describe('refusals in her world\'s terms (DESIGN §10, Phase 9)', () => {
  const chat = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '2' }, channelKey: 'qq:1:private:2' } as const
  const say: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['conversation'] }
  const call = (name: string, meta: BehaviorMeta) => ({ name, meta, session: chat, now: 0, args: {} })

  it('says a spent chat quota as "you said a lot here", with the code in front', () => {
    const book = new QuotaBook()
    const policy = { quotas: [{ effect: 'express' as const, per: 'channel' as const, limit: 1, windowMinutes: 60 }], allow: [] }
    book.record(call('qq_say', say), policy.quotas)
    const verdict = decide(call('qq_say', say), policy, book)
    expect(verdict).toEqual({ allowed: false, code: GateCode.overQuota, hint: '这个聊天里你这一小时已经说了很多了（最多 1 次），过一会儿再说吧：大约 60 分钟后才行，现在别再试了。' })
  })

  it('writes every gate hint she can meet in Chinese', () => {
    const book = new QuotaBook()
    const open = { quotas: [], allow: [] }
    const night = decide(call('qq_say', say), { ...open, allowedEffects: { day: ['express'], night: ['internal'] } }, book, { mode: 'night', overBudget: false, initiatesUsed: 0, mayInitiate: () => true })
    const budget = decide(call('qq_say', say), open, book, { mode: 'day', overBudget: true, initiatesUsed: 0, mayInitiate: () => true })
    const approval = decide(call('qq_post', { ...say, effect: 'public' }), open, book)
    for (const verdict of [night, budget, approval]) {
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
    expect(summarize('d', records, emptyDay()).sleep).toEqual({ byHer: 1, atLatest: 1, woken: 1, held: 2, answered: 2, released: 2, backstop: { night: 0, paused: 1 } })
  })
})
