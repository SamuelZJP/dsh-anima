/**
 * Forgetting (DESIGN §8): strength decays daily; weak memories become a
 * one-line gist, then leave the active index for the archive. Plain code, pure.
 * @module @anima/memory/decay
 */

import type { DecayConfig } from './config.ts'

/** Kinds of stored memories. `self` memories do not decay. */
export type MemoryKind = 'episode' | 'fact' | 'self'

/** What decay needs from a memory. */
export interface DecayInput {
  readonly kind: MemoryKind
  readonly strength: number
  readonly importance: number
  readonly recalls: number
  /** Whether the text is already a gist. */
  readonly gisted: boolean
}

/** Result of one decay step. */
export interface DecayResult {
  readonly strength: number
  /** Compress the text to a gist now. */
  readonly gist: boolean
  /** Move to the archive now. */
  readonly archive: boolean
}

/**
 * Half-life in days: longer for facts, important memories and recalled ones.
 * @param input - the memory.
 * @param config - decay tuning.
 */
export function halfLife(input: DecayInput, config: DecayConfig): number {
  const kindFactor = input.kind === 'fact' ? config.factFactor : 1
  return config.halfLifeDays * kindFactor * (1 + input.importance) * (1 + config.recallBonus * input.recalls)
}

/**
 * Decay a memory by a number of days.
 * @param input - the memory.
 * @param days - elapsed days (her clock).
 * @param config - decay tuning.
 */
export function decayStep(input: DecayInput, days: number, config: DecayConfig): DecayResult {
  if (input.kind === 'self' || days <= 0) return { strength: input.strength, gist: false, archive: false }
  const strength = input.strength * 0.5 ** (days / halfLife(input, config))
  return {
    strength,
    gist: !input.gisted && strength < config.gistBelow,
    archive: strength < config.archiveBelow,
  }
}

/**
 * A one-line gist: the first sentence or line, cut to `max` characters.
 * @param text - full text.
 * @param max - most characters.
 */
export function gistOf(text: string, max: number): string {
  const first = text.trim().split(/(?<=[.!?。！？])\s*|\n/u)[0] ?? ''
  const line = first.trim() === '' ? text.trim() : first.trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * Rough token estimate, good enough for budgets: one per CJK character, one
 * per four other characters.
 * @param text - text.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const char of text) if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk += 1
  return cjk + Math.ceil((text.length - cjk) / 4)
}
