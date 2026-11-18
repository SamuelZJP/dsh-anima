/**
 * OneBot v11 message content to and from QQ segments ({@link QqSegment}). Pure.
 * @module @anima/adapter-qq/onebot/segments
 */

import type { ChatKind, ForwardNode, OutgoingSegment, QqMessage, QqSegment } from '../backend.ts'
import type { OneBotEvent, OneBotSegment } from './types.ts'

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function opt(value: unknown): string | undefined {
  const text = str(value)
  return text === '' ? undefined : text
}

/** Decode CQ-code escapes. */
function unescape(text: string): string {
  return text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/**
 * Parse a CQ-code string (`hi [CQ:at,qq=123] there`) into segments. Runtimes
 * normally send arrays; this is the fallback for a runtime set to strings.
 */
export function parseCQ(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  const pattern = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  for (const match of raw.matchAll(pattern)) {
    if (match.index > last) segments.push({ type: 'text', data: { text: unescape(raw.slice(last, match.index)) } })
    const data: Record<string, string> = {}
    for (const pair of (match[2] ?? '').split(',').slice(1)) {
      const at = pair.indexOf('=')
      if (at > 0) data[pair.slice(0, at)] = unescape(pair.slice(at + 1))
    }
    segments.push({ type: match[1]!, data })
    last = match.index + match[0].length
  }
  if (last < raw.length) segments.push({ type: 'text', data: { text: unescape(raw.slice(last)) } })
  return segments
}

/** Segments of a OneBot `message` field (array or CQ string). */
export function segmentsOf(message: unknown): OneBotSegment[] {
  if (typeof message === 'string') return parseCQ(message)
  if (!Array.isArray(message)) return []
  return message.filter((s): s is OneBotSegment => typeof s === 'object' && s !== null && typeof (s as OneBotSegment).type === 'string')
    .map(s => ({ type: s.type, data: s.data ?? {} }))
}

/** Sender display name: group card, then nickname, then the id. */
export function displayNameOf(event: OneBotEvent): string {
  const card = event.sender?.card?.trim() ?? ''
  const nick = event.sender?.nickname?.trim() ?? ''
  return card !== '' ? card : nick !== '' ? nick : str(event.user_id ?? event.sender?.user_id)
}

/**
 * Forwarded messages, from `get_forward_msg` or inline `content`: `node`
 * segments (`{ type: 'node', data: { nickname, content } }`) or message-like entries.
 */
export function forwardNodes(messages: readonly unknown[]): ForwardNode[] {
  return messages.map((raw) => {
    const node = raw as OneBotEvent & { type?: string; data?: { nickname?: string; user_id?: number | string; content?: unknown; message?: unknown } }
    if (node.type === 'node' && node.data !== undefined) {
      return { name: str(node.data.nickname ?? node.data.user_id) || '?', segments: qqSegments(node.data.content ?? node.data.message) }
    }
    return { name: displayNameOf(node) || '?', segments: qqSegments(node.message) }
  })
}

/** One OneBot segment in QQ terms. */
export function qqSegment({ type, data }: OneBotSegment): QqSegment {
  switch (type) {
    case 'text': return { type: 'text', text: str(data.text) }
    case 'at': return { type: 'mention', userId: str(data.qq), ...opt(data.name) === undefined ? {} : { name: opt(data.name) } }
    case 'reply': return { type: 'reply', messageId: str(data.id) }
    case 'image':
    case 'mface': return {
      type: 'image', sticker: type === 'mface',
      ...opt(data.url) === undefined ? {} : { url: opt(data.url) },
      ...(opt(data.file) ?? opt(data.file_id)) === undefined ? {} : { file: opt(data.file) ?? opt(data.file_id) },
      ...opt(data.summary) === undefined ? {} : { summary: opt(data.summary) },
    }
    case 'forward': return {
      type: 'forward',
      ...opt(data.id) === undefined ? {} : { id: opt(data.id) },
      ...Array.isArray(data.content) ? { content: forwardNodes(data.content) } : {},
    }
    case 'face': return { type: 'face' }
    case 'record': return { type: 'voice' }
    case 'video': return { type: 'video' }
    case 'file': return { type: 'file', ...opt(data.name) === undefined ? {} : { name: opt(data.name) } }
    case 'json':
    case 'xml': return { type: 'card' }
    case 'poke': return { type: 'poke' }
    default: return { type: 'other', name: type }
  }
}

/** A OneBot `message` field in QQ terms. */
export function qqSegments(message: unknown): QqSegment[] {
  return segmentsOf(message).map(qqSegment)
}

/** Her outgoing segments as OneBot segments. */
export function oneBotSegments(segments: readonly OutgoingSegment[]): OneBotSegment[] {
  return segments.map((segment) => {
    switch (segment.type) {
      case 'text': return { type: 'text', data: { text: segment.text } }
      case 'mention': return { type: 'at', data: { qq: segment.userId } }
      case 'reply': return { type: 'reply', data: { id: segment.messageId } }
    }
  })
}

/**
 * A OneBot message event, or a message from `get_msg` or history, in QQ terms.
 * @param where - the chat, when the caller knows it (history); otherwise from the event.
 * @returns the message, or undefined for anything that is not a private or group message.
 */
export function qqMessage(event: OneBotEvent, where?: { kind: ChatKind; chatId: string }): QqMessage | undefined {
  const kind = where?.kind ?? event.message_type
  if (kind !== 'private' && kind !== 'group') return undefined
  const userId = str(event.user_id ?? event.sender?.user_id)
  const chatId = where?.chatId ?? (kind === 'group' ? str(event.group_id) : userId)
  if (userId === '' || chatId === '') return undefined
  return {
    kind, chatId, userId,
    displayName: displayNameOf(event),
    messageId: str(event.message_id),
    segments: qqSegments(event.message),
    ...typeof event.time === 'number' ? { time: event.time * 1000 } : {},
  }
}

/**
 * The `emoji_id` of `set_msg_emoji_like`: a QQ face id (1–3 digits) as is, or
 * one Unicode emoji as its decimal code point (NapCat and NotRainMeow read ids
 * longer than 3 digits as Unicode emoji).
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
