import { describe, expect, it } from 'vitest'
import { resolveConfig } from '@anima/core'
import { beatMinutes, nextBeat, type HeartBody } from '../src/heartbeat.ts'

const genes = resolveConfig({}).heartbeat
const baseline = { valence: 0, arousal: 0.3 }
const body = (over: Partial<HeartBody['state']> = {}, asleep = false): HeartBody => ({
  state: { energy: 1, mood: { ...baseline }, needs: { connect: 0.4, rest: 0.2 }, ...over },
  mood: baseline,
  asleep,
})

describe('heartbeat rhythm', () => {
  it('beats at her resting rhythm when she is rested and calm', () => {
    expect(beatMinutes(body(), genes)).toBe(genes.restingMinutes)
    expect(nextBeat(0, body(), genes)).toBe(genes.restingMinutes * 60_000)
  })

  it('quickens with arousal, a bad mood and a strong need', () => {
    const rest = beatMinutes(body(), genes)
    expect(beatMinutes(body({ mood: { valence: 0, arousal: 0.8 } }), genes)).toBeLessThan(rest)
    expect(beatMinutes(body({ mood: { valence: -0.8, arousal: 0.3 } }), genes)).toBeLessThan(rest)
    expect(beatMinutes(body({ needs: { connect: 0.95 } }), genes)).toBeLessThan(rest)
    expect(beatMinutes(body({ mood: { valence: 0.8, arousal: 0.3 } }), genes)).toBe(rest)
  })

  it('slows when she is tired and while she sleeps', () => {
    const rest = beatMinutes(body(), genes)
    const tired = beatMinutes(body({ energy: 0.2 }), genes)
    expect(tired).toBeGreaterThan(rest)
    expect(beatMinutes(body({ energy: 0.2 }, true), genes)).toBeGreaterThan(tired)
  })

  it('stays within her heart\'s range', () => {
    expect(beatMinutes(body({ mood: { valence: -1, arousal: 1 }, needs: { connect: 1 } }), genes)).toBeGreaterThanOrEqual(genes.fastestMinutes)
    expect(beatMinutes(body({ energy: 0, mood: { valence: 0, arousal: 0 } }, true), genes)).toBe(genes.slowestMinutes)
  })
})
