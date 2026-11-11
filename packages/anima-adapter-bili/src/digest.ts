/**
 * Pure helpers that turn Bilibili API data into compact text for her:
 * skim lines, the watch digest, danmaku and subtitle parsing, even sampling.
 * Code only cuts and orders; it never judges what is worth her time.
 * @module @anima/adapter-bili/digest
 */

/** One video in a skim list. */
export interface VideoItem {
  readonly bvid: string
  readonly title: string
  readonly author: string
  /** Seconds, when known. */
  readonly durationSeconds?: number | undefined
  readonly views?: number | undefined
  readonly likes?: number | undefined
  readonly danmaku?: number | undefined
  readonly description?: string | undefined
  /** Unix seconds. */
  readonly pubdate?: number | undefined
}

/** A timed line (subtitle or danmaku), seconds into the video. */
export interface TimedText {
  readonly from: number
  readonly to?: number
  readonly text: string
}

/** `m:ss` or `h:mm:ss`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

/** Parse `m:ss` / `h:mm:ss` (search results) into seconds. */
export function parseDuration(text: string | number | undefined): number | undefined {
  if (typeof text === 'number') return text
  if (text === undefined || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return undefined
  return text.trim().split(':').map(Number).reduce((acc, part) => acc * 60 + part, 0)
}

/** Counts the way Bilibili shows them: 1234, 1.2万, 3.4亿. */
export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

/** Decode the XML/HTML entities Bilibili uses. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** Strip tags (search titles carry `<em class="keyword">`) and decode entities. */
export function plain(text: string | undefined): string {
  return decodeEntities((text ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** Cut text to `max` characters on a character boundary, marking the cut. */
export function cap(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** One skim line: `BV… «title» — uploader · 3:12 · 1.2万 views, 300 likes, 80 danmaku — description`. */
export function videoLine(item: VideoItem, descriptionChars = 80): string {
  const facts = [
    item.durationSeconds === undefined ? undefined : formatDuration(item.durationSeconds),
    item.views === undefined ? undefined : `${formatCount(item.views)} views`,
    item.likes === undefined ? undefined : `${formatCount(item.likes)} likes`,
    item.danmaku === undefined ? undefined : `${formatCount(item.danmaku)} danmaku`,
  ].filter(Boolean).join(', ')
  const description = plain(item.description)
  return `${item.bvid} «${plain(item.title)}» — ${plain(item.author)}${facts === '' ? '' : ` · ${facts}`}${description === '' || description === '-' ? '' : ` — ${cap(description, descriptionChars)}`}`
}

/** Danmaku from `x/v1/dm/list.so` XML: `<d p="time,mode,…">text</d>`. */
export function parseDanmaku(xml: string): TimedText[] {
  const items: TimedText[] = []
  for (const match of xml.matchAll(/<d p="([^"]*)">([\s\S]*?)<\/d>/g)) {
    const from = Number((match[1] ?? '').split(',')[0])
    const text = decodeEntities(match[2] ?? '').trim()
    if (Number.isFinite(from) && text !== '') items.push({ from, text })
  }
  return items.sort((a, b) => a.from - b.from)
}

/** Subtitle lines from a subtitle JSON body (`{ body: [{ from, to, content }] }`). */
export function parseSubtitle(json: string): TimedText[] {
  try {
    const body = (JSON.parse(json) as { body?: { from?: number; to?: number; content?: string }[] }).body ?? []
    return body.filter(line => typeof line.from === 'number' && typeof line.content === 'string' && line.content.trim() !== '')
      .map(line => ({ from: line.from!, to: line.to ?? line.from!, text: line.content!.trim() }))
  } catch {
    return []
  }
}

/** `n` items spread evenly over a list (first and last included). */
export function sampleEvenly<T>(items: readonly T[], n: number): T[] {
  if (n <= 0) return []
  if (items.length <= n) return [...items]
  if (n === 1) return [items[0]!]
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]!)
}

/** Subtitle text around a moment (the line showing then, else the nearest within 5 s). */
export function subtitleAt(lines: readonly TimedText[], t: number): string | undefined {
  const showing = lines.find(line => line.from <= t && t <= (line.to ?? line.from))
  if (showing !== undefined) return showing.text
  let best: TimedText | undefined
  for (const line of lines) {
    const distance = Math.min(Math.abs(line.from - t), Math.abs((line.to ?? line.from) - t))
    if (distance <= 5 && (best === undefined || distance < Math.abs(best.from - t))) best = line
  }
  return best?.text
}

/** Subtitles as running text with a timestamp every ~30 s, cut to `max` characters. */
export function subtitleText(lines: readonly TimedText[], max: number): string {
  const parts: string[] = []
  let lastStamp = -Infinity
  for (const line of lines) {
    if (line.from - lastStamp >= 30) {
      parts.push(`[${formatDuration(line.from)}] ${line.text}`)
      lastStamp = line.from
    } else {
      parts.push(line.text)
    }
  }
  return cap(parts.join(' '), max)
}

/** A comment in a digest. */
export interface CommentItem {
  readonly author: string
  readonly text: string
  readonly likes: number
  readonly replies?: number | undefined
}

/** One comment line. */
export function commentLine(comment: CommentItem, maxChars: number): string {
  return `- ${plain(comment.author)} (${formatCount(comment.likes)} likes${comment.replies ? `, ${comment.replies} replies` : ''}): ${cap(plain(comment.text), maxChars)}`
}

/** Inputs of a watch digest. */
export interface WatchInput {
  readonly item: VideoItem & { readonly category?: string | undefined; readonly coins?: number | undefined; readonly favorites?: number | undefined; readonly replies?: number | undefined; readonly parts?: number | undefined }
  readonly subtitles: readonly TimedText[]
  /** Where subtitles came from (`CC zh-CN`, `AI zh`), or why there are none. */
  readonly subtitleNote: string
  readonly danmaku: readonly TimedText[]
  readonly comments: readonly CommentItem[]
  readonly caps: { descriptionChars: number; subtitleChars: number; danmakuItems: number; commentItems: number; commentChars: number }
}

/** The tier-1 watch digest: metadata, subtitles, a danmaku sample, top comments. */
export function watchDigest(input: WatchInput): string {
  const { item, caps } = input
  const stats = [
    `${formatCount(item.views)} views`, `${formatCount(item.likes)} likes`,
    item.coins === undefined ? undefined : `${formatCount(item.coins)} coins`,
    item.favorites === undefined ? undefined : `${formatCount(item.favorites)} favorites`,
    `${formatCount(item.danmaku)} danmaku`,
    item.replies === undefined ? undefined : `${formatCount(item.replies)} comments`,
  ].filter(Boolean).join(', ')
  const sampled = sampleEvenly(input.danmaku, caps.danmakuItems)
  return [
    `# ${plain(item.title)} (${item.bvid})`,
    `By ${plain(item.author)}${item.category === undefined ? '' : ` · ${item.category}`}${item.durationSeconds === undefined ? '' : ` · ${formatDuration(item.durationSeconds)}`}${item.parts !== undefined && item.parts > 1 ? ` · ${item.parts} parts (this is part 1)` : ''}${item.pubdate === undefined ? '' : ` · published ${new Date(item.pubdate * 1000).toISOString().slice(0, 10)}`}`,
    stats,
    '',
    '## Description',
    cap(plain(item.description) || '(none)', caps.descriptionChars),
    '',
    `## Subtitles (${input.subtitleNote})`,
    input.subtitles.length === 0 ? '(none)' : subtitleText(input.subtitles, caps.subtitleChars),
    '',
    `## Danmaku (${sampled.length} of ${input.danmaku.length}, spread over the video)`,
    ...sampled.length === 0 ? ['(none)'] : sampled.map(d => `[${formatDuration(d.from)}] ${cap(d.text, 60)}`),
    '',
    `## Top comments`,
    ...input.comments.length === 0 ? ['(none)'] : input.comments.slice(0, caps.commentItems).map(c => commentLine(c, caps.commentChars)),
  ].join('\n')
}
