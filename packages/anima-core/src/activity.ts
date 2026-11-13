/**
 * Activity log (DESIGN §12): what the gate decided, what woke her, what
 * the owner changed, and when a platform went offline or came back, one JSONL file per her day under `<dataDir>/activity/`.
 * It is the evidence the Anima page's Activity tab and the formal test read.
 * Recording never decides anything.
 * @module @anima/core/activity
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DayLedger } from './ledger.ts'

/** Who ran an owner action. */
export type OwnerSource = 'command' | 'page'

/** One gate decision on a behavior call. */
export interface GateRecord {
  readonly type: 'gate'
  /** Her clock, ms. */
  readonly at: number
  /** Real clock, ms. */
  readonly real: number
  readonly behavior: string
  /** Session kind, absent outside Anima sessions. */
  readonly session?: string
  readonly sessionId?: string
  /** `allowed`, `refused`, or the owner's answer to an approval (`approved`, `denied`). */
  readonly decision: 'allowed' | 'refused' | 'approved' | 'denied'
  readonly code?: string
  readonly hint?: string
  /** Channel key, for admissions that are not tool calls (`group_attention`). */
  readonly channel?: string
}

/** One delivery that woke a turn. */
export interface WakeRecord {
  readonly type: 'wake'
  readonly at: number
  readonly real: number
  /** Stimulus type, e.g. `message`, `heartbeat`, `intent`. */
  readonly stimulus: string
  /** Session kind it went to. */
  readonly session: string
  readonly sessionId?: string
  readonly channel?: string
}

/** One owner action from a command or the page. */
export interface OwnerRecord {
  readonly type: 'owner'
  readonly at: number
  readonly real: number
  readonly action: string
  readonly source: OwnerSource
  readonly args: Readonly<Record<string, unknown>>
  readonly ok: boolean
  readonly error?: string
}

/** A platform went offline or came back, as its adapter reported it (a development warning, Phase 7). */
export interface PlatformRecord {
  readonly type: 'platform'
  readonly at: number
  readonly real: number
  readonly platform: string
  readonly online: boolean
  readonly reason?: string
}

/**
 * A conversation turn that was about to stop without a closing action (DESIGN
 * §6, Turn shape): `reminder` when a reminder was steered into it, `lost-reply`
 * when it ended unclosed after the reminders. Nothing is ever forwarded.
 */
export interface SpeechRecord {
  readonly type: 'reminder' | 'lost-reply'
  readonly at: number
  readonly real: number
  readonly channel: string
  readonly sessionId: string
  /** Her last plain text in that turn, which nobody saw (may be empty). */
  readonly text: string
  /** Reminder number in the turn (reminders only). */
  readonly count?: number
  /** Lost replies only: how the turn ended when it was not by running out of reminders, e.g. `error: MALFORMED_RESPONSE`. */
  readonly reason?: string
}

/** Any activity record. */
export type ActivityRecord = GateRecord | WakeRecord | OwnerRecord | PlatformRecord | SpeechRecord

/** Activity record without its timestamps, as producers hand it in. */
export type NewActivity = Omit<GateRecord, 'at' | 'real'> | Omit<WakeRecord, 'at' | 'real'> | Omit<OwnerRecord, 'at' | 'real'> | Omit<PlatformRecord, 'at' | 'real'> | Omit<SpeechRecord, 'at' | 'real'>

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
export function summarize(day: string, records: readonly ActivityRecord[], ledger: Readonly<DayLedger>): DaySummary {
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
  }
}
