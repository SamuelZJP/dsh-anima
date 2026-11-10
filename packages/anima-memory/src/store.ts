/**
 * The memory store (DESIGN §8 Storage): one SQLite file under the Anima data
 * directory, on Node's built-in `node:sqlite`. It holds her own transcript of
 * channel messages and speech, the memories with their scopes, and an FTS5
 * trigram index for recall.
 * @module @anima/memory/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { EVERYONE, type Audience, type Scope } from './audience.ts'
import type { DecayConfig } from './config.ts'
import { decayStep, estimateTokens, gistOf, type MemoryKind } from './decay.ts'

/** Memory status. Only `active` memories are recalled by default or injected. */
export type MemoryStatus = 'active' | 'archived' | 'superseded'

/** One stored memory. */
export interface Memory {
  /** Id shown to her, `m<n>`. */
  readonly id: string
  readonly kind: MemoryKind
  readonly scope: Scope
  /** The person it is about, if any. */
  readonly personId: string | undefined
  /** Channel it was learned in, if any. */
  readonly channelKey: string | undefined
  /** Current text (a gist once decayed). */
  readonly text: string
  readonly importance: number
  readonly strength: number
  readonly recalls: number
  readonly createdAt: number
  readonly status: MemoryStatus
  /** Id of the memory that replaced this one. */
  readonly replacedBy: string | undefined
}

/** A new memory. */
export interface NewMemory {
  readonly kind: MemoryKind
  readonly scope: Scope
  readonly text: string
  readonly personId?: string | undefined
  readonly channelKey?: string | undefined
  readonly importance?: number | undefined
  /** Session it came from. */
  readonly source?: string | undefined
  readonly now: number
}

/** One transcript line. */
export interface TranscriptLine {
  readonly id: number
  readonly ts: number
  readonly sessionId: string
  readonly channelKey: string | undefined
  readonly scope: Scope
  readonly dir: 'in' | 'out'
  readonly speaker: string
  /** Person id of the speaker (`in` lines). */
  readonly speakerId?: string | undefined
  readonly text: string
}

/** Unconsolidated transcript lines of one session, in order. */
export interface Segment {
  readonly sessionId: string
  readonly channelKey: string | undefined
  readonly scope: Scope
  readonly lines: readonly TranscriptLine[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  channel_key TEXT,
  scope TEXT NOT NULL,
  dir TEXT NOT NULL,
  speaker TEXT NOT NULL,
  speaker_id TEXT,
  text TEXT NOT NULL,
  run TEXT,
  consolidated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS transcript_pending ON transcript (consolidated, run, id);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  person_id TEXT,
  channel_key TEXT,
  text TEXT NOT NULL,
  full TEXT,
  importance REAL NOT NULL DEFAULT 0,
  strength REAL NOT NULL DEFAULT 1,
  recalls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  replaced_by INTEGER,
  source TEXT
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories (status, scope);
CREATE INDEX IF NOT EXISTS memories_person ON memories (person_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface MemoryRow {
  id: number
  kind: string
  scope: string
  person_id: string | null
  channel_key: string | null
  text: string
  importance: number
  strength: number
  recalls: number
  created_at: number
  status: string
  replaced_by: number | null
}

interface LineRow {
  id: number
  ts: number
  session_id: string
  channel_key: string | null
  scope: string
  dir: string
  speaker: string
  speaker_id: string | null
  text: string
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: `m${row.id}`,
    kind: row.kind as MemoryKind,
    scope: row.scope,
    personId: row.person_id ?? undefined,
    channelKey: row.channel_key ?? undefined,
    text: row.text,
    importance: row.importance,
    strength: row.strength,
    recalls: row.recalls,
    createdAt: row.created_at,
    status: row.status as MemoryStatus,
    replacedBy: row.replaced_by === null ? undefined : `m${row.replaced_by}`,
  }
}

function toLine(row: LineRow): TranscriptLine {
  return {
    id: row.id, ts: row.ts, sessionId: row.session_id, channelKey: row.channel_key ?? undefined,
    scope: row.scope, dir: row.dir as 'in' | 'out', speaker: row.speaker, speakerId: row.speaker_id ?? undefined, text: row.text,
  }
}

/**
 * Numeric row id of a memory id (`m12` or `12`).
 * @returns the id, or undefined when it is not one.
 */
export function rowId(id: string): number | undefined {
  const match = /^m?(\d+)$/.exec(id.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * Search terms of a query: words and CJK runs, lowercased, deduplicated.
 * Single characters and two-letter ASCII words carry too little to search by.
 * @param query - free text.
 */
export function searchTerms(query: string): string[] {
  const parts = query.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean)
  const terms = parts.filter(part => [...part].length >= 3 || (/[^\x00-\x7f]/.test(part) && [...part].length >= 2))
  return [...new Set(terms)].slice(0, 16)
}

/** SQL filter of an audience. */
function audienceFilter(audience: Audience): { sql: string; params: SQLInputValue[] } {
  if (audience === EVERYONE) return { sql: '1', params: [] }
  if (audience.length === 0) return { sql: '0', params: [] }
  return { sql: `scope IN (${audience.map(() => '?').join(', ')})`, params: [...audience] }
}

/** The SQLite memory store. */
export class MemoryStore {
  private readonly db: DatabaseSync

  /**
   * Open (and create) the store.
   * @param path - database file, or `:memory:`.
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  /** Close the database. */
  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  // ---- meta ----

  /** A meta value. */
  meta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /** Set a meta value. */
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---- transcript ----

  /** Append one transcript line. */
  record(line: Omit<TranscriptLine, 'id'>): number {
    const result = this.db.prepare('INSERT INTO transcript (ts, session_id, channel_key, scope, dir, speaker, speaker_id, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(line.ts, line.sessionId, line.channelKey ?? null, line.scope, line.dir, line.speaker, line.speakerId ?? null, line.text)
    return Number(result.lastInsertRowid)
  }

  /** Lines not yet consolidated and not claimed by a run. */
  pendingCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM transcript WHERE consolidated = 0 AND run IS NULL').get() as { n: number }).n
  }

  /** Time of the oldest pending line, or undefined. */
  oldestPending(): number | undefined {
    const row = this.db.prepare('SELECT min(ts) AS ts FROM transcript WHERE consolidated = 0 AND run IS NULL').get() as { ts: number | null }
    return row.ts ?? undefined
  }

  /**
   * Claim pending lines for a consolidation run, oldest first, up to a token
   * budget, grouped into one segment per session.
   * @param run - run id.
   * @param maxTokens - token budget of the lines.
   * @returns the segments (empty when nothing is pending).
   */
  claim(run: string, maxTokens: number): Segment[] {
    const rows = this.db.prepare('SELECT id, ts, session_id, channel_key, scope, dir, speaker, speaker_id, text FROM transcript WHERE consolidated = 0 AND run IS NULL ORDER BY id').all() as unknown as LineRow[]
    const taken: TranscriptLine[] = []
    let tokens = 0
    for (const row of rows) {
      const cost = estimateTokens(row.text) + 8
      if (taken.length > 0 && tokens + cost > maxTokens) break
      tokens += cost
      taken.push(toLine(row))
    }
    if (taken.length === 0) return []
    const mark = this.db.prepare('UPDATE transcript SET run = ? WHERE id = ?')
    for (const line of taken) mark.run(run, line.id)
    const segments = new Map<string, { sessionId: string; channelKey: string | undefined; scope: Scope; lines: TranscriptLine[] }>()
    for (const line of taken) {
      const key = `${line.sessionId}\0${line.scope}`
      const segment = segments.get(key) ?? { sessionId: line.sessionId, channelKey: line.channelKey, scope: line.scope, lines: [] }
      segment.lines.push(line)
      segments.set(key, segment)
    }
    return [...segments.values()]
  }

  /** Mark a run's lines consolidated. */
  finishRun(run: string): number {
    return Number(this.db.prepare('UPDATE transcript SET consolidated = 1 WHERE run = ? AND consolidated = 0').run(run).changes)
  }

  /** Release a run's unconsolidated lines so a later run takes them again. */
  releaseRun(run: string): void {
    this.db.prepare('UPDATE transcript SET run = NULL WHERE run = ? AND consolidated = 0').run(run)
  }

  /** Release every claimed but unfinished line (after a restart). */
  releaseAll(): void {
    this.db.prepare('UPDATE transcript SET run = NULL WHERE consolidated = 0 AND run IS NOT NULL').run()
  }

  // ---- memories ----

  /** Store a memory. */
  remember(input: NewMemory): Memory {
    const importance = Math.min(1, Math.max(0, input.importance ?? 0.3))
    const result = this.db.prepare(`INSERT INTO memories (kind, scope, person_id, channel_key, text, importance, strength, created_at, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(input.kind, input.scope, input.personId ?? null, input.channelKey ?? null, input.text.trim(), importance, input.now, input.now, input.source ?? null)
    return this.get(`m${Number(result.lastInsertRowid)}`)!
  }

  /** One memory by id, any status. */
  get(id: string): Memory | undefined {
    const n = rowId(id)
    if (n === undefined) return undefined
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(n) as MemoryRow | undefined
    return row === undefined ? undefined : toMemory(row)
  }

  /** Mark `oldId` superseded by `newId`; the old one stays as history. */
  supersede(oldId: string, newId: string, now: number): void {
    this.db.prepare('UPDATE memories SET status = ?, replaced_by = ?, updated_at = ? WHERE id = ?').run('superseded', rowId(newId)!, now, rowId(oldId)!)
  }

  /** Hard-delete a memory. @returns whether it existed. */
  forget(id: string): boolean {
    const n = rowId(id)
    if (n === undefined) return false
    this.db.prepare('UPDATE memories SET replaced_by = NULL WHERE replaced_by = ?').run(n)
    return Number(this.db.prepare('DELETE FROM memories WHERE id = ?').run(n).changes) > 0
  }

  /**
   * Full-text recall within an audience. Terms of 3+ characters use the FTS5
   * trigram index (bm25); shorter CJK terms fall back to LIKE.
   * @param query - free text.
   * @param audience - scopes that may be heard.
   * @param options.archive - also search the archive.
   * @param options.limit - most results.
   */
  recall(query: string, audience: Audience, options: { archive?: boolean; limit?: number } = {}): Memory[] {
    const terms = searchTerms(query)
    if (terms.length === 0) return []
    const scores = new Map<number, number>()
    const long = terms.filter(term => [...term].length >= 3)
    const short = terms.filter(term => [...term].length < 3)
    if (long.length > 0) {
      const match = long.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
      const rows = this.db.prepare('SELECT rowid AS id, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 200').all(match) as { id: number; rank: number }[]
      for (const row of rows) scores.set(row.id, (scores.get(row.id) ?? 0) + 1 - row.rank)
    }
    for (const term of short) {
      const rows = this.db.prepare("SELECT id FROM memories WHERE text LIKE ? ESCAPE '\\' LIMIT 200").all(`%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`) as { id: number }[]
      for (const row of rows) scores.set(row.id, (scores.get(row.id) ?? 0) + 1)
    }
    if (scores.size === 0) return []
    const filter = audienceFilter(audience)
    const statuses = options.archive === true ? ['active', 'archived'] : ['active']
    const ids = [...scores.keys()]
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(', ')}) AND status IN (${statuses.map(() => '?').join(', ')}) AND ${filter.sql}`)
      .all(...ids, ...statuses, ...filter.params) as unknown as MemoryRow[]
    return rows
      .sort((a, b) => (scores.get(b.id)! - scores.get(a.id)!) || (b.strength - a.strength))
      .slice(0, options.limit ?? 8)
      .map(toMemory)
  }

  /** Strongest active facts about a person, within an audience. */
  about(personId: string, audience: Audience, limit: number): Memory[] {
    const filter = audienceFilter(audience)
    return (this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND person_id = ? AND kind = 'fact' AND ${filter.sql} ORDER BY strength DESC, id DESC LIMIT ?`)
      .all(personId, ...filter.params, limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Most recent active episodes of a channel, within an audience. */
  recentEpisodes(channelKey: string, audience: Audience, limit: number): Memory[] {
    const filter = audienceFilter(audience)
    return (this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND channel_key = ? AND kind = 'episode' AND ${filter.sql} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(channelKey, ...filter.params, limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Active memories of one scope (for consolidation context). */
  inScope(scope: Scope, limit: number): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE status = 'active' AND scope = ? ORDER BY strength DESC, id DESC LIMIT ?")
      .all(scope, limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Count a recall: refresh strength and bump the recall count. */
  touch(ids: readonly string[], now: number): void {
    const bump = this.db.prepare('UPDATE memories SET recalls = recalls + 1, last_recalled_at = ?, strength = min(1, strength + 0.3) WHERE id = ?')
    for (const id of ids) bump.run(now, rowId(id)!)
  }

  /** Every memory, newest first, optionally filtered by a substring (owner listing). */
  list(options: { query?: string; limit?: number } = {}): Memory[] {
    const limit = options.limit ?? 50
    const rows = options.query === undefined || options.query === ''
      ? this.db.prepare('SELECT * FROM memories ORDER BY id DESC LIMIT ?').all(limit)
      : this.db.prepare("SELECT * FROM memories WHERE text LIKE ? OR scope LIKE ? OR person_id LIKE ? ORDER BY id DESC LIMIT ?").all(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`, limit)
    return (rows as unknown as MemoryRow[]).map(toMemory)
  }

  /** Counts by status, for status lines. */
  counts(): Record<MemoryStatus, number> {
    const result: Record<MemoryStatus, number> = { active: 0, archived: 0, superseded: 0 }
    for (const row of this.db.prepare('SELECT status, count(*) AS n FROM memories GROUP BY status').all() as { status: MemoryStatus; n: number }[]) result[row.status] = row.n
    return result
  }

  /**
   * Apply daily decay to every active memory.
   * @param days - elapsed days.
   * @param config - decay tuning.
   * @returns how many were gisted and archived.
   */
  decay(days: number, config: DecayConfig, now: number): { gisted: number; archived: number } {
    const rows = this.db.prepare("SELECT id, kind, text, full, importance, strength, recalls FROM memories WHERE status = 'active'").all() as {
      id: number; kind: MemoryKind; text: string; full: string | null; importance: number; strength: number; recalls: number
    }[]
    let gisted = 0
    let archived = 0
    const setStrength = this.db.prepare('UPDATE memories SET strength = ? WHERE id = ?')
    const setGist = this.db.prepare('UPDATE memories SET full = text, text = ?, updated_at = ? WHERE id = ?')
    const archive = this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?")
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        const result = decayStep({ kind: row.kind, strength: row.strength, importance: row.importance, recalls: row.recalls, gisted: row.full !== null }, days, config)
        setStrength.run(result.strength, row.id)
        if (result.gist) {
          setGist.run(gistOf(row.text, config.gistChars), now, row.id)
          gisted += 1
        }
        if (result.archive) {
          archive.run(now, row.id)
          archived += 1
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { gisted, archived }
  }
}
