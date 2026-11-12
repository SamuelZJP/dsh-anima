/**
 * Short ids for images, stickers and forwarded messages she may open later
 * (`#i3`, `#f2`; DESIGN §11, Phase 7). Each id belongs to one chat, so a look
 * in one chat can never open what was sent in another. The book is bounded
 * and kept in `<dataDir>/qq/media.json`, so ids in her history stay valid
 * across restarts.
 * @module @anima/adapter-qq/media
 */

import { readJson, writeJson } from '@anima/core'
import type { MediaKind } from './normalize.ts'

/** What an id points to. */
export interface MediaEntry {
  /** `i<n>` (image or sticker) or `f<n>` (forward). */
  readonly id: string
  /** Channel key of the chat it was sent in. */
  readonly chat: string
  readonly kind: MediaKind
  /** Image: the runtime's download URL. */
  readonly url?: string | undefined
  /** Image: the runtime's file name, for `get_image`. */
  readonly file?: string | undefined
  readonly summary?: string | undefined
  /** Forward: the id `get_forward_msg` takes. */
  readonly forwardId?: string | undefined
  /** Image: the attachment it was stored as, once she looked (the look cache). */
  ref?: Readonly<Record<string, unknown>> | undefined
}

interface MediaFile {
  seq: { i: number; f: number }
  entries: MediaEntry[]
}

function str(value: unknown): string | undefined {
  return value === undefined || value === null || String(value) === '' ? undefined : String(value)
}

/** Normalize a model-typed id: `#i3`, `i3` or `I3` → `i3`. */
export function normalizeMediaId(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase()
}

/** The id book. */
export class MediaBook {
  private readonly file: MediaFile
  /** Inline content of forwards, by id (not persisted: it can be large). */
  private readonly inline = new Map<string, readonly unknown[]>()

  /**
   * @param path - JSON file, or undefined to keep the book in memory only.
   * @param limit - entries kept; the oldest are forgotten first.
   */
  constructor(private readonly path: string | undefined, private readonly limit: number) {
    const saved = path === undefined ? undefined : readJson<MediaFile>(path)
    this.file = { seq: { i: saved?.seq?.i ?? 0, f: saved?.seq?.f ?? 0 }, entries: saved?.entries ?? [] }
  }

  /**
   * The id of a segment in a chat, reusing the id it already has there.
   * @returns the id, or undefined when the segment gives nothing to open.
   */
  idFor(chat: string, kind: MediaKind, data: Readonly<Record<string, unknown>>): string | undefined {
    const url = str(data.url)
    const file = str(data.file) ?? str(data.file_id)
    const forwardId = str(data.id)
    const content = Array.isArray(data.content) ? data.content as readonly unknown[] : undefined
    if (kind === 'forward' ? forwardId === undefined && content === undefined : url === undefined && file === undefined) return undefined
    const existing = this.file.entries.find(entry => entry.chat === chat && entry.kind === kind && (kind === 'forward'
      ? forwardId !== undefined && entry.forwardId === forwardId
      : (file !== undefined && entry.file === file) || (file === undefined && url !== undefined && entry.url === url)))
    if (existing !== undefined) {
      if (content !== undefined) this.inline.set(existing.id, content)
      return existing.id
    }
    const prefix = kind === 'forward' ? 'f' : 'i'
    this.file.seq[prefix] += 1
    const id = `${prefix}${this.file.seq[prefix]}`
    this.file.entries.push({
      id, chat, kind,
      ...url === undefined ? {} : { url },
      ...file === undefined ? {} : { file },
      ...str(data.summary) === undefined ? {} : { summary: str(data.summary) },
      ...forwardId === undefined ? {} : { forwardId },
    })
    if (content !== undefined) this.inline.set(id, content)
    while (this.file.entries.length > this.limit) this.inline.delete(this.file.entries.shift()!.id)
    this.save()
    return id
  }

  /**
   * The entry of an id, only when it belongs to this chat.
   * @param chat - channel key of the asking session.
   */
  get(chat: string, id: string): MediaEntry | undefined {
    const wanted = normalizeMediaId(id)
    return this.file.entries.find(entry => entry.id === wanted && entry.chat === chat)
  }

  /** Inline content of a forward, when the runtime sent it with the message. */
  content(id: string): readonly unknown[] | undefined {
    return this.inline.get(id)
  }

  /** Remember the attachment an image was stored as. */
  setRef(entry: MediaEntry, ref: Readonly<Record<string, unknown>>): void {
    entry.ref = ref
    this.save()
  }

  private save(): void {
    if (this.path !== undefined) writeJson(this.path, this.file)
  }
}

/** Image media types a model accepts, from the file signature. */
export function sniffImage(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined {
  const at = (offset: number, bytes: readonly number[]) => bytes.every((byte, index) => data[offset + index] === byte)
  const ascii = (offset: number, text: string) => at(offset, [...text].map(c => c.charCodeAt(0)))
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * Download at most `maxBytes` from an http(s) URL.
 * @throws Error on a bad status, a timeout, or a larger body.
 */
export async function fetchCapped(url: string, maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!/^https?:\/\//.test(url)) throw new Error('not an http(s) URL')
  const signals = [AbortSignal.timeout(timeoutMs), ...signal === undefined ? [] : [signal]]
  const response = await fetch(url, { signal: AbortSignal.any(signals) })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new Error(`the image is ${declared} bytes, more than the ${maxBytes} bytes allowed`)
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error(`the image is more than the ${maxBytes} bytes allowed`)
    chunks.push(chunk)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The `emoji_id` of `set_msg_emoji_like` for what she typed: a QQ face id
 * (1–3 digits), or one Unicode emoji as its decimal code point (NapCat reads
 * ids longer than 3 digits as Unicode emoji).
 * @returns the id, or undefined when it is neither.
 */
export function emojiId(input: string): string | undefined {
  const text = input.trim()
  if (/^\d{1,3}$/.test(text)) return text
  const points = [...text.replace(/[︎️]/g, '')]
  if (points.length !== 1) return undefined
  const code = points[0]!.codePointAt(0)!
  return code > 999 ? String(code) : undefined
}
