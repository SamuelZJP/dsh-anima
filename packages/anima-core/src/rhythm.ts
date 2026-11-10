/**
 * Day rhythm (DESIGN §7): circadian phase, day/night mode and her day key, all
 * computed from a clock reading. Pure.
 * @module @anima/core/rhythm
 */

import { localDate, nextAtClock, parseClockTime } from './clock.ts'
import { AnimaError } from './types.ts'

/** Circadian phase. */
export type Phase = 'asleep' | 'waking' | 'day' | 'evening' | 'winding-down'

/** Heartbeat mode: `night` while asleep, `day` otherwise. */
export type Mode = 'day' | 'night'

/** Rhythm config, as written in cordis.yml. */
export interface RhythmConfig {
  /** Wake time `HH:mm`. */
  wake: string
  /** Sleep time `HH:mm`. */
  sleep: string
  /** Length of the `waking` phase after wake. */
  wakingMinutes: number
  /** Start of `evening`, `HH:mm`. */
  evening: string
  /** Length of `winding-down` before sleep. */
  windDownMinutes: number
}

/** Rhythm with times in minutes after midnight. */
export interface Rhythm {
  readonly wake: number
  readonly sleep: number
  readonly wakingMinutes: number
  readonly evening: number
  readonly windDownMinutes: number
}

const DAY = 24 * 60

/**
 * Validate a rhythm config. Fails loud with `anima/config-invalid`.
 * @param config - raw rhythm.
 */
export function resolveRhythm(config: RhythmConfig): Rhythm {
  const time = (field: 'wake' | 'sleep' | 'evening') => {
    const minutes = parseClockTime(config[field])
    if (minutes === undefined) throw new AnimaError('anima/config-invalid', `rhythm.${field} "${config[field]}" must be HH:mm.`)
    return minutes
  }
  const rhythm = { wake: time('wake'), sleep: time('sleep'), evening: time('evening'), wakingMinutes: config.wakingMinutes, windDownMinutes: config.windDownMinutes }
  if (rhythm.wake === rhythm.sleep) throw new AnimaError('anima/config-invalid', 'rhythm.wake and rhythm.sleep must differ.')
  if (awakeMinutes(rhythm) <= rhythm.wakingMinutes + rhythm.windDownMinutes) {
    throw new AnimaError('anima/config-invalid', 'rhythm: wakingMinutes + windDownMinutes must fit inside her waking hours.')
  }
  return rhythm
}

/** Minutes between wake and sleep. */
function awakeMinutes(rhythm: Rhythm): number {
  return (rhythm.sleep - rhythm.wake + DAY) % DAY
}

/** Local minutes after midnight, with seconds as a fraction. */
function minuteOfDay(t: number): number {
  const d = new Date(t)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

/** Minutes since wake, in [0, 1440). */
function sinceWake(t: number, rhythm: Rhythm): number {
  return (minuteOfDay(t) - rhythm.wake + DAY) % DAY
}

/**
 * Her circadian phase at a time.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 */
export function phaseAt(t: number, rhythm: Rhythm): Phase {
  const since = sinceWake(t, rhythm)
  const awake = awakeMinutes(rhythm)
  if (since >= awake) return 'asleep'
  if (since < rhythm.wakingMinutes) return 'waking'
  if (since >= awake - rhythm.windDownMinutes) return 'winding-down'
  const eveningSince = (rhythm.evening - rhythm.wake + DAY) % DAY
  return since >= eveningSince && eveningSince < awake ? 'evening' : 'day'
}

/**
 * Heartbeat mode at a time.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 */
export function modeAt(t: number, rhythm: Rhythm): Mode {
  return phaseAt(t, rhythm) === 'asleep' ? 'night' : 'day'
}

/**
 * Her day runs from one wake to the next; the night belongs to the day before it.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 * @returns the local date of the wake that began her current day.
 */
export function dayKey(t: number, rhythm: Rhythm): string {
  return localDate(t - sinceWake(t, rhythm) * 60_000)
}

/**
 * The next wake strictly after `t`.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 */
export function nextWake(t: number, rhythm: Rhythm): number {
  return nextAtClock(t, rhythm.wake)
}

/**
 * Whether a local time lies inside a `HH:mm`–`HH:mm` window (which may wrap midnight).
 * @param t - epoch ms.
 * @param from - window start, minutes after midnight.
 * @param to - window end, minutes after midnight.
 */
export function inWindow(t: number, from: number, to: number): boolean {
  const m = minuteOfDay(t)
  return from <= to ? m >= from && m < to : m >= from || m < to
}
