/**
 * Her self-model (DESIGN §9): short entries about her tastes, habits and
 * opinions that she edits with `self_note`. Every change is a diff in an
 * append-only log with time and reason; the owner reviews and reverts diffs.
 * @module @anima/core/selfmodel
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readJson, writeJson } from './ledger.ts'
import { AnimaError } from './types.ts'

/** Self-model sections. */
export const SELF_SECTIONS = ['tastes', 'habits', 'opinions', 'other'] as const

/** One self-model section. */
export type SelfSection = (typeof SELF_SECTIONS)[number]

/** One entry. */
export interface SelfEntry {
  /** `n<seq>`. */
  readonly id: string
  readonly section: SelfSection
  readonly text: string
  /** Her clock when it got this text. */
  readonly since: number
}

/** One change. */
export interface SelfDiff {
  /** `d<seq>`. */
  readonly id: string
  /** Her clock, ms. */
  readonly at: number
  /** Real clock, ms. */
  readonly real: number
  readonly by: 'her' | 'owner'
  readonly op: 'add' | 'change' | 'remove' | 'revert'
  readonly entryId: string
  readonly section: SelfSection
  /** Text before; absent for an add. */
  readonly before?: string
  /** Text after; absent for a remove. */
  readonly after?: string
  readonly reason: string
  readonly sessionId?: string
  /** For a revert: the diff it undid. */
  readonly revertOf?: string
}

interface ModelFile {
  nextEntry: number
  nextDiff: number
  entries: SelfEntry[]
}

/** Self-model settings, from config. Nothing here limits what she keeps or how often she changes it. */
export interface SelfModelOptions {
  /** Characters of the short digest in prompts. */
  readonly digestChars: number
}

/** Store of `<dataDir>/self-model.json` and its diff log `self-model-log.jsonl`. */
export class SelfModelStore {
  private file: ModelFile

  /**
   * @param path - `self-model.json`.
   * @param logPath - `self-model-log.jsonl`.
   * @param options - digest size.
   */
  constructor(private readonly path: string, private readonly logPath: string, private readonly options: SelfModelOptions) {
    this.file = readJson<ModelFile>(path) ?? { nextEntry: 1, nextDiff: 1, entries: [] }
  }

  /** Current entries, oldest first. */
  entries(): readonly SelfEntry[] {
    return this.file.entries
  }

  /** All diffs, oldest first. A torn last line is skipped. */
  diffs(): SelfDiff[] {
    if (!existsSync(this.logPath)) return []
    const diffs: SelfDiff[] = []
    for (const line of readFileSync(this.logPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        diffs.push(JSON.parse(line) as SelfDiff)
      } catch {
        // An interrupted write leaves a partial line; the entries file stays authoritative.
      }
    }
    return diffs
  }

  /**
   * Apply one change from her `self_note`.
   * @param input - section; text to add or change to; `replaces` an entry id; reason.
   * @returns the diff.
   * @throws {AnimaError} `anima/self-model-text` (no text to add), `anima/self-model-unknown` (no such note).
   */
  note(input: { section: SelfSection; text?: string | undefined; replaces?: string | undefined; reason: string; at: number; real: number; sessionId?: string | undefined }): SelfDiff {
    const text = input.text?.trim()
    if (input.replaces === undefined) {
      if (text === undefined || text === '') throw new AnimaError('anima/self-model-text', 'give the text of the new note, or `replaces` with an entry id to change or remove one.')
      const entry: SelfEntry = { id: `n${this.file.nextEntry++}`, section: input.section, text, since: input.at }
      this.file.entries.push(entry)
      return this.commit({ by: 'her', op: 'add', entryId: entry.id, section: entry.section, after: text, reason: input.reason, at: input.at, real: input.real, sessionId: input.sessionId })
    }
    const index = this.indexOf(input.replaces)
    const old = this.file.entries[index]!
    if (text === undefined || text === '') {
      this.file.entries.splice(index, 1)
      return this.commit({ by: 'her', op: 'remove', entryId: old.id, section: old.section, before: old.text, reason: input.reason, at: input.at, real: input.real, sessionId: input.sessionId })
    }
    this.file.entries[index] = { id: old.id, section: input.section, text, since: input.at }
    return this.commit({ by: 'her', op: 'change', entryId: old.id, section: input.section, before: old.text, after: text, reason: input.reason, at: input.at, real: input.real, sessionId: input.sessionId })
  }

  /**
   * Undo one diff (owner). Refuses when the entry changed since that diff.
   * @param diffId - `d<seq>`.
   * @param reason - why.
   * @throws {AnimaError} `anima/self-model-unknown`, `anima/self-model-conflict`.
   */
  revert(diffId: string, reason: string, at: number, real: number): SelfDiff {
    const diffs = this.diffs()
    const diff = diffs.find(d => d.id === diffId)
    if (diff === undefined) throw new AnimaError('anima/self-model-unknown', `no self-model change ${diffId}.`)
    const later = diffs.slice(diffs.indexOf(diff) + 1).find(d => d.entryId === diff.entryId)
    if (later !== undefined) throw new AnimaError('anima/self-model-conflict', `note ${diff.entryId} changed again in ${later.id}; revert ${later.id} first.`)
    const index = this.file.entries.findIndex(e => e.id === diff.entryId)
    const current = index < 0 ? undefined : this.file.entries[index]!
    if ((current?.text) !== diff.after) throw new AnimaError('anima/self-model-conflict', `note ${diff.entryId} is not as ${diffId} left it.`)
    const base = { by: 'owner' as const, op: 'revert' as const, entryId: diff.entryId, section: diff.section, reason, at, real, revertOf: diff.id }
    if (diff.before === undefined) {
      // Undo an add: remove the entry.
      this.file.entries.splice(index, 1)
      return this.commit({ ...base, before: diff.after! })
    }
    const restored: SelfEntry = { id: diff.entryId, section: diff.section, text: diff.before, since: at }
    if (current === undefined) this.file.entries.push(restored)
    else this.file.entries[index] = restored
    return this.commit(current === undefined ? { ...base, after: diff.before } : { ...base, before: current.text, after: diff.before })
  }

  private indexOf(id: string): number {
    const index = this.file.entries.findIndex(e => e.id === id.trim())
    if (index < 0) throw new AnimaError('anima/self-model-unknown', `no note ${id} in your self-model. Notes: ${this.file.entries.map(e => e.id).join(', ') || 'none yet'}.`)
    return index
  }

  private commit(fields: { [K in keyof Omit<SelfDiff, 'id'>]: Omit<SelfDiff, 'id'>[K] | undefined }): SelfDiff {
    const diff = { id: `d${this.file.nextDiff++}`, ...withoutUndefined(fields) } as SelfDiff
    writeJson(this.path, this.file)
    mkdirSync(dirname(this.logPath), { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify(diff)}\n`)
    return diff
  }

  /**
   * Prompt digest. Conversation sessions get a short one (newest notes first,
   * cut at `digestChars`); Self gets every note with its id, so it can change
   * or remove one.
   * @param full - Self's form.
   * @returns the text, or empty when she has no notes yet.
   */
  digest(full: boolean): string {
    const lines = ['# Your self-model', 'What you have learned about yourself.']
    if (this.file.entries.length === 0) {
      return full ? [...lines, '(No notes yet. Use `self_note` when you notice something lasting about your tastes, habits or opinions.)'].join('\n') : ''
    }
    let budget = this.options.digestChars
    for (const section of SELF_SECTIONS) {
      const entries = this.file.entries.filter(e => e.section === section).sort((a, b) => b.since - a.since)
      if (entries.length === 0) continue
      const kept: string[] = []
      for (const entry of entries) {
        const line = full ? `- [${entry.id}] ${entry.text}` : `- ${entry.text}`
        if (!full && line.length > budget) break
        budget -= line.length
        kept.push(line)
      }
      if (kept.length > 0) lines.push(`## ${section}`, ...kept)
    }
    return lines.join('\n')
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
