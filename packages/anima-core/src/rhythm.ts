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
  /** The owner's bedtime window (Phase 9): she chooses when to sleep inside it. */
  bedtime: {
    /** From this time she may go to sleep with `sleep`, `HH:mm`. */
    earliest: string
    /** At this time she falls asleep anyway, `HH:mm`. */
    latest: string
    /** After a deliberate wake past `latest`, minutes she stays awake unless she sleeps sooner. */
    wokenMinutes: number
  }
  /** Length of the `waking` phase after wake. */
  wakingMinutes: number
  /** Start of `evening`, `HH:mm`. */
  evening: string
  /** Length of `winding-down` before the latest bedtime. */
  windDownMinutes: number
  /** Removed in Phase 9 (replaced by `bedtime`); set, it fails the load. */
  sleep?: string
}

/** Rhythm with times in minutes after midnight. */
export interface Rhythm {
  readonly wake: number
  /** Earliest bedtime. */
  readonly earliest: number
  /** Latest bedtime: asleep from here unless she slept sooner or the owner woke her. */
  readonly latest: number
  readonly wokenMinutes: number
  readonly wakingMinutes: number
  readonly evening: number
  readonly windDownMinutes: number
}

/**
 * When she actually went to sleep and when the owner woke her (Phase 9), on her
 * clock. Kept by core in `state.json`; only entries of the current day of hers count.
 */
export interface SleepRecord {
  /** She fell asleep (by `sleep`, or at the latest bedtime). */
  readonly since?: number | undefined
  /** How: she chose it, or the latest bedtime came. */
  readonly by?: 'her' | 'latest' | undefined
  /** The owner woke her on purpose. */
  readonly wokenAt?: number | undefined
  /** End of that deliberate wake unless she sleeps sooner. */
  readonly wokenUntil?: number | undefined
}

const DAY = 24 * 60

/**
 * Validate a rhythm config. Fails loud with `anima/config-invalid`.
 * @param config - raw rhythm.
 */
export function resolveRhythm(config: RhythmConfig): Rhythm {
  if (config.sleep !== undefined) {
    throw new AnimaError('anima/config-invalid', `rhythm.sleep was replaced by rhythm.bedtime { earliest, latest } in Phase 9; remove sleep "${config.sleep}" and set the bedtime window instead.`)
  }
  const parse = (field: string, text: string) => {
    const minutes = parseClockTime(text)
    if (minutes === undefined) throw new AnimaError('anima/config-invalid', `rhythm.${field} "${text}" must be HH:mm.`)
    return minutes
  }
  const rhythm: Rhythm = {
    wake: parse('wake', config.wake),
    earliest: parse('bedtime.earliest', config.bedtime.earliest),
    latest: parse('bedtime.latest', config.bedtime.latest),
    wokenMinutes: config.bedtime.wokenMinutes,
    evening: parse('evening', config.evening),
    wakingMinutes: config.wakingMinutes,
    windDownMinutes: config.windDownMinutes,
  }
  if (rhythm.wake === rhythm.latest) throw new AnimaError('anima/config-invalid', 'rhythm.wake and rhythm.bedtime.latest must differ.')
  if (rel(rhythm.earliest, rhythm) > rel(rhythm.latest, rhythm)) {
    throw new AnimaError('anima/config-invalid', 'rhythm.bedtime.earliest must come before bedtime.latest within her day (from wake).')
  }
  if (awakeMinutes(rhythm) <= rhythm.wakingMinutes + rhythm.windDownMinutes) {
    throw new AnimaError('anima/config-invalid', 'rhythm: wakingMinutes + windDownMinutes must fit inside her waking hours (wake to the latest bedtime).')
  }
  if (rel(rhythm.earliest, rhythm) < rhythm.wakingMinutes) {
    throw new AnimaError('anima/config-invalid', 'rhythm.bedtime.earliest must come after the waking phase.')
  }
  return rhythm
}

/** Minutes after wake of a clock time. */
function rel(minutes: number, rhythm: Rhythm): number {
  return (minutes - rhythm.wake + DAY) % DAY
}

/** Minutes between wake and the latest bedtime. */
function awakeMinutes(rhythm: Rhythm): number {
  return rel(rhythm.latest, rhythm)
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

/** Start (epoch ms) of the day of hers that contains `t`. */
export function dayStart(t: number, rhythm: Rhythm): number {
  return t - sinceWake(t, rhythm) * 60_000
}

/**
 * Whether she is asleep at a time (Phase 9). Before the earliest bedtime she
 * is awake; inside the window she is asleep once she went to sleep; from the
 * latest bedtime on she is asleep anyway. A deliberate wake by the owner keeps
 * her awake until `wokenUntil` or until she sleeps again. Only record entries of
 * the same day of hers as `t` count.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 * @param record - when she slept and was woken.
 */
export function asleepAt(t: number, rhythm: Rhythm, record: SleepRecord = {}): boolean {
  const since = sinceWake(t, rhythm)
  if (since < rel(rhythm.earliest, rhythm)) return false
  const start = dayStart(t, rhythm)
  const today = (at: number | undefined): at is number => at !== undefined && at >= start && at <= t
  const slept = today(record.since)
  const woken = today(record.wokenAt) && (!slept || record.wokenAt! > record.since!) && t < (record.wokenUntil ?? Infinity)
  if (woken) return false
  if (slept) return true
  return since >= awakeMinutes(rhythm)
}

/**
 * When a deliberate wake at `t` ends unless she sleeps sooner: the latest
 * bedtime, or `wokenMinutes` after the wake when that is later (Phase 9).
 */
export function wokenUntil(t: number, rhythm: Rhythm): number {
  const latest = dayStart(t, rhythm) + awakeMinutes(rhythm) * 60_000
  return Math.max(latest, t + rhythm.wokenMinutes * 60_000)
}

/** The latest bedtime of the day of hers that contains `t` (epoch ms). */
export function latestBedtime(t: number, rhythm: Rhythm): number {
  return dayStart(t, rhythm) + awakeMinutes(rhythm) * 60_000
}

/** The earliest bedtime of the day of hers that contains `t` (epoch ms). */
export function earliestBedtime(t: number, rhythm: Rhythm): number {
  return dayStart(t, rhythm) + rel(rhythm.earliest, rhythm) * 60_000
}

/**
 * Her circadian phase at a time.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 * @param record - when she actually slept and was woken (Phase 9).
 */
export function phaseAt(t: number, rhythm: Rhythm, record?: SleepRecord): Phase {
  if (asleepAt(t, rhythm, record)) return 'asleep'
  const since = sinceWake(t, rhythm)
  const awake = awakeMinutes(rhythm)
  if (since < rhythm.wakingMinutes) return 'waking'
  if (since >= awake - rhythm.windDownMinutes) return 'winding-down'
  const eveningSince = rel(rhythm.evening, rhythm)
  return since >= eveningSince && eveningSince < awake ? 'evening' : 'day'
}

/**
 * Heartbeat mode at a time.
 * @param t - epoch ms.
 * @param rhythm - day rhythm.
 * @param record - when she actually slept and was woken (Phase 9).
 */
export function modeAt(t: number, rhythm: Rhythm, record?: SleepRecord): Mode {
  return asleepAt(t, rhythm, record) ? 'night' : 'day'
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
