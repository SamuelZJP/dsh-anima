/**
 * Pure formatting helpers for the Anima page (unit-tested in Node).
 * @module @anima/page/client/format
 */
import { t } from './i18n.ts'

/** Local `YYYY-MM-DD HH:mm` of an epoch ms (the page's own clock). */
export function stamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local `HH:mm:ss` of an epoch ms. */
export function clockTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return new Date(ms).toTimeString().slice(0, 8)
}

/** `0.42` → `42%`. */
export function percent(value: number, digits = 0): string {
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(digits)}%`
}

/** `12345` → `12,345`. */
export function count(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** Share of a budget used, clamped to 0–1; 0 when the budget is 0. */
export function share(used: number, budget: number): number {
  return budget <= 0 ? 0 : Math.max(0, Math.min(1, used / budget))
}

/** `ok` / `warn` / `down` / `off` → a status class. */
export function healthClass(health: string): 'ok' | 'warn' | 'bad' | 'off' {
  return health === 'ok' ? 'ok' : health === 'warn' ? 'warn' : health === 'down' ? 'bad' : 'off'
}

/** Sorted `[key, value]` pairs of a count map, largest first. */
export function rankedCounts(counts: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Pretty JSON for the Settings editor. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2)
}

/**
 * Parse the Settings editor text.
 * @returns the object, or an error message.
 */
export function parseConfigText(text: string): { value: Record<string, unknown> } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    return { error: t('format.notJson', { error: error instanceof Error ? error.message : String(error) }) }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: t('format.notObject') }
  return { value: value as Record<string, unknown> }
}
