/**
 * Reading an ended waking (docs/design/memory.md, Consolidation in sleep): its
 * archived DSH session log, rendered as what entered her context (arrivals,
 * her thoughts, what she said, what she looked at and read) and cut into
 * pieces for sleep's consolidation turns. What came to mind (`[memory]`) is
 * left out: it is memory already. Group lines she never looked at are not in
 * the log, so they are not here either. Pure.
 * @module @anima/memory/log
 */

import type { LogEvent, SourcePerson } from '@anima/life'
import { estimateTokens } from './decay.ts'

/** One rendered line of an ended waking. */
export interface LogLine {
  /** Log seq of the event it came from. */
  readonly seq: number
  readonly text: string
  /** Channel keys named by the line (its source, a say's channel). */
  readonly channels: readonly string[]
  /** People who wrote in it (from the arrival's source). */
  readonly people: readonly SourcePerson[]
}

/** A piece of an ended waking: one consolidation turn. */
export interface Piece {
  /** First and last log seq in it. */
  readonly from: number
  readonly to: number
  readonly lines: readonly LogLine[]
}

/** Options of {@link renderLog}. */
export interface RenderOptions {
  /** Most characters of one tool result, heartbeat or thought. */
  readonly resultChars: number
}

interface Block { type: string; text?: string; name?: string; arguments?: string; id?: string }
interface Message { content?: readonly Block[]; source?: { kind?: string; stimulus?: string; channel?: string; people?: SourcePerson[] }; toolCallId?: string; isError?: boolean }

const CHANNEL_KEY = /\b[a-z][a-z0-9_-]*:[^\s:[\]]+:(?:private|group):[^\s[\]()（）,，、「」。：:]+/gu

function cut(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function textOf(blocks: readonly Block[] | undefined): string {
  return (blocks ?? []).map(block => block.type === 'text' ? block.text ?? '' : block.type === 'image' ? '[图片]' : '').filter(part => part !== '').join('\n')
}

/** Channel keys that appear in a text. */
export function channelsIn(text: string): string[] {
  return [...new Set(text.match(CHANNEL_KEY) ?? [])]
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}')
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** One tool call as a line of her life. */
function callLine(name: string, args: Record<string, unknown>, max: number): { text: string; channels: string[] } {
  const channel = typeof args.channel === 'string' ? args.channel.trim() : undefined
  if (name.endsWith('_say')) {
    const texts = [args.text, ...Array.isArray(args.also) ? args.also : []].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    return { text: `你在 ${channel ?? '?'} 说：${texts.map(t => `「${t}」`).join('')}`, channels: channel === undefined ? [] : [channel] }
  }
  const shown = Object.entries(args).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ')
  return { text: `你用了 ${name}(${cut(shown, Math.min(max, 200))})`, channels: channel === undefined ? [] : [channel] }
}

/**
 * Render an ended waking's log as lines of what entered her context.
 * @param events - the log, in seq order (DSH `sessionPersistence` read).
 * @param options - how much of a tool result, heartbeat or thought to keep.
 */
export function renderLog(events: readonly LogEvent[], options: RenderOptions): LogLine[] {
  const max = options.resultChars
  const lines: LogLine[] = []
  const calls = new Map<string, string>()
  const push = (seq: number, text: string, channels: readonly string[] = [], people: readonly SourcePerson[] = []) => {
    if (text.trim() === '') return
    lines.push({ seq, text, channels: [...new Set([...channels, ...channelsIn(text)])], people })
  }
  for (const event of events) {
    if (event.type === 'user/message') {
      const message = event.data as Message
      const kind = message.source?.kind
      // What came to mind is memory already; DSH's own context is not her life.
      if (kind === 'anima-memory' || kind === 'system-prompt') continue
      const text = textOf(message.content)
      const stimulus = message.source?.stimulus
      const keep = kind === 'anima-stimulus' && stimulus !== 'heartbeat' ? text : cut(text, max)
      push(event.seq, keep, message.source?.channel === undefined ? [] : [message.source.channel], message.source?.people ?? [])
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: Message }).message
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && (block.text ?? '').trim() !== '') push(event.seq, `（你心里想：${cut(block.text!, max)}）`)
        if (block.type === 'tool-call' && block.name !== undefined) {
          if (block.id !== undefined) calls.set(block.id, block.name)
          const line = callLine(block.name, parseArgs(block.arguments), max)
          push(event.seq, line.text, line.channels)
        }
      }
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: Message }).message
      const name = message?.toolCallId === undefined ? undefined : calls.get(message.toolCallId)
      // A say's result is only that it went out; its words are already in the call.
      if (name?.endsWith('_say') === true && message?.isError !== true) continue
      const text = textOf(message?.content)
      if (text === '') continue
      push(event.seq, `${message?.isError === true ? '（没成功）' : '→'} ${cut(text, max)}`)
    }
  }
  return lines
}

/**
 * Cut lines into pieces of at most `maxTokens` (a line longer than that is a piece of its own).
 * @param lines - rendered lines, in order.
 * @param maxTokens - token budget of a piece.
 */
export function cutPieces(lines: readonly LogLine[], maxTokens: number): Piece[] {
  const pieces: Piece[] = []
  let current: LogLine[] = []
  let tokens = 0
  const close = () => {
    if (current.length === 0) return
    pieces.push({ from: current[0]!.seq, to: current.at(-1)!.seq, lines: current })
    current = []
    tokens = 0
  }
  for (const line of lines) {
    const cost = estimateTokens(line.text) + 2
    // Lines of one event stay together.
    if (current.length > 0 && tokens + cost > maxTokens && current.at(-1)!.seq !== line.seq) close()
    current.push(line)
    tokens += cost
  }
  close()
  return pieces
}

/** Channel keys and people of a piece. */
export function pieceFacts(piece: Piece): { channels: string[]; people: SourcePerson[] } {
  const channels = [...new Set(piece.lines.flatMap(line => line.channels))]
  const people = new Map<string, SourcePerson>()
  for (const person of piece.lines.flatMap(line => line.people)) people.set(`${person.platform}:${person.userId}`, person)
  return { channels, people: [...people.values()] }
}
