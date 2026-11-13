/**
 * Heartbeat scheduling (DESIGN §7): she picks her next heartbeat with
 * `rest(until)`; code only clamps it into the owner's bounds and the night rule
 * (at most `maxWakes` per night, otherwise sleep until wake). Pure.
 * @module @anima/life/heartbeat
 */

import { modeAt, nextWake, type Mode, type Rhythm } from '@anima/core'

/** Inputs of one scheduling decision. */
export interface ScheduleInput {
  /** Now, on her clock. */
  readonly now: number
  /** Time she asked for, if any. */
  readonly requested?: number | undefined
  readonly rhythm: Rhythm
  /** Day-mode bounds, minutes. */
  readonly minMinutes: number
  readonly maxMinutes: number
  readonly defaultMinutes: number
  /** Night wake-ups still allowed tonight. */
  readonly nightWakesLeft: number
  /** Her mode at a time, from when she actually sleeps (Phase 9); the plain rhythm when omitted. */
  readonly mode?: ((t: number) => Mode) | undefined
}

/** A scheduled heartbeat. */
export interface NextHeartbeat {
  /** When, on her clock. */
  readonly at: number
  /** Whether this heartbeat is a night wake-up (counts against the night). */
  readonly nightWake: boolean
  /** How the request was adjusted, for the tool result; undefined when taken as asked. */
  readonly adjusted?: string
}

const MIN = 60_000

/**
 * Decide the next heartbeat.
 * - By day the time she asked for (or the default) is clamped to [now+min, now+max].
 * - A time that falls into the night, or past the next wake, is moved to the next
 *   wake, unless she asked for exactly that night time and a night wake-up is left.
 * @param input - scheduling inputs.
 * @returns the next heartbeat.
 */
export function nextHeartbeat(input: ScheduleInput): NextHeartbeat {
  const { now, requested, rhythm } = input
  const modeOf = input.mode ?? ((t: number) => modeAt(t, rhythm))
  const earliest = now + input.minMinutes * MIN
  const latest = now + input.maxMinutes * MIN
  const base = requested ?? now + input.defaultMinutes * MIN
  const clamped = Math.min(latest, Math.max(earliest, base))
  let adjusted: string | undefined
  if (requested !== undefined && clamped !== requested) {
    adjusted = requested < earliest ? `moved to the earliest allowed, ${input.minMinutes} min from now` : `moved to the latest allowed, ${input.maxMinutes / 60} h from now`
  }
  const nightNow = modeOf(now) === 'night'
  // A time past her next wake would skip a whole night, and with it the first heartbeat of
  // the morning, where she sees her inbox. That happens when the night is shorter than the
  // day-mode maximum (a compressed test rhythm, Phase 9 supervised session).
  if (!nightNow && clamped > nextWake(now, rhythm)) return { at: nextWake(now, rhythm), nightWake: false, adjusted: 'you sleep until your wake time' }
  if (!nightNow && modeOf(clamped) === 'day') return { at: clamped, nightWake: false, ...adjusted === undefined ? {} : { adjusted } }

  // The heartbeat would land at night (or it is night now).
  const wake = nextWake(nightNow ? now : clamped, rhythm)
  if (requested !== undefined && requested >= earliest && requested < wake && modeOf(requested) === 'night' && input.nightWakesLeft > 0) {
    return { at: requested, nightWake: true }
  }
  return { at: wake, nightWake: false, adjusted: input.nightWakesLeft > 0 || requested === undefined ? 'you sleep until your wake time' : 'no night wake-up is left; you sleep until your wake time' }
}
