import { describe, expect, it } from 'vitest'
import { bodyCheck, GateCode, visibleIn } from '../src/gate.ts'
import type { BodyCall, BodyMoment } from '../src/gate.ts'
import type { BehaviorMeta, SessionInfo } from '../src/types.ts'

const waking: SessionInfo = { kind: 'waking', current: true }
const consolidation: SessionInfo = { kind: 'consolidation' }

const say: BehaviorMeta = { platform: 'demo', effect: 'express', sessions: ['waking'], target: args => args.channel as string }
const qqSay: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['waking'], target: args => args.channel as string }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['waking'] }
const write: BehaviorMeta = { effect: 'internal', sessions: ['consolidation'] }

const awake: BodyMoment = { asleep: false }
const asleep: BodyMoment = { asleep: true }

function call(name: string, meta: BehaviorMeta, session: SessionInfo | undefined, args: Record<string, unknown> = {}): BodyCall {
  return { name, meta, session, args }
}

describe('visibleIn', () => {
  it('hides every behavior outside Anima sessions', () => {
    expect(visibleIn(remember, undefined)).toBe(false)
  })
  it('shows a waking session every platform: one stream of attention', () => {
    expect(visibleIn(say, waking)).toBe(true)
    expect(visibleIn(qqSay, waking)).toBe(true)
    expect(visibleIn(remember, waking)).toBe(true)
  })
  it('respects the session kinds', () => {
    expect(visibleIn(say, consolidation)).toBe(false)
    expect(visibleIn(write, waking)).toBe(false)
    expect(visibleIn(write, consolidation)).toBe(true)
  })
})

describe('bodyCheck', () => {
  const cases: [string, BodyCall, string | undefined][] = [
    ['allows a fitting call', call('demo_say', say, waking), undefined],
    ['refuses outside Anima sessions', call('demo_say', say, undefined), GateCode.notAnimaSession],
    ['refuses the wrong session kind', call('demo_say', say, consolidation), GateCode.wrongSession],
    ['has no safety rule: a public behavior is the outside\'s business', call('core_post', { effect: 'public', sessions: ['waking'] }, waking), undefined],
  ]
  for (const [title, input, code] of cases) {
    it(title, () => {
      const verdict = bodyCheck(input, awake)
      if (code === undefined) expect(verdict).toEqual({ allowed: true })
      else expect(verdict).toMatchObject({ allowed: false, code })
    })
  }

  it('gives a hint she can act on', () => {
    const verdict = bodyCheck(call('memory_write', write, waking), awake)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.hint).toContain('睡着时整理记忆')
  })

  it('refuses everything in a waking session while she sleeps; sleep\'s own consolidation goes on', () => {
    expect(bodyCheck(call('demo_say', say, waking), asleep)).toMatchObject({ allowed: false, code: GateCode.asleep })
    expect(bodyCheck(call('memory_recall', remember, waking), asleep)).toMatchObject({ allowed: false, code: GateCode.asleep })
    expect(bodyCheck(call('memory_write', write, consolidation), asleep).allowed).toBe(true)
  })

  it('refuses a target that does not exist, listing what does', () => {
    const moment: BodyMoment = { ...awake, channelKnown: key => key === 'qq:1:private:2', knownChannels: () => ['qq:1:private:2'] }
    const verdict = bodyCheck(call('qq_say', qqSay, waking, { channel: 'qq:1:private:9' }), moment)
    expect(verdict).toMatchObject({ allowed: false, code: GateCode.unknownChannel, hint: expect.stringContaining('qq:1:private:2') })
    expect(bodyCheck(call('qq_say', qqSay, waking, { channel: 'qq:1:private:2' }), moment).allowed).toBe(true)
  })

  it('has no policy on arguments and no clock rule: only her body refuses', () => {
    expect(Object.values(GateCode)).not.toContain('anima/not-allowed')
    expect(Object.values(GateCode)).not.toContain('anima/not-bedtime')
    expect(Object.values(GateCode)).not.toContain('anima/night')
    const alarm: BehaviorMeta = { effect: 'internal', sessions: ['waking'] }
    expect(bodyCheck(call('alarm_set', alarm, waking, { at: '21:00', note: 'anything' }), awake).allowed).toBe(true)
  })
})
