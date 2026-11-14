/**
 * Activity records (docs/design/outside.md): what the persona reports through
 * `anima/record` and what the guard decides. The persona only emits them; the
 * guard keeps the log.
 * @module @anima/core/records
 */

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

/**
 * Sleep and the inbox (Phase 9): she fell asleep (`sleep`, by her or at the
 * latest bedtime), the owner woke her (`woken`), a chat message was held while
 * she slept or was paused (`inbox-held`), or held messages went to their chat
 * (`inbox-release`: answered from Self, or joined a new wake).
 */
export interface SleepActivity {
  readonly type: 'sleep' | 'woken' | 'inbox-held' | 'inbox-release'
  readonly at: number
  readonly real: number
  /** `sleep`: how. */
  readonly by?: 'her' | 'latest'
  /** `sleep`: her note; `inbox-release`: Self's note. */
  readonly note?: string
  readonly sessionId?: string
  /** Inbox records: the channel key. */
  readonly channel?: string
  /** `inbox-held`: why held (`asleep`, `paused`); `inbox-release`: how (`answer`, `wake`, `intent`). */
  readonly reason?: string
  /** `inbox-release`: how many messages. */
  readonly count?: number
  /** `woken`: until when (her clock). */
  readonly until?: number
}

/** Any activity record. */
export type ActivityRecord = GateRecord | WakeRecord | OwnerRecord | PlatformRecord | SpeechRecord | SleepActivity

/** Activity record without its timestamps, as producers hand it in. */
export type NewActivity = Omit<GateRecord, 'at' | 'real'> | Omit<WakeRecord, 'at' | 'real'> | Omit<OwnerRecord, 'at' | 'real'> | Omit<PlatformRecord, 'at' | 'real'> | Omit<SpeechRecord, 'at' | 'real'> | Omit<SleepActivity, 'at' | 'real'>
