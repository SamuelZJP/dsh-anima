/**
 * Her alarms (docs/design/body.md, Time): `alarm_set`, `alarm_list`, `alarm_cancel`
 * over DSH's schedule service. An alarm always rings in the session she sets it
 * from; that is plumbing, not a rule, so nothing refuses a target. `at` is on her
 * clock and is turned into a real delay here, because DSH's schedule runs on the
 * real clock.
 * @module @anima/core/alarms
 */

import { formatLocal, parseWhen } from './clock.ts'
import { AnimaError } from './types.ts'

/** The part of DSH's schedule service her alarms use (`ctx.get('schedule')`). */
export interface ScheduleLike {
  create(request: {
    title: string
    prompt: string
    timing: { kind: 'after'; after_seconds: number }
    target: { kind: 'session'; sessionId: string }
  }, actorSessionId?: string): Promise<{ id: string }>
  list(request?: { active?: boolean; limit?: number }): Promise<{ items: readonly AlarmEntry[] }>
  edit(request: { id: string; action: 'delete' }, actorSessionId?: string): Promise<unknown>
}

/** A schedule task as her alarms read it. */
export interface AlarmEntry {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly status: string
  readonly target: { readonly kind: string; readonly sessionId?: string }
}

/** Title prefix of her alarms; the rest is the time on her clock. */
const TITLE = 'Anima alarm '

/**
 * Plan one alarm.
 * @param at - when, on her clock: "HH:mm" or "YYYY-MM-DD HH:mm".
 * @param now - her clock now.
 * @param realDelay - real milliseconds for a span of her clock.
 * @returns the time on her clock and the real delay in whole seconds (at least 1).
 * @throws {AnimaError} `anima/bad-time` when `at` is not a time.
 */
export function planAlarm(at: string, now: number, realDelay: (ms: number) => number): { at: number; afterSeconds: number } {
  const when = parseWhen(at, now)
  if (when === undefined) throw new AnimaError('anima/bad-time', `"${at}" is not a time like 21:00 or 2026-11-10 21:00.`)
  return { at: when, afterSeconds: Math.max(1, Math.ceil(realDelay(Math.max(0, when - now)) / 1000)) }
}

/**
 * Her alarms in one session, oldest first.
 * @param items - schedule tasks.
 * @param sessionId - the session she is in.
 */
export function alarmsIn(items: readonly AlarmEntry[], sessionId: string): AlarmEntry[] {
  return items.filter(item => item.status === 'active' && item.title.startsWith(TITLE) && item.target.kind === 'session' && item.target.sessionId === sessionId)
}

/** Schedule title of an alarm at a time on her clock. */
export function alarmTitle(at: number): string {
  return `${TITLE}${formatLocal(at)}`
}

/** One line per alarm: id, time on her clock, note. */
export function alarmLine(item: AlarmEntry): string {
  return `${item.id}: ${item.title.slice(TITLE.length)} — ${item.prompt}`
}
