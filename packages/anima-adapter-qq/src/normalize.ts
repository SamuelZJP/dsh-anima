/**
 * OneBot v11 message normalization (DESIGN §11): segments in, plain text with
 * placeholders out, plus the facts routing needs (does it @ her, which message
 * it replies to). Pure.
 * @module @anima/adapter-qq/normalize
 */

/** One OneBot message segment. */
export interface Segment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Decode CQ-code escapes. */
function unescape(text: string): string {
  return text.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/**
 * Parse a CQ-code string (`hi [CQ:at,qq=123] there`) into segments. Runtimes
 * normally send arrays; this is the fallback for `messagePostFormat: string`.
 */
export function parseCQ(raw: string): Segment[] {
  const segments: Segment[] = []
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
export function segmentsOf(message: unknown): Segment[] {
  if (typeof message === 'string') return parseCQ(message)
  if (!Array.isArray(message)) return []
  return message.filter((s): s is Segment => typeof s === 'object' && s !== null && typeof (s as Segment).type === 'string')
    .map(s => ({ type: s.type, data: s.data ?? {} }))
}

/** What rendering needs to know. */
export interface RenderContext {
  /** Her QQ number. */
  readonly selfId: string
  /** Her name, for mentions of her. */
  readonly herName: string
  /** Known display names by user id. */
  readonly name?: (userId: string) => string | undefined
  /**
   * A short id for an image, sticker or forward segment she can open later
   * (`i3`, `f2`), or undefined to leave it without one.
   */
  readonly ref?: (kind: MediaKind, data: Readonly<Record<string, unknown>>) => string | undefined
}

/** Segment kinds that get a short id. */
export type MediaKind = 'image' | 'sticker' | 'forward'

/** Rendered message content. */
export interface Rendered {
  readonly text: string
  /** Whether a segment @-mentions her (not `@all`). */
  readonly mentionsHer: boolean
  /** Message id this one replies to. */
  readonly replyTo?: string | undefined
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function bracketless(summary: string): string {
  return summary.replace(/^\[(.*)\]$/, '$1').trim()
}

/**
 * Render segments as text: `@name` for mentions, placeholders for media.
 * Images are described by their summary when the runtime sends one; images,
 * stickers and forwards carry a short id (`[image #i3: …]`) when `ctx.ref` gives one.
 */
export function renderSegments(segments: readonly Segment[], ctx: RenderContext): Rendered {
  let mentionsHer = false
  let replyTo: string | undefined
  const parts: string[] = []
  for (const { type, data } of segments) {
    switch (type) {
      case 'text': parts.push(str(data.text)); break
      case 'at': {
        const qq = str(data.qq)
        if (qq === ctx.selfId) { mentionsHer = true; parts.push(`@${ctx.herName}`) } else if (qq === 'all') parts.push('@all')
        else parts.push(`@${ctx.name?.(qq) ?? (str(data.name) || qq)}`)
        break
      }
      case 'reply': replyTo = str(data.id); break
      case 'image':
      case 'mface': {
        const kind = type === 'image' ? 'image' : 'sticker'
        const id = ctx.ref?.(kind, data)
        const summary = bracketless(str(data.summary))
        parts.push(`[${kind}${id === undefined ? '' : ` #${id}`}${summary === '' ? '' : `: ${summary}`}]`)
        break
      }
      case 'face': parts.push('[emoji]'); break
      case 'record': parts.push('[voice message]'); break
      case 'video': parts.push('[video]'); break
      case 'file': parts.push(`[file${str(data.name) === '' ? '' : `: ${str(data.name)}`}]`); break
      case 'json':
      case 'xml': parts.push('[card]'); break
      case 'forward': {
        const id = ctx.ref?.('forward', data)
        const count = Array.isArray(data.content) ? `: ${data.content.length} messages` : ''
        parts.push(`[forwarded messages${id === undefined ? '' : ` #${id}`}${count}]`)
        break
      }
      case 'poke': parts.push('[poke]'); break
      default: parts.push(`[${type}]`)
    }
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  return { text: text === '' ? '[empty message]' : text, mentionsHer, ...replyTo === undefined ? {} : { replyTo } }
}

/** A OneBot message event, normalized. */
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
  /** Event time, epoch ms. */
  readonly time: number
}

/** The loose shape of OneBot events this adapter reads. */
export interface OneBotEvent {
  readonly post_type?: string
  readonly message_type?: string
  readonly notice_type?: string
  readonly request_type?: string
  readonly meta_event_type?: string
  readonly sub_type?: string
  readonly message_id?: number | string
  readonly user_id?: number | string
  readonly group_id?: number | string
  readonly target_id?: number | string
  readonly operator_id?: number | string
  readonly self_id?: number | string
  readonly message?: unknown
  readonly sender?: { readonly user_id?: number | string; readonly nickname?: string; readonly card?: string }
  readonly comment?: string
  readonly flag?: string
  readonly time?: number
  readonly interval?: number
  readonly status?: { readonly online?: boolean; readonly good?: boolean }
  readonly tag?: string
  readonly [key: string]: unknown
}

/** Sender display name: group card, then nickname, then the id. */
export function displayNameOf(event: OneBotEvent): string {
  const card = event.sender?.card?.trim() ?? ''
  const nick = event.sender?.nickname?.trim() ?? ''
  return card !== '' ? card : nick !== '' ? nick : str(event.user_id)
}

/**
 * Normalize a OneBot message event.
 * @returns the message, or undefined for anything that is not a private or group message.
 */
export function normalizeMessage(event: OneBotEvent, ctx: RenderContext): NormalizedMessage | undefined {
  if (event.post_type !== 'message') return undefined
  const kind = event.message_type
  if (kind !== 'private' && kind !== 'group') return undefined
  const userId = str(event.user_id ?? event.sender?.user_id)
  const chatId = kind === 'group' ? str(event.group_id) : userId
  if (userId === '' || chatId === '') return undefined
  const rendered = renderSegments(segmentsOf(event.message), ctx)
  return {
    kind, chatId, userId,
    displayName: displayNameOf(event),
    messageId: str(event.message_id),
    text: rendered.text,
    mentionsHer: rendered.mentionsHer,
    ...rendered.replyTo === undefined ? {} : { replyTo: rendered.replyTo },
    time: typeof event.time === 'number' ? event.time * 1000 : Date.now(),
  }
}

/**
 * Outgoing segments for `qq_say`: an optional reply, mentions, then the text.
 * @param text - message text.
 * @param options.replyTo - message id to reply to.
 * @param options.mention - user ids to @ (groups only).
 */
export function outgoing(text: string, options: { replyTo?: string | undefined; mention?: readonly string[] | undefined } = {}): Segment[] {
  const segments: Segment[] = []
  if (options.replyTo !== undefined && options.replyTo !== '') segments.push({ type: 'reply', data: { id: options.replyTo } })
  for (const qq of options.mention ?? []) segments.push({ type: 'at', data: { qq } }, { type: 'text', data: { text: ' ' } })
  segments.push({ type: 'text', data: { text } })
  return segments
}
