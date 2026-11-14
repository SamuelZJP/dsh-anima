import { describe, expect, it } from 'vitest'
import { AnimaClock, formatLocal, parseWhen } from '../src/clock.ts'
import { resolveConfig } from '../src/config.ts'
import { dayKey, modeAt, nextWake, phaseAt, resolveRhythm } from '../src/rhythm.ts'
import { advance, DEFAULT_NEEDS, feel, initialState, satisfy, spendTurn, type StateModel } from '../src/state.ts'
import { Ledger } from '../src/ledger.ts'
import { GoalStore } from '../src/goals.ts'

const at = (text: string) => new Date(text).getTime()
const rhythm = resolveRhythm({ wake: '07:30', bedtime: { earliest: '22:30', latest: '23:30', wokenMinutes: 30 }, wakingMinutes: 60, evening: '18:00', windDownMinutes: 60 })
const model: StateModel = {
  needs: DEFAULT_NEEDS,
  energy: { drainPerHour: 0.04, perTurn: 0.03, restorePerHour: 0.15 },
  mood: { valence: 0, arousal: 0.3, halfLifeHours: 3 },
  rhythm,
}

describe('clock', () => {
  it('runs at real speed from the real time by default', () => {
    let real = 1_000_000
    const clock = new AnimaClock({ speed: 1 }, () => real)
    real += 5000
    expect(clock.now()).toBe(1_005_000)
    expect(clock.realDelay(60_000)).toBe(60_000)
  })

  it('speeds up from a chosen local start', () => {
    let real = 0
    const clock = new AnimaClock({ speed: 16, start: '2026-11-10T07:00' }, () => real)
    expect(formatLocal(clock.now())).toBe('2026-11-10 07:00')
    real += 15 * 60_000
    expect(formatLocal(clock.now())).toBe('2026-11-10 11:00')
    expect(clock.realDelay(16 * 60_000)).toBe(60_000)
  })

  it('fails loud on a bad start or speed', () => {
    expect(() => new AnimaClock({ speed: 2, start: 'tomorrow' })).toThrow(/anima\/config-invalid/)
    expect(() => new AnimaClock({ speed: 0.5 })).toThrow(/anima\/config-invalid/)
  })

  it('parses times she writes', () => {
    const now = at('2026-11-10T22:00')
    expect(formatLocal(parseWhen('2026-11-11 08:15', now)!)).toBe('2026-11-11 08:15')
    expect(formatLocal(parseWhen('23:10', now)!)).toBe('2026-11-10 23:10')
    expect(formatLocal(parseWhen('07:00', now)!)).toBe('2026-11-11 07:00')
    expect(parseWhen('soon', now)).toBeUndefined()
  })
})

describe('rhythm', () => {
  it('derives phase and mode from the clock', () => {
    const cases: [string, string][] = [
      ['2026-11-10T03:00', 'asleep'],
      ['2026-11-10T07:29', 'asleep'],
      ['2026-11-10T07:30', 'waking'],
      ['2026-11-10T08:29', 'waking'],
      ['2026-11-10T08:30', 'day'],
      ['2026-11-10T18:00', 'evening'],
      ['2026-11-10T22:30', 'winding-down'],
      ['2026-11-10T23:30', 'asleep'],
    ]
    for (const [time, phase] of cases) expect([time, phaseAt(at(time), rhythm)]).toEqual([time, phase])
    expect(modeAt(at('2026-11-10T02:00'), rhythm)).toBe('night')
    expect(modeAt(at('2026-11-10T12:00'), rhythm)).toBe('day')
  })

  it('handles a sleep time after midnight', () => {
    const late = resolveRhythm({ wake: '09:00', bedtime: { earliest: '23:00', latest: '01:00', wokenMinutes: 30 }, wakingMinutes: 30, evening: '19:00', windDownMinutes: 30 })
    expect(phaseAt(at('2026-11-10T00:45'), late)).toBe('winding-down')
    expect(phaseAt(at('2026-11-10T01:30'), late)).toBe('asleep')
    expect(phaseAt(at('2026-11-10T23:00'), late)).toBe('evening')
  })

  it('counts the night as part of the day before it', () => {
    expect(dayKey(at('2026-11-10T08:00'), rhythm)).toBe('2026-11-10')
    expect(dayKey(at('2026-11-11T00:30'), rhythm)).toBe('2026-11-10')
    expect(dayKey(at('2026-11-11T07:29'), rhythm)).toBe('2026-11-10')
    expect(dayKey(at('2026-11-11T07:30'), rhythm)).toBe('2026-11-11')
  })

  it('finds the next wake', () => {
    expect(formatLocal(nextWake(at('2026-11-10T23:45'), rhythm))).toBe('2026-11-11 07:30')
    expect(formatLocal(nextWake(at('2026-11-11T03:00'), rhythm))).toBe('2026-11-11 07:30')
  })

  it('rejects a rhythm that does not fit', () => {
    expect(() => resolveRhythm({ wake: '07:30', bedtime: { earliest: '07:30', latest: '07:30', wokenMinutes: 30 }, wakingMinutes: 0, evening: '18:00', windDownMinutes: 0 })).toThrow(/anima\/config-invalid/)
    expect(() => resolveRhythm({ wake: '7h', bedtime: { earliest: '22:30', latest: '23:30', wokenMinutes: 30 }, wakingMinutes: 0, evening: '18:00', windDownMinutes: 0 })).toThrow(/rhythm.wake/)
  })
})

describe('self state', () => {
  const morning = at('2026-11-10T08:00')

  it('drifts needs up and drains energy while awake', () => {
    const state = advance(initialState(model, morning), morning + 4 * 3_600_000, model)
    expect(state.needs.connect).toBeCloseTo(0.4 + 4 * 0.05)
    expect(state.needs.order).toBeCloseTo(0.2 + 4 * 0.01)
    expect(state.energy).toBeCloseTo(1 - 4 * 0.04)
  })

  it('caps needs at 1', () => {
    const state = advance(initialState(model, morning), morning + 20 * 3_600_000, model)
    expect(state.needs.connect).toBe(1)
  })

  it('restores energy at night, freezes needs, and resets rest at wake', () => {
    const evening = at('2026-11-10T23:00')
    const tired = { ...initialState(model, evening), energy: 0.2, needs: { ...initialState(model, evening).needs, rest: 0.9, connect: 0.7 } }
    const asleep = advance(tired, at('2026-11-11T03:30'), model)
    expect(asleep.needs.connect).toBeCloseTo(0.7 + 0.5 * 0.05)
    expect(asleep.energy).toBeCloseTo(0.2 - 0.5 * 0.04 + 4 * 0.15)
    const woke = advance(asleep, at('2026-11-11T08:00'), model)
    expect(woke.energy).toBeCloseTo(1 - 0.5 * 0.04)
    expect(woke.needs.rest).toBeCloseTo(0.2 + 0.5 * 0.04)
    expect(woke.needs.connect).toBeCloseTo(asleep.needs.connect! + 0.5 * 0.05)
  })

  it('decays mood toward baseline with the half-life', () => {
    const happy = feel(initialState(model, morning), { valence: 0.8, arousal: 2 })
    expect(happy.mood).toEqual({ valence: 0.8, arousal: 1 })
    const later = advance(happy, morning + 3 * 3_600_000, model)
    expect(later.mood.valence).toBeCloseTo(0.4)
    expect(later.mood.arousal).toBeCloseTo(0.3 + 0.7 / 2)
  })

  it('lowers satisfied needs, by exact name or prefix', () => {
    const state = { ...initialState(model, morning), needs: { connect: 0.8, curiosity: 0.3, expression: 0.3, rest: 0.2, order: 0.05 } }
    expect(satisfy(state, 'local_say', model).needs.connect).toBeCloseTo(0.5)
    expect(satisfy(state, 'goals_add', model).needs.order).toBe(0)
    expect(satisfy(state, 'anima_ping', model)).toBe(state)
  })

  it('spends energy per action turn', () => {
    expect(spendTurn(initialState(model, morning), model).energy).toBeCloseTo(0.97)
  })

  it('ignores time going backwards and follows a changed need set', () => {
    const state = initialState(model, morning)
    expect(advance(state, morning - 1000, model)).toEqual(state)
    const fewer = { ...model, needs: [DEFAULT_NEEDS[0]!] }
    expect(Object.keys(advance(state, morning + 60_000, fewer).needs)).toEqual(['connect'])
  })
})

describe('ledger', () => {
  it('keeps only the last days', () => {
    const ledger = new Ledger({}, 2)
    for (const key of ['2026-11-08', '2026-11-09', '2026-11-10']) ledger.day(key).nightWakes = 1
    expect(Object.keys(ledger.toJSON())).toEqual(['2026-11-09', '2026-11-10'])
    expect(ledger.peek('2026-11-01').nightWakes).toBe(0)
  })
})

describe('config defaults', () => {
  it('fills Phase 2 defaults', () => {
    const config = resolveConfig({})
    expect(config.rhythm).toMatchObject({ wake: '07:30', bedtime: { earliest: '22:30', latest: '00:30', wokenMinutes: 30 }, evening: '18:00' })
    expect(config.modes.day).toMatchObject({ minIntervalMinutes: 20, maxIntervalMinutes: 240, triageModel: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    expect(config.modes.night).toMatchObject({ maxWakes: 1, allowedEffects: ['observe', 'internal'] })
    expect(config.selfModel.changesPerDay).toBe(3)
    expect(config.clock.speed).toBe(1)
    expect(config.needs.map(need => need.name)).toEqual(['connect', 'curiosity', 'expression', 'rest', 'order'])
  })

  it('fails loud on inverted interval bounds and duplicate needs', () => {
    expect(() => resolveConfig({ modes: { day: { minIntervalMinutes: 300, maxIntervalMinutes: 60 } } } as never)).toThrow(/minIntervalMinutes/)
    expect(() => resolveConfig({ needs: [DEFAULT_NEEDS[0]!, DEFAULT_NEEDS[0]!] })).toThrow(/defined twice/)
  })
})

describe('goals', () => {
  it('adds, notes and closes goals; she may close the owner\'s without a reason', () => {
    const store = new GoalStore(undefined)
    const mine = store.add({ text: 'tidy notes', owner: 'her', now: 1 })
    const owners = store.add({ text: 'ask about the exam', owner: 'owner', due: at('2026-11-10T21:00'), now: 2 })
    expect(store.open().map(goal => goal.id)).toEqual([owners.id, mine.id])
    store.note(mine.id, 'started', 3)
    expect(store.close(owners.id, { status: 'done', by: 'her', now: 4 }).status).toBe('done')
    expect(() => store.close(owners.id, { status: 'done', by: 'owner', now: 5 })).toThrow(/anima\/goal-closed/)
    expect(() => store.get('g99')).toThrow(/anima\/goal-not-found/)
    expect(store.open()).toHaveLength(1)
  })
})
