import { describe, expect, it } from 'vitest'
import { loadSleepRecord, overwhelms, rested, sleepComes } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const at = (text: string) => new Date(text).getTime()
const HOUR = 3_600_000
const genes = { risePerHour: 0.05, fallPerHour: 0.1, fallAsleepAbove: 0.6, overwhelmAbove: 0.95, wakeBelow: 0.1 }

describe('sleep pressure decides (docs/design/body.md)', () => {
  it('lets sleep come above fallAsleepAbove, take her at overwhelmAbove, and lets her go at wakeBelow', () => {
    expect(sleepComes(0.6, genes)).toBe(false)
    expect(sleepComes(0.61, genes)).toBe(true)
    expect(overwhelms(0.94, genes)).toBe(false)
    expect(overwhelms(0.95, genes)).toBe(true)
    expect(rested(0.1, genes)).toBe(true)
    expect(rested(0.11, genes)).toBe(false)
  })

  it('starts her awake from a missing or pre-R4 state file', () => {
    expect(loadSleepRecord(undefined, 5)).toEqual({ asleep: false, since: 5, by: 'start' })
    expect(loadSleepRecord({ since: 1, by: 'latest', wokenAt: 2 }, 5)).toEqual({ asleep: false, since: 5, by: 'start' })
    expect(loadSleepRecord({ asleep: true, since: 3, by: 'her' }, 5)).toEqual({ asleep: true, since: 3, by: 'her' })
  })
})

describe('going to bed, being overwhelmed, waking', () => {
  const waking = { kind: 'waking', current: true } as const

  async function core(start: string) {
    const ctx = await setupCore({ clock: { speed: 1, start }, sleep: genes })
    provideSessions(ctx, { w: waking })
    const clock = { now: at(start) }
    ctx.anima.setClock(() => clock.now)
    const records: Record<string, unknown>[] = []
    ctx.on('anima/record', (record) => { records.push(record as never) })
    const events: string[] = []
    ctx.on('anima/sleep', ({ by }) => { events.push(`sleep:${by}`) })
    ctx.on('anima/wake', ({ by }) => { events.push(`wake:${by}`) })
    return { ctx, clock, records, events }
  }

  it('says sleep does not come when she is not sleepy, without refusing; later she falls asleep and the turn closes', async () => {
    const { ctx, clock, records, events } = await core('2026-11-10T09:00')
    const early = await callAs(ctx, 'w', 'sleep', {})
    expect(early.isError).toBe(false)
    expect(early.concludesTurn).not.toBe(true)
    expect(textOf(early)).toBe('你躺下了，可是还不困，睡不着。你还醒着。')
    expect(ctx.anima.asleep()).toBe(false)
    // 0.15 + 10 h × 0.05 = 0.65: sleepy enough.
    clock.now = at('2026-11-10T19:00')
    const slept = await callAs(ctx, 'w', 'sleep', { note: '今天好累' })
    expect(slept.concludesTurn).toBe(true)
    expect(textOf(slept)).toBe('你睡着了。')
    expect(ctx.anima.sleepInfo()).toMatchObject({ asleep: true, since: at('2026-11-10T19:00'), by: 'her', note: '今天好累' })
    expect(events).toEqual(['sleep:her'])
    expect(records.filter(r => r.type === 'sleep')).toEqual([expect.objectContaining({ by: 'her', note: '今天好累', sessionId: 'w', day: '2026-11-10' })])
    // Asleep, her waking session can do nothing.
    registerEcho(ctx, 'demo_say', { platform: 'demo', effect: 'express', sessions: ['waking'] })
    expect(textOf(await callAs(ctx, 'w', 'demo_say', {}))).toMatch(/^Error: anima\/asleep: 你睡着了/)
  })

  it('is taken by sleep when the pressure overwhelms her, but only once no turn runs', async () => {
    const { ctx, clock, events } = await core('2026-11-10T07:00')
    let busy = true
    ctx.anima.provideBusy(() => busy)
    // 0.15 + 16.2 h × 0.05 > 0.95.
    clock.now = at('2026-11-10T23:12')
    ctx.anima.checkSleep()
    expect(events).toEqual([])
    busy = false
    ctx.anima.checkSleep()
    ctx.anima.checkSleep()
    expect(events).toEqual(['sleep:overwhelmed'])
    expect(ctx.anima.sleepInfo().by).toBe('overwhelmed')
  })

  it('wakes by herself once rested, restored and with her rest need met', async () => {
    const { ctx, clock, events, records } = await core('2026-11-10T07:00')
    clock.now = at('2026-11-10T21:00')
    await callAs(ctx, 'w', 'sleep', {})
    const pressure = ctx.anima.sleepInfo().pressure
    clock.now = at('2026-11-10T21:00') + 3 * HOUR
    ctx.anima.checkSleep()
    expect(ctx.anima.asleep()).toBe(true)
    clock.now = at('2026-11-10T21:00') + Math.ceil((pressure - 0.1) / 0.1 * HOUR) + 60_000
    ctx.anima.checkSleep()
    expect(events).toEqual(['sleep:her', 'wake:rested'])
    expect(ctx.anima.sleepInfo()).toMatchObject({ asleep: false, by: 'rested' })
    expect(ctx.anima.selfState().needs.rest).toBeCloseTo(0.2)
    expect(records.filter(r => r.type === 'woke')).toEqual([expect.objectContaining({ by: 'rested' })])
  })

  it('is woken by the owner from outside; then her pressure alone decides when sleep comes again', async () => {
    const { ctx, clock, events } = await core('2026-11-10T07:00')
    clock.now = at('2026-11-10T22:00')
    await callAs(ctx, 'w', 'sleep', {})
    clock.now = at('2026-11-10T23:00')
    expect(ctx.anima.wakeByOwner()).toEqual({ woken: true })
    expect(ctx.anima.wakeByOwner()).toEqual({ woken: false })
    expect(events).toEqual(['sleep:her', 'wake:owner'])
    expect(ctx.anima.statusLines().join('\n')).toMatch(/Sleep: awake since 2026-11-10 23:00 \(owner\); sleep pressure 0\.\d\d/)
    // Still sleepy: sleep comes at once if she goes back to bed.
    expect(textOf(await callAs(ctx, 'w', 'sleep', {}))).toBe('你睡着了。')
  })

  it('keeps her phase across a restart', async () => {
    const dataDir = tempDataDir()
    const first = await setupCore({ dataDir, clock: { speed: 1, start: '2026-11-10T22:40' }, sleep: { ...genes, fallAsleepAbove: 0.12 } })
    provideSessions(first, { w: waking })
    expect(textOf(await callAs(first, 'w', 'sleep', {}))).toBe('你睡着了。')
    first.fiber.dispose()
    const second = await setupCore({ dataDir, clock: { speed: 1, start: '2026-11-10T23:00' }, sleep: genes })
    expect(second.anima.asleep()).toBe(true)
  })
})
