/**
 * Her heartbeat (docs/design/body.md): her self-drive. It beats because she is
 * alive, at a rhythm that follows her own state (arousal, mood, energy, needs,
 * asleep or awake) through her heart's genes (`heartbeat`). Nothing she does
 * and nothing outside sets, delays, skips or paces it: there is no input here
 * but her body. Pure.
 * @module @anima/life/heartbeat
 */

import type { HeartGenes, MoodConfig, SelfState } from '@anima/core'

/** Milliseconds per minute. */
const MIN = 60_000

/** What her heart feels of her body. */
export interface HeartBody {
  /** Her state now. */
  readonly state: Pick<SelfState, 'energy' | 'mood' | 'needs'>
  /** Her mood's baseline (a gene). */
  readonly mood: Pick<MoodConfig, 'valence' | 'arousal'>
  /** Whether she is asleep. */
  readonly asleep: boolean
}

/**
 * Minutes until her next beat, from her state: arousal above its baseline, a
 * bad mood and a strong need quicken it; spent energy and sleep slow it; it
 * stays within her heart's range.
 * @param body - her state now.
 * @param genes - her heart's genes.
 */
export function beatMinutes(body: HeartBody, genes: HeartGenes): number {
  const { state, mood } = body
  const strongest = Math.max(0, ...Object.values(state.needs))
  const quicken = 1
    + genes.arousalGain * (state.mood.arousal - mood.arousal)
    + genes.valenceGain * Math.max(0, mood.valence - state.mood.valence)
    + genes.needGain * Math.max(0, strongest - 0.5)
  const slow = (1 + genes.fatigueGain * (1 - state.energy)) * (body.asleep ? genes.asleepFactor : 1)
  const minutes = genes.restingMinutes * slow / Math.max(0.25, quicken)
  return Math.min(genes.slowestMinutes, Math.max(genes.fastestMinutes, minutes))
}

/**
 * When her heart beats next.
 * @param last - when it last beat, on her clock.
 * @param body - her state at that beat.
 * @param genes - her heart's genes.
 * @returns the next beat, on her clock.
 */
export function nextBeat(last: number, body: HeartBody, genes: HeartGenes): number {
  return last + Math.round(beatMinutes(body, genes) * MIN)
}
