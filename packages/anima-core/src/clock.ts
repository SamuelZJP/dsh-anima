/**
 * Her clock: the single time source for phase, needs, heartbeats, quiet hours,
 * daily budgets and the gate. It runs at real speed by default; a test day can
 * speed it up (`clock.speed`) and start it at a chosen local time (`clock.start`).
 * Times are epoch milliseconds in simulated time; local formatting uses the
 * process time zone.
 * @module @anima/core/clock
 */

import { AnimaError } from './types.ts'

/** Clock config. */
export interface ClockConfig {
  /** Simulated milliseconds per real millisecond; 1 is real time. */
  speed: number
  /** Simulated local start time (`YYYY-MM-DDTHH:mm`), applied when the plugin loads. */
  start?: string
}

/** Simulated clock. */
export class AnimaClock {
  private readonly realOrigin: number
  private readonly simOrigin: number
  private override: (() => number) | undefined

  /**
   * @param config - speed and optional start.
   * @param realNow - real clock (tests).
   */
  constructor(readonly config: Readonly<ClockConfig>, private readonly realNow: () => number = Date.now) {
    if (!(config.speed >= 1)) throw new AnimaError('anima/config-invalid', `clock.speed must be at least 1, got ${config.speed}.`)
    this.realOrigin = realNow()
    if (config.start === undefined || config.start === '') {
      this.simOrigin = this.realOrigin
    } else {
      const start = parseLocalDateTime(config.start)
      if (start === undefined) throw new AnimaError('anima/config-invalid', `clock.start "${config.start}" is not a local time like 2026-11-10T07:00.`)
      this.simOrigin = start
    }
  }

  /** Clock speed. */
  get speed(): number {
    return this.config.speed
  }

  /** Current simulated time, epoch ms. */
  now(): number {
    if (this.override !== undefined) return this.override()
    return this.simOrigin + (this.realNow() - this.realOrigin) * this.config.speed
  }

  /** Current real time, epoch ms. */
  realTime(): number {
    return this.realNow()
  }

  /**
   * Real milliseconds until a simulated span has passed.
   * @param simMs - simulated span.
   */
  realDelay(simMs: number): number {
    return Math.max(0, simMs / this.config.speed)
  }

  /** Replace the simulated clock entirely (tests); `undefined` restores it. */
  setOverride(now: (() => number) | undefined): void {
    this.override = now
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Local date `YYYY-MM-DD`.
 * @param t - epoch ms.
 */
export function localDate(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Local time `YYYY-MM-DD HH:mm`.
 * @param t - epoch ms.
 */
export function formatLocal(t: number): string {
  const d = new Date(t)
  return `${localDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Stamp prefixed to every stimulus, e.g. `Tue 2026-11-10 08:12`.
 * @param t - epoch ms.
 */
export function formatStamp(t: number): string {
  return `${WEEKDAYS[new Date(t).getDay()]} ${formatLocal(t)}`
}

/**
 * Parse `YYYY-MM-DD[T ]HH:mm[:ss]` as local time.
 * @returns epoch ms, or undefined when malformed.
 */
export function parseLocalDateTime(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number]
  const date = new Date(y, mo - 1, d, h, mi, Number.isNaN(s) ? 0 : s)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) return undefined
  return date.getTime()
}

/**
 * Parse `HH:mm` into minutes after midnight.
 * @returns minutes, or undefined when malformed.
 */
export function parseClockTime(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const h = Number(match[1])
  const m = Number(match[2])
  return h > 23 || m > 59 ? undefined : h * 60 + m
}

/**
 * Next local occurrence of a time of day strictly after `t`.
 * @param t - epoch ms.
 * @param minutes - minutes after midnight.
 */
export function nextAtClock(t: number, minutes: number): number {
  const d = new Date(t)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  if (d.getTime() <= t) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * Parse a time she or the owner wrote: `YYYY-MM-DD HH:mm` or `HH:mm` (the next
 * such time after `now`).
 * @returns epoch ms, or undefined when malformed.
 */
export function parseWhen(text: string, now: number): number | undefined {
  const full = parseLocalDateTime(text)
  if (full !== undefined) return full
  const minutes = parseClockTime(text)
  return minutes === undefined ? undefined : nextAtClock(now, minutes)
}
