/**
 * Sleep (docs/design/body.md): her sleep pressure and whether sleep comes,
 * takes her, or lets her go. Going to bed is her will (`sleep`); everything
 * here is her body. No clock time decides any of it. The parameters are her
 * genes, not rules. Pure.
 * @module @anima/core/sleep
 */

import { AnimaError } from './types.ts'

/** Her sleep genes. */
export interface SleepGenes {
  /** Pressure gained per awake hour. */
  risePerHour: number
  /** Pressure lost per sleeping hour. */
  fallPerHour: number
  /** Above this, sleep comes when she goes to bed. */
  fallAsleepAbove: number
  /** At or above this, sleep takes her once her running turn ends. */
  overwhelmAbove: number
  /** At or below this, asleep, she wakes by herself. */
  wakeBelow: number
}

/** How she fell asleep: she went to bed, or sleep overwhelmed her. */
export type FellAsleepBy = 'her' | 'overwhelmed'

/** What woke her: her body (rested), an alarm she set, or the owner from outside. */
export type WokeBy = 'rested' | 'alarm' | 'owner'

/** Her current phase, kept in `state.json`. */
export interface SleepRecord {
  readonly asleep: boolean
  /** When this phase began, on her clock. */
  readonly since: number
  /** What began it; `start` is her first waking in this data directory. */
  readonly by: FellAsleepBy | WokeBy | 'start'
  /** Asleep: the note she went to bed with. */
  readonly note?: string | undefined
}

/** Starting pressure of a fresh body, awake. */
export const INITIAL_PRESSURE = 0.15

/**
 * Validate her sleep genes. Fails loud with `anima/config-invalid`.
 * @param genes - raw genes.
 */
export function checkSleepGenes(genes: SleepGenes): SleepGenes {
  if (!(genes.wakeBelow < genes.fallAsleepAbove && genes.fallAsleepAbove < genes.overwhelmAbove)) {
    throw new AnimaError('anima/config-invalid', `sleep: wakeBelow (${genes.wakeBelow}) < fallAsleepAbove (${genes.fallAsleepAbove}) < overwhelmAbove (${genes.overwhelmAbove}) must hold.`)
  }
  if (genes.risePerHour <= 0 || genes.fallPerHour <= 0) throw new AnimaError('anima/config-invalid', 'sleep: risePerHour and fallPerHour must be above 0.')
  return genes
}

/** Pressure after `hours` in one phase, clamped to 0–1. */
export function movePressure(pressure: number, hours: number, asleep: boolean, genes: SleepGenes): number {
  const next = asleep ? pressure - genes.fallPerHour * hours : pressure + genes.risePerHour * hours
  return Math.min(1, Math.max(0, next))
}

/** Whether sleep comes when she goes to bed. */
export function sleepComes(pressure: number, genes: SleepGenes): boolean {
  return pressure > genes.fallAsleepAbove
}

/** Whether sleep takes her (once her running turn ends). */
export function overwhelms(pressure: number, genes: SleepGenes): boolean {
  return pressure >= genes.overwhelmAbove
}

/** Whether, asleep, she has slept enough to wake by herself. */
export function rested(pressure: number, genes: SleepGenes): boolean {
  return pressure <= genes.wakeBelow
}

/**
 * Her phase from a saved file; anything else (missing, or a file from before
 * R4) starts her awake now.
 */
export function loadSleepRecord(saved: unknown, now: number): SleepRecord {
  const record = saved as Partial<SleepRecord> | undefined
  if (record !== undefined && typeof record.asleep === 'boolean' && typeof record.since === 'number' && typeof record.by === 'string' && record.since <= now) {
    return record as SleepRecord
  }
  return { asleep: false, since: now, by: 'start' }
}
