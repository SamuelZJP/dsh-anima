/**
 * JSON shapes of the owner views the page reads (produced by `@anima/core`,
 * `@anima/life`, `@anima/memory`, the adapters and the page's Settings).
 * @module @anima/page/client/types
 */

export interface StatusView {
  character: { id: string; name: string; dataDir: string }
  paused: boolean
  /** Awake or asleep and since when (Phase 9); absent from an older core. */
  sleep?: { earliest: number; latest: number; asleep: boolean; since?: number; by?: 'her' | 'latest'; wokenAt?: number; wokenUntil?: number }
  clock: { now: number; text: string; speed: number; phase: string; mode: 'day' | 'night'; day: string }
  energy: number
  mood: { valence: number; arousal: number }
  needs: { name: string; description: string; value: number }[]
  budgets: {
    tokens: { day: number; night: number; dayBudget: number; nightBudget: number }
    initiates: { used: number; perDay: number }
    overBudget: boolean
  }
  goals: number
  approvals: number
  ownerLine: string | null
  selfModel: { notes: number }
  quotas: string[]
  parts: { life?: LifePart } & Record<string, unknown>
}

export interface LifePart {
  nextHeartbeat: string | null
  lastHeartbeat: string | null
  selfActing: boolean
  counts: { heartbeats: number; acts: number; rests: number; intents: number }
  intents: { id: string; display: string }[]
  outboxHeld: number
  /** Her inbox per channel (Phase 9). */
  inbox?: { key: string; display: string; count: number; first: number; last: number }[]
  sessions: { self: string; triage: string; conversations: { sessionId: string; display: string; channelKey: string }[] }
}

export interface PlatformEntry {
  platform: string
  title: string
  view: { health: 'ok' | 'warn' | 'down' | 'off'; summary: string; details: Record<string, unknown> }
}

export interface SelfEntry { id: string; section: string; text: string; since: number }
export interface SelfDiff {
  id: string; at: number; real: number; by: 'her' | 'owner'; op: 'add' | 'change' | 'remove' | 'revert'
  entryId: string; section: string; before?: string; after?: string; reason: string; sessionId?: string; revertOf?: string
}
export interface SelfModelView { entries: SelfEntry[]; diffs: SelfDiff[] }

export interface Memory {
  id: string; kind: string; scope: string; personId?: string; channelKey?: string; text: string
  importance: number; strength: number; recalls: number; createdAt: number; status: string; replacedBy?: string
}
export interface MemoryView {
  memories: Memory[]; total: number; limit: number; offset: number
  counts: Record<string, number>; scopes: { scope: string; count: number }[]; pending: number
}

export interface Goal { id: string; text: string; owner: string; status: string; due?: number; notes: { at: number; text: string }[] }
export interface ApprovalsView { ownerLine: string | null; pending: { id: string; summary: string }[] }
export interface OutboxView { delaySeconds: number; held: { id: string; display: string; channelKey: string; intentId: string; text: string; sendsAt: number }[] }

export type ActivityRecord =
  | { type: 'gate'; at: number; real: number; behavior: string; session?: string; sessionId?: string; decision: 'allowed' | 'refused' | 'approved' | 'denied'; code?: string; hint?: string }
  | { type: 'wake'; at: number; real: number; stimulus: string; session: string; sessionId?: string; channel?: string }
  | { type: 'owner'; at: number; real: number; action: string; source: string; args: Record<string, unknown>; ok: boolean; error?: string }
  | { type: 'platform'; at: number; real: number; platform: string; online: boolean; reason?: string }

export interface DaySummary {
  day: string
  calls: { allowed: number; refused: number; approved: number; denied: number }
  refusals: { code: string; count: number }[]
  behaviors: { behavior: string; count: number }[]
  wakes: { total: number; byStimulus: Record<string, number>; bySession: Record<string, number> }
  ownerActions: number
  tokens: { day: number; night: number }
  initiates: number
}
export interface ActivityView { day: string; days: string[]; summary: DaySummary; records: ActivityRecord[] }

export interface SettingsRow { id: string; name: string; editable: boolean; disabled: boolean; effective: unknown; inherited: unknown; override: unknown; higherLayer: boolean }
export type SettingsView = { available: true; path: string; rows: SettingsRow[] }
