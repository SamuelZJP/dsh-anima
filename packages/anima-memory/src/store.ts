/**
 * The memory store (docs/design/memory.md, Storage): one SQLite file under the
 * Anima data directory, on Node's built-in `node:sqlite`. It holds her
 * memories with their sources, an FTS5 trigram index for recall, what came to
 * mind in each waking, and how far each ended waking is consolidated.
 * @module @anima/memory/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { AnimaError } from '@anima/core'
import type { DecayConfig } from './config.ts'
import { decayStep, gistOf, type MemoryKind } from './decay.ts'

/** Memory status. Only `active` memories come to mind or are recalled by default. */
export type MemoryStatus = 'active' | 'archived' | 'superseded'

/** One stored memory. */
export interface Memory {
  /** Id shown to her, `m<n>`. */
  readonly id: string
  readonly kind: MemoryKind
  /** Current text (a gist once decayed). */
  readonly text: string
  /** Source: the channel it came from, if any. */
  readonly channelKey: string | undefined
  /** Source: the person it came from, if any. */
  readonly fromPerson: string | undefined
  /** Source: that person's name when it was kept. */
  readonly fromName: string | undefined
  /** The person it is about, if any. */
  readonly personId: string | undefined
  readonly importance: number
  readonly strength: number
  readonly recalls: number
  readonly createdAt: number
  readonly status: MemoryStatus
  /** Id of the memory that replaced this one. */
  readonly replacedBy: string | undefined
  /** The waking session it came from, if any. */
  readonly waking: string | undefined
}

/** A new memory. */
export interface NewMemory {
  readonly kind: MemoryKind
  readonly text: string
  readonly channelKey?: string | undefined
  readonly fromPerson?: string | undefined
  readonly fromName?: string | undefined
  readonly personId?: string | undefined
  readonly importance?: number | undefined
  readonly waking?: string | undefined
  readonly now: number
}

/** An ended waking and how far its log is consolidated. */
export interface WakingProgress {
  readonly sessionId: string
  /** Last log seq consolidated, -1 for none. */
  readonly upto: number
  readonly archivedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  full TEXT,
  source_channel TEXT,
  source_person TEXT,
  source_name TEXT,
  about_person TEXT,
  importance REAL NOT NULL DEFAULT 0,
  strength REAL NOT NULL DEFAULT 1,
  recalls INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  replaced_by INTEGER,
  source_session TEXT
);
CREATE INDEX IF NOT EXISTS memories_status ON memories (status, kind);
CREATE INDEX IF NOT EXISTS memories_about ON memories (about_person);
CREATE INDEX IF NOT EXISTS memories_channel ON memories (source_channel);
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
CREATE TABLE IF NOT EXISTS shown (session_id TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (session_id, item));
CREATE TABLE IF NOT EXISTS wakings (session_id TEXT PRIMARY KEY, archived_at INTEGER NOT NULL, upto INTEGER NOT NULL DEFAULT -1, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

interface MemoryRow {
  id: number
  kind: string
  text: string
  source_channel: string | null
  source_person: string | null
  source_name: string | null
  about_person: string | null
  importance: number
  strength: number
  recalls: number
  created_at: number
  status: string
  replaced_by: number | null
  source_session: string | null
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: `m${row.id}`,
    kind: row.kind as MemoryKind,
    text: row.text,
    channelKey: row.source_channel ?? undefined,
    fromPerson: row.source_person ?? undefined,
    fromName: row.source_name ?? undefined,
    personId: row.about_person ?? undefined,
    importance: row.importance,
    strength: row.strength,
    recalls: row.recalls,
    createdAt: row.created_at,
    status: row.status as MemoryStatus,
    replacedBy: row.replaced_by === null ? undefined : `m${row.replaced_by}`,
    waking: row.source_session ?? undefined,
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

const like = (text: string) => `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`

/** The SQLite memory store. */
export class MemoryStore {
  private readonly db: DatabaseSync

  /**
   * Open (and create) the store. A store of the first design (audience
   * scopes, her own transcript) fails loud: R5 starts with an empty memory.
   * @param path - database file, or `:memory:`.
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    const old = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript'").get() !== undefined
      || (this.db.prepare("SELECT name FROM pragma_table_info('memories') WHERE name = 'scope'").get() !== undefined)
    if (old) {
      this.db.close()
      throw new AnimaError('anima/memory-old-store', `${path} is a memory store of the first design (audience scopes and a transcript). Memory starts empty from R5: give anima-core a fresh dataDir; the old one is left as it is.`)
    }
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

  // ---- memories ----

  /** Store a memory. */
  remember(input: NewMemory): Memory {
    const importance = Math.min(1, Math.max(0, input.importance ?? 0.3))
    const result = this.db.prepare(`INSERT INTO memories (kind, text, source_channel, source_person, source_name, about_person, importance, strength, created_at, updated_at, source_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(input.kind, input.text.trim(), input.channelKey ?? null, input.fromPerson ?? null, input.fromName ?? null, input.personId ?? null, importance, input.now, input.now, input.waking ?? null)
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

  /** Hard-delete a memory: the owner's, from outside, never hers. @returns whether it existed. */
  forget(id: string): boolean {
    const n = rowId(id)
    if (n === undefined) return false
    this.db.prepare('UPDATE memories SET replaced_by = NULL WHERE replaced_by = ?').run(n)
    this.db.prepare('DELETE FROM shown WHERE item = ?').run(`m${n}`)
    return Number(this.db.prepare('DELETE FROM memories WHERE id = ?').run(n).changes) > 0
  }

  /**
   * Full-text recall over every memory, wherever it came from. Terms of 3+
   * characters use the FTS5 trigram index (bm25); shorter CJK terms fall back to LIKE.
   * @param query - free text.
   * @param options.archive - also search the archive.
   * @param options.limit - most results.
   */
  recall(query: string, options: { archive?: boolean; limit?: number } = {}): Memory[] {
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
      const rows = this.db.prepare("SELECT id FROM memories WHERE text LIKE ? ESCAPE '\\' LIMIT 200").all(like(term)) as { id: number }[]
      for (const row of rows) scores.set(row.id, (scores.get(row.id) ?? 0) + 1)
    }
    if (scores.size === 0) return []
    const statuses = options.archive === true ? ['active', 'archived'] : ['active']
    const ids = [...scores.keys()]
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(', ')}) AND status IN (${statuses.map(() => '?').join(', ')})`)
      .all(...ids, ...statuses) as unknown as MemoryRow[]
    return rows
      .sort((a, b) => (scores.get(b.id)! - scores.get(a.id)!) || (b.strength - a.strength))
      .slice(0, options.limit ?? 8)
      .map(toMemory)
  }

  /** Strongest active facts about a person. */
  about(personId: string, limit: number): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE status = 'active' AND about_person = ? AND kind = 'fact' ORDER BY strength DESC, id DESC LIMIT ?")
      .all(personId, limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Most recent active episodes of a channel. */
  recentEpisodes(channelKey: string, limit: number): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE status = 'active' AND source_channel = ? AND kind = 'episode' ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(channelKey, limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Most recent active episodes from anywhere. */
  latestEpisodes(limit: number): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE status = 'active' AND kind = 'episode' ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as MemoryRow[]).map(toMemory)
  }

  /** Count a recall: refresh strength and bump the recall count. */
  touch(ids: readonly string[], now: number): void {
    const bump = this.db.prepare('UPDATE memories SET recalls = recalls + 1, last_recalled_at = ?, strength = min(1, strength + 0.3) WHERE id = ?')
    for (const id of ids) bump.run(now, rowId(id)!)
  }

  // ---- what came to mind in a waking ----

  /** Which of these items (`m12`, `c:<channel key>`, `waking`) were already shown in a waking session. */
  shownIn(sessionId: string, items: readonly string[]): Set<string> {
    if (items.length === 0) return new Set()
    const rows = this.db.prepare(`SELECT item FROM shown WHERE session_id = ? AND item IN (${items.map(() => '?').join(', ')})`).all(sessionId, ...items) as { item: string }[]
    return new Set(rows.map(row => row.item))
  }

  /** Every item shown in a waking session. */
  shownAll(sessionId: string): Set<string> {
    return new Set((this.db.prepare('SELECT item FROM shown WHERE session_id = ?').all(sessionId) as { item: string }[]).map(row => row.item))
  }

  /** Mark items shown in a waking session. */
  markShown(sessionId: string, items: readonly string[]): void {
    const mark = this.db.prepare('INSERT OR IGNORE INTO shown (session_id, item) VALUES (?, ?)')
    for (const item of items) mark.run(sessionId, item)
  }

  // ---- consolidation progress ----

  /** An ended waking was archived: its log waits for consolidation. */
  addWaking(sessionId: string, archivedAt: number): void {
    this.db.prepare('INSERT OR IGNORE INTO wakings (session_id, archived_at) VALUES (?, ?)').run(sessionId, archivedAt)
  }

  /** Whether a waking is known to consolidation (done or not). */
  hasWaking(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM wakings WHERE session_id = ?').get(sessionId) !== undefined
  }

  /** Ended wakings not yet fully consolidated, oldest first. */
  pendingWakings(): WakingProgress[] {
    return (this.db.prepare('SELECT session_id, upto, archived_at FROM wakings WHERE done = 0 ORDER BY archived_at, session_id').all() as { session_id: string; upto: number; archived_at: number }[])
      .map(row => ({ sessionId: row.session_id, upto: row.upto, archivedAt: row.archived_at }))
  }

  /** A piece is consolidated: everything up to this log seq. */
  advanceWaking(sessionId: string, upto: number): void {
    this.db.prepare('UPDATE wakings SET upto = max(upto, ?) WHERE session_id = ?').run(upto, sessionId)
  }

  /** A waking is fully consolidated. */
  finishWaking(sessionId: string): void {
    this.db.prepare('UPDATE wakings SET done = 1 WHERE session_id = ?').run(sessionId)
  }

  // ---- the owner's view (outside) ----

  /**
   * Owner browsing (the Anima page): filter by text, source and status, newest first.
   * @param options.query - substring of the text, source or person.
   * @param options.source - a channel key, `self` (no channel), or a prefix ending in `:` (e.g. `qq:`).
   * @param options.status - one status, or `all`.
   * @returns one page and the total that match.
   */
  browse(options: { query?: string | undefined; source?: string | undefined; status?: MemoryStatus | 'all' | undefined; limit?: number; offset?: number } = {}): { memories: Memory[]; total: number } {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (options.query !== undefined && options.query !== '') {
      where.push("(text LIKE ? ESCAPE '\\' OR source_channel LIKE ? ESCAPE '\\' OR source_person LIKE ? ESCAPE '\\' OR source_name LIKE ? ESCAPE '\\' OR about_person LIKE ? ESCAPE '\\')")
      const pattern = like(options.query)
      params.push(pattern, pattern, pattern, pattern, pattern)
    }
    if (options.source !== undefined && options.source !== '') {
      if (options.source === 'self') {
        where.push('source_channel IS NULL')
      } else if (options.source.endsWith(':')) {
        where.push('substr(source_channel, 1, ?) = ?')
        params.push(options.source.length, options.source)
      } else {
        where.push('source_channel = ?')
        params.push(options.source)
      }
    }
    const status = options.status ?? 'active'
    if (status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    const sql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM memories ${sql}`).get(...params) as { n: number }).n)
    const rows = this.db.prepare(`SELECT * FROM memories ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, options.limit ?? 50, options.offset ?? 0) as unknown as MemoryRow[]
    return { memories: rows.map(toMemory), total }
  }

  /** Every memory, newest first, optionally filtered by a substring (owner listing). */
  list(options: { query?: string; limit?: number } = {}): Memory[] {
    return this.browse({ query: options.query, status: 'all', limit: options.limit ?? 50 }).memories
  }

  /** Distinct sources (a channel key, or `self`) with their memory counts. */
  sources(): { source: string; count: number }[] {
    return (this.db.prepare("SELECT coalesce(source_channel, 'self') AS source, count(*) AS count FROM memories GROUP BY source ORDER BY count DESC").all() as { source: string; count: number }[])
  }

  /** Counts by status, for status lines. */
  counts(): Record<MemoryStatus, number> {
    const result: Record<MemoryStatus, number> = { active: 0, archived: 0, superseded: 0 }
    for (const row of this.db.prepare('SELECT status, count(*) AS n FROM memories GROUP BY status').all() as { status: MemoryStatus; n: number }[]) result[row.status] = row.n
    return result
  }

  // ---- forgetting ----

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
