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
  /** Stimulus type, e.g. `message`, `burst`, `heartbeat`, `alarm`. */
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
 * Sleep and the inbox: she fell asleep (`sleep`: she went to bed, or sleep
 * overwhelmed her), she woke (`woke`: rested, an alarm, the owner), a waking
 * session was opened or archived (`waking-open`, `waking-archive`), a chat
 * message was held while she slept or was paused (`inbox-held`), or held
 * messages left the inbox (`inbox-release`: she spoke there, or the chat wrote again).
 */
export interface SleepActivity {
  readonly type: 'sleep' | 'woke' | 'waking-open' | 'waking-archive' | 'inbox-held' | 'inbox-release'
  readonly at: number
  readonly real: number
  /** `sleep` and `woke`: how. */
  readonly by?: string
  /** `sleep`: her note. */
  readonly note?: string
  readonly sessionId?: string
  /** Inbox records: the channel key. */
  readonly channel?: string
  /** `inbox-held`: why held (`asleep`, `paused`); `inbox-release`: how (`said`, `wrote`). */
  readonly reason?: string
  /** `inbox-release`: how many messages. */
  readonly count?: number
}

/** Any activity record. */
export type ActivityRecord = GateRecord | WakeRecord | OwnerRecord | PlatformRecord | SleepActivity

/** Activity record without its timestamps, as producers hand it in. */
export type NewActivity = Omit<GateRecord, 'at' | 'real'> | Omit<WakeRecord, 'at' | 'real'> | Omit<OwnerRecord, 'at' | 'real'> | Omit<PlatformRecord, 'at' | 'real'> | Omit<SleepActivity, 'at' | 'real'>
