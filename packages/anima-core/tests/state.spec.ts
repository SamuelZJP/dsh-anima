import { describe, expect, it } from 'vitest'
import { AnimaClock, formatLocal, parseWhen } from '../src/clock.ts'
import { resolveConfig } from '../src/config.ts'
import { advance, DEFAULT_ENERGY, DEFAULT_NEEDS, energyCost, exhausted, feel, initialState, setNeeds, spend, wokeUp, type StateModel } from '../src/state.ts'
import { Ledger } from '../src/ledger.ts'
import { GoalStore } from '../src/goals.ts'

const at = (text: string) => new Date(text).getTime()
const sleep = { risePerHour: 0.05, perEnergy: 0.5, fallPerHour: 0.1, fallAsleepAbove: 0.6, overwhelmAbove: 0.95, wakeBelow: 0.1 }
const phase = { asleep: false, idle: false }
const model: StateModel = {
  needs: DEFAULT_NEEDS,
  energy: { ...DEFAULT_ENERGY, drainPerHour: 0.04, idleRestorePerHour: 0.06, restorePerHour: 0.15 },
  mood: { valence: 0, arousal: 0.3, halfLifeHours: 3 },
  sleep,
  asleep: () => phase.asleep,
  idle: () => phase.idle,
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

  it('raises sleep pressure while awake and lowers it asleep, clamped to 0–1', () => {
    const start = initialState(model, morning)
    expect(start.sleepPressure).toBeCloseTo(0.15)
    const day = advance(start, morning + 10 * 3_600_000, model)
    expect(day.sleepPressure).toBeCloseTo(0.15 + 10 * 0.05)
    expect(advance(day, morning + 30 * 3_600_000, model).sleepPressure).toBe(1)
    phase.asleep = true
    try {
      const night = advance(day, morning + 15 * 3_600_000, model)
      expect(night.sleepPressure).toBeCloseTo(0.65 - 5 * 0.1)
      expect(advance(day, morning + 30 * 3_600_000, model).sleepPressure).toBe(0)
    } finally {
      phase.asleep = false
    }
  })

  it('restores energy and freezes needs asleep; waking satisfies rest', () => {
    const evening = at('2026-11-10T23:00')
    const tired = { ...initialState(model, evening), energy: 0.2, needs: { ...initialState(model, evening).needs, rest: 0.9, connect: 0.7 } }
    phase.asleep = true
    let slept
    try {
      slept = advance(tired, at('2026-11-11T03:00'), model)
    } finally {
      phase.asleep = false
    }
    expect(slept.needs.connect).toBeCloseTo(0.7)
    expect(slept.energy).toBeCloseTo(0.2 + 4 * 0.15)
    expect(wokeUp(slept, model).needs.rest).toBeCloseTo(0.2)
  })

  it('reads an old state file without sleep pressure as a fresh one', () => {
    const { sleepPressure: _, ...old } = initialState(model, morning)
    expect(advance(old as never, morning + 3_600_000, model).sleepPressure).toBeCloseTo(0.2)
  })

  it('decays mood toward baseline with the half-life', () => {
    const happy = feel(initialState(model, morning), { valence: 0.8, arousal: 2 })
    expect(happy.mood).toEqual({ valence: 0.8, arousal: 1 })
    const later = advance(happy, morning + 3 * 3_600_000, model)
    expect(later.mood.valence).toBeCloseTo(0.4)
    expect(later.mood.arousal).toBeCloseTo(0.3 + 0.7 / 2)
  })

  it('restores a little energy while she idles awake', () => {
    phase.idle = true
    try {
      const state = advance({ ...initialState(model, morning), energy: 0.5 }, morning + 2 * 3_600_000, model)
      expect(state.energy).toBeCloseTo(0.5 + 2 * (0.06 - 0.04))
    } finally {
      phase.idle = false
    }
  })

  it('costs energy by behavior name, prefix, then effect class', () => {
    const energy = { ...DEFAULT_ENERGY, behaviorCosts: { bili_view_closely: 0.06, 'qq_*': 0.01 } }
    expect(energyCost('bili_view_closely', { effect: 'observe' }, energy)).toBe(0.06)
    expect(energyCost('qq_say', { effect: 'express' }, energy)).toBe(0.01)
    expect(energyCost('demo_say', { effect: 'express' }, energy)).toBe(DEFAULT_ENERGY.costs.express)
    expect(energyCost('end_turn', { effect: 'internal' }, energy)).toBe(0)
  })

  it('spending energy raises sleep pressure; exhausted below the gene', () => {
    const state = initialState(model, morning)
    const spent = spend(state, 0.2, model)
    expect(spent.energy).toBeCloseTo(0.8)
    expect(spent.sleepPressure).toBeCloseTo(0.15 + 0.2 * 0.5)
    expect(spend(state, 0, model)).toBe(state)
    expect(exhausted({ energy: 0.09 }, DEFAULT_ENERGY)).toBe(true)
    expect(exhausted({ energy: 0.1 }, DEFAULT_ENERGY)).toBe(false)
  })

  it('sets needs she appraised, clamped; unknown names are reported', () => {
    const state = initialState(model, morning)
    const { state: next, unknown } = setNeeds(state, [{ name: 'connect', level: 0.1 }, { name: 'rest', level: 3 }, { name: 'hunger', level: 0.5 }], model)
    expect(next.needs.connect).toBe(0.1)
    expect(next.needs.rest).toBe(1)
    expect(next.needs).not.toHaveProperty('hunger')
    expect(unknown).toEqual(['hunger'])
  })

  it('never lowers a need for a behavior: needs only drift', () => {
    const state = advance(initialState(model, morning), morning + 3_600_000, model)
    for (const need of DEFAULT_NEEDS) expect(state.needs[need.name]).toBeGreaterThanOrEqual(need.baseline)
    expect(DEFAULT_NEEDS.some(need => 'satisfiedBy' in need)).toBe(false)
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
    const ledger = new Ledger<{ count: number }>({}, 2, () => ({ count: 0 }))
    for (const key of ['2026-11-08', '2026-11-09', '2026-11-10']) ledger.day(key).count = 1
    expect(Object.keys(ledger.toJSON())).toEqual(['2026-11-09', '2026-11-10'])
    expect(ledger.peek('2026-11-01').count).toBe(0)
  })
})

describe('config defaults', () => {
  it('fills the defaults: her genes, no clock times', () => {
    const config = resolveConfig({})
    expect(config.sleep).toEqual({ risePerHour: 0.045, perEnergy: 0.3, fallPerHour: 0.11, fallAsleepAbove: 0.6, overwhelmAbove: 0.98, wakeBelow: 0.1 })
    expect(config.energy).toEqual(DEFAULT_ENERGY)
    expect(config).not.toHaveProperty('rhythm')
    expect(config).not.toHaveProperty('modes')
    expect(config.heartbeat.restingMinutes).toBe(60)
    expect(config.selfModel).toEqual({ digestChars: 600 })
    expect(config.clock.speed).toBe(1)
    expect(config.needs.map(need => need.name)).toEqual(['connect', 'curiosity', 'expression', 'rest', 'order'])
  })

  it('fails loud on removed rules and duplicate needs', () => {
    expect(() => resolveConfig({ rhythm: { wake: '07:30' } } as never)).toThrow(/anima\/config-removed: rhythm is gone: no clock time decides when she sleeps or wakes/)
    expect(() => resolveConfig({ modes: { day: {} } } as never)).toThrow(/anima\/config-removed: modes is gone/)
    expect(() => resolveConfig({ selfGeneration: 2 } as never)).toThrow(/anima\/config-removed: selfGeneration is gone/)
    expect(() => resolveConfig({ conversationGeneration: 2 } as never)).toThrow(/anima\/config-removed: conversationGeneration is gone/)
    expect(() => resolveConfig({ sleep: { wakeBelow: 0.7 } } as never)).toThrow(/anima\/config-invalid: sleep: wakeBelow/)
    expect(() => resolveConfig({ selfModel: { changesPerDay: 3 } } as never)).toThrow(/anima\/config-removed: selfModel\.changesPerDay/)
    expect(() => resolveConfig({ needs: [DEFAULT_NEEDS[0]!, DEFAULT_NEEDS[0]!] })).toThrow(/defined twice/)
    expect(() => resolveConfig({ needs: [{ ...DEFAULT_NEEDS[0]!, satisfiedBy: { qq_say: 0.3 } }] } as never)).toThrow(/anima\/config-removed: needs\[0\]\.satisfiedBy is gone/)
    expect(() => resolveConfig({ energy: { perTurn: 0.03 } } as never)).toThrow(/anima\/config-removed: energy\.perTurn is gone/)
    expect(() => resolveConfig({ heartbeat: { restingMinutes: 10 } } as never)).toThrow(/anima\/config-invalid: heartbeat/)
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
