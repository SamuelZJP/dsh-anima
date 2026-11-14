/**
 * Activity log (docs/design/outside.md): what the gates decided, what woke
 * her, what the owner changed, platform health, sleep and the inbox, one JSONL
 * file per her day under `<dataDir>/activity/`. Recording never decides anything.
 * @module @anima/guard/activity
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityRecord, GateRecord, SleepActivity, WakeRecord } from '@anima/core'

export type { ActivityRecord, GateRecord, NewActivity, OwnerRecord, OwnerSource, PlatformRecord, SleepActivity, SpeechRecord, WakeRecord } from '@anima/core'

/** Budget counters of one day, for the summary. */
export interface DayCounts {
  readonly tokens: Readonly<Record<'day' | 'night', number>>
  readonly initiates: number
  readonly nightWakes: number
}

/** Day summary for the Activity tab. */
export interface DaySummary {
  readonly day: string
  readonly calls: { readonly allowed: number; readonly refused: number; readonly approved: number; readonly denied: number }
  /** Refused calls by code, most frequent first. */
  readonly refusals: readonly { readonly code: string; readonly count: number }[]
  /** Allowed calls by behavior, most frequent first. */
  readonly behaviors: readonly { readonly behavior: string; readonly count: number }[]
  /** Wakes by stimulus type and by session kind. */
  readonly wakes: { readonly total: number; readonly byStimulus: Readonly<Record<string, number>>; readonly bySession: Readonly<Record<string, number>> }
  readonly ownerActions: number
  readonly tokens: Readonly<Record<'day' | 'night', number>>
  readonly initiates: number
  readonly nightWakes: number
  /** Reminders steered into unclosed conversation turns, and turns that still ended unclosed (DESIGN §6). */
  readonly speech: { readonly reminders: number; readonly lostReplies: number }
  /**
   * Sleep and the inbox (Phase 9): times she went to sleep (by her, at the latest
   * bedtime), deliberate wakes, held and released inbox messages, and how often
   * she still met the night or pause refusal (a backstop she should rarely meet).
   */
  readonly sleep: {
    readonly byHer: number
    readonly atLatest: number
    readonly woken: number
    readonly held: number
    readonly answered: number
    readonly released: number
    readonly backstop: { readonly night: number; readonly paused: number }
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** Append-only activity log, one file per her day. */
export class ActivityLog {
  /** @param dir - `<dataDir>/activity`. */
  constructor(private readonly dir: string) {}

  /**
   * Append one record.
   * @param day - her day key (`YYYY-MM-DD`).
   * @param record - the record, with timestamps.
   */
  append(day: string, record: ActivityRecord): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(join(this.dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  }

  /** Days with a log, oldest first. */
  days(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).map(name => DAY_FILE.exec(name)?.[1]).filter((day): day is string => day !== undefined).sort()
  }

  /**
   * Records of one day, in order. A torn last line (crash mid-write) is skipped.
   * @param day - her day key.
   */
  read(day: string): ActivityRecord[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return []
    const path = join(this.dir, `${day}.jsonl`)
    if (!existsSync(path)) return []
    const records: ActivityRecord[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as ActivityRecord)
      } catch {
        // A partial line from an interrupted write carries nothing to show.
      }
    }
    return records
  }
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

function ranked(counts: Record<string, number>): { name: string; count: number }[] {
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Summarize one day.
 * @param day - her day key.
 * @param records - that day's records.
 * @param ledger - that day's budget counters.
 */
export function summarize(day: string, records: readonly ActivityRecord[], ledger: DayCounts): DaySummary {
  const gates = records.filter((r): r is GateRecord => r.type === 'gate')
  const wakes = records.filter((r): r is WakeRecord => r.type === 'wake')
  const decisions = countBy(gates, r => r.decision)
  return {
    day,
    calls: { allowed: decisions.allowed ?? 0, refused: decisions.refused ?? 0, approved: decisions.approved ?? 0, denied: decisions.denied ?? 0 },
    refusals: ranked(countBy(gates.filter(r => r.decision === 'refused' || r.decision === 'denied'), r => r.code ?? 'unknown')).map(({ name, count }) => ({ code: name, count })),
    behaviors: ranked(countBy(gates.filter(r => r.decision === 'allowed' || r.decision === 'approved'), r => r.behavior)).map(({ name, count }) => ({ behavior: name, count })),
    wakes: { total: wakes.length, byStimulus: countBy(wakes, r => r.stimulus), bySession: countBy(wakes, r => r.session) },
    ownerActions: records.filter(r => r.type === 'owner').length,
    tokens: { ...ledger.tokens },
    initiates: ledger.initiates,
    nightWakes: ledger.nightWakes,
    speech: { reminders: records.filter(r => r.type === 'reminder').length, lostReplies: records.filter(r => r.type === 'lost-reply').length },
    sleep: {
      byHer: records.filter(r => r.type === 'sleep' && r.by === 'her').length,
      atLatest: records.filter(r => r.type === 'sleep' && r.by === 'latest').length,
      woken: records.filter(r => r.type === 'woken').length,
      held: records.filter(r => r.type === 'inbox-held').length,
      answered: records.filter(r => r.type === 'inbox-release' && r.reason === 'answer').reduce((n, r) => n + ((r as SleepActivity).count ?? 0), 0),
      released: records.filter(r => r.type === 'inbox-release').reduce((n, r) => n + ((r as SleepActivity).count ?? 0), 0),
      backstop: {
        night: gates.filter(r => r.decision === 'refused' && r.code === 'anima/night').length,
        paused: gates.filter(r => r.decision === 'refused' && r.code === 'anima/paused' && r.session !== undefined).length,
      },
    },
  }
}
