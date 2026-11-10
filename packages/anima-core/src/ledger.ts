/**
 * Daily budgets kept per her day (wake to wake): initiated conversations,
 * tokens per mode, night wake-ups. Plus the small JSON file helpers Anima's
 * stores share.
 * @module @anima/core/ledger
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Mode } from './rhythm.ts'
import { AnimaError } from './types.ts'

/** Counters of one day. */
export interface DayLedger {
  initiates: number
  tokens: Record<Mode, number>
  nightWakes: number
}

/** Fresh counters. */
export function emptyDay(): DayLedger {
  return { initiates: 0, tokens: { day: 0, night: 0 }, nightWakes: 0 }
}

/**
 * Tokens counted against the budget: everything that is not a cache hit.
 * DSH's DeepSeek adapter reports `inputTokens` without cache reads.
 * @param usage - one model call's usage.
 */
export function billableTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheWriteTokens ?? 0)
}

/** Day ledgers keyed by day; keeps the last few days only. */
export class Ledger {
  constructor(private readonly days: Record<string, DayLedger> = {}, private readonly keep = 7) {}

  /** Counters of a day (created on first use). */
  day(key: string): DayLedger {
    let entry = this.days[key]
    if (entry === undefined) {
      entry = emptyDay()
      this.days[key] = entry
      const keys = Object.keys(this.days).sort()
      for (const old of keys.slice(0, Math.max(0, keys.length - this.keep))) delete this.days[old]
    }
    return entry
  }

  /** Read-only view of a day without creating it. */
  peek(key: string): DayLedger {
    return this.days[key] ?? emptyDay()
  }

  /** Serializable form. */
  toJSON(): Record<string, DayLedger> {
    return this.days
  }
}

/**
 * Read a JSON file, or undefined when it does not exist. A corrupt file fails loud.
 * @param path - file path.
 */
export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error: unknown) {
    throw new AnimaError('anima/state-corrupt', `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or delete it.`)
  }
}

/**
 * Write a JSON file atomically (temp file and rename).
 * @param path - file path.
 * @param value - JSON value.
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}
