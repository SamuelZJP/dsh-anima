/**
 * QQ message rendering (docs/design/channels.md): QQ segments in, plain text
 * with placeholders out, plus the facts routing needs (does it @ her, which
 * message it replies to). Protocol-free and pure.
 * @module @anima/adapter-qq/normalize
 */

import type { OutgoingSegment, QqMessage, QqSegment } from './backend.ts'

/** Segment kinds that get a short id. */
export type MediaKind = 'image' | 'sticker' | 'forward'

/** What a short id is made from: an image segment or a forward segment. */
export type MediaSource = Extract<QqSegment, { type: 'image' | 'forward' }>

/** What rendering needs to know. */
export interface RenderContext {
  /** Her QQ number. */
  readonly selfId: string
  /** Her name, for mentions of her. */
  readonly herName: string
  /** Known display names by user id. */
  readonly name?: (userId: string) => string | undefined
  /**
   * A short id for an image, sticker or forward she can open later (`i3`,
   * `f2`), or undefined to leave it without one.
   */
  readonly ref?: (kind: MediaKind, source: MediaSource) => string | undefined
}

/** Rendered message content. */
export interface Rendered {
  readonly text: string
  /** Whether a segment @-mentions her (not `@all`). */
  readonly mentionsHer: boolean
  /** Message id this one replies to. */
  readonly replyTo?: string | undefined
}

function bracketless(summary: string): string {
  return summary.replace(/^\[(.*)\]$/, '$1').trim()
}

/**
 * Render segments as text: `@name` for mentions, placeholders for media.
 * Images are described by their summary when the runtime sends one; images,
 * stickers and forwards carry a short id (`[image #i3: …]`) when `ctx.ref` gives one.
 */
export function renderSegments(segments: readonly QqSegment[], ctx: RenderContext): Rendered {
  let mentionsHer = false
  let replyTo: string | undefined
  const parts: string[] = []
  for (const segment of segments) {
    switch (segment.type) {
      case 'text': parts.push(segment.text); break
      case 'mention': {
        const { userId } = segment
        if (userId === ctx.selfId) { mentionsHer = true; parts.push(`@${ctx.herName}`) } else if (userId === 'all') parts.push('@all')
        else parts.push(`@${ctx.name?.(userId) ?? (segment.name || userId)}`)
        break
      }
      case 'reply': replyTo = segment.messageId; break
      case 'image': {
        const kind = segment.sticker ? 'sticker' : 'image'
        const id = ctx.ref?.(kind, segment)
        const summary = bracketless(segment.summary ?? '')
        parts.push(`[${kind}${id === undefined ? '' : ` #${id}`}${summary === '' ? '' : `: ${summary}`}]`)
        break
      }
      case 'face': parts.push('[emoji]'); break
      case 'voice': parts.push('[voice message]'); break
      case 'video': parts.push('[video]'); break
      case 'file': parts.push(`[file${segment.name === undefined ? '' : `: ${segment.name}`}]`); break
      case 'card': parts.push('[card]'); break
      case 'forward': {
        const id = ctx.ref?.('forward', segment)
        const count = segment.content === undefined ? '' : `: ${segment.content.length} messages`
        parts.push(`[forwarded messages${id === undefined ? '' : ` #${id}`}${count}]`)
        break
      }
      case 'poke': parts.push('[poke]'); break
      case 'other': parts.push(`[${segment.name}]`)
    }
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return { text: text === '' ? '[empty message]' : text, mentionsHer, ...replyTo === undefined ? {} : { replyTo } }
}

/** A message as she reads it. */
export interface NormalizedMessage {
  readonly kind: 'private' | 'group'
  /** Other party's user id (private) or the group id. */
  readonly chatId: string
  readonly userId: string
  readonly displayName: string
  readonly messageId: string
  readonly text: string
  readonly mentionsHer: boolean
  readonly replyTo?: string | undefined
  /** Message time, epoch ms. */
  readonly time: number
}

/** Render a QQ message for her. */
export function normalizeMessage(message: QqMessage, ctx: RenderContext): NormalizedMessage {
  const rendered = renderSegments(message.segments, ctx)
  return {
    kind: message.kind, chatId: message.chatId, userId: message.userId,
    displayName: message.displayName,
    messageId: message.messageId,
    text: rendered.text,
    mentionsHer: rendered.mentionsHer,
    ...rendered.replyTo === undefined ? {} : { replyTo: rendered.replyTo },
    time: message.time ?? Date.now(),
  }
}

/**
 * Outgoing segments for `qq_say`: an optional reply, mentions, then the text.
 * @param text - message text.
 * @param options.replyTo - message id to reply to.
 * @param options.mention - user ids to @ (groups only).
 */
export function outgoing(text: string, options: { replyTo?: string | undefined; mention?: readonly string[] | undefined } = {}): OutgoingSegment[] {
  const segments: OutgoingSegment[] = []
  if (options.replyTo !== undefined && options.replyTo !== '') segments.push({ type: 'reply', messageId: options.replyTo })
  for (const userId of options.mention ?? []) segments.push({ type: 'mention', userId }, { type: 'text', text: ' ' })
  segments.push({ type: 'text', text })
  return segments
}
