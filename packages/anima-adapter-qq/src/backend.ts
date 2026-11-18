/**
 * The QQ backend contract (docs/design/channels.md): everything the QQ adapter
 * needs from the runtime that holds her QQ account, in QQ terms. Nothing here
 * names a protocol; a runtime with another protocol is one new implementation
 * (today: OneBot v11, `./onebot/`). Behaviors, channels, placeholders and media
 * ids sit above this interface. An optional method the backend leaves out is a
 * thing it cannot do, and the adapter registers no behavior for it.
 * @module @anima/adapter-qq/backend
 */

/** A private chat (with a person) or a group. */
export type ChatKind = 'private' | 'group'

/** One forwarded message inside a forward. */
export interface ForwardNode {
  /** Who wrote it, as the forward shows them. */
  readonly name: string
  readonly segments: readonly QqSegment[]
}

/** One piece of a QQ message. */
export type QqSegment =
  | { readonly type: 'text'; readonly text: string }
  /** An @: a user id, or `all`; `name` when the runtime sends one. */
  | { readonly type: 'mention'; readonly userId: string; readonly name?: string | undefined }
  | { readonly type: 'reply'; readonly messageId: string }
  /**
   * A picture, or a sticker. `url` is a download URL; `file` is the backend's
   * own handle for {@link QqBackend.image}. Either may be missing.
   */
  | { readonly type: 'image'; readonly sticker: boolean; readonly url?: string | undefined; readonly file?: string | undefined; readonly summary?: string | undefined }
  /** A forwarded chat record: its id for {@link QqBackend.forward}, or its content inline. */
  | { readonly type: 'forward'; readonly id?: string | undefined; readonly content?: readonly ForwardNode[] | undefined }
  | { readonly type: 'face' }
  | { readonly type: 'voice' }
  | { readonly type: 'video' }
  | { readonly type: 'file'; readonly name?: string | undefined }
  | { readonly type: 'card' }
  | { readonly type: 'poke' }
  /** Anything else, by the runtime's own name. */
  | { readonly type: 'other'; readonly name: string }

/** What she can send: text, with an optional reply and mentions. */
export type OutgoingSegment = Extract<QqSegment, { type: 'text' | 'mention' | 'reply' }>

/** A message in a chat. */
export interface QqMessage {
  readonly kind: ChatKind
  /** The other person's user id (private) or the group id. */
  readonly chatId: string
  /** Who wrote it. */
  readonly userId: string
  /** Group card, else nickname, else the user id. */
  readonly displayName: string
  readonly messageId: string
  readonly segments: readonly QqSegment[]
  /** When it was sent, epoch ms, when the runtime says. */
  readonly time?: number | undefined
}

/** Something that happened on her account. */
export type QqEvent =
  | { readonly type: 'message'; readonly message: QqMessage }
  /** `userId` poked `targetId` in a chat. */
  | { readonly type: 'poke'; readonly kind: ChatKind; readonly chatId: string; readonly userId: string; readonly targetId: string }
  /** `operatorId` recalled a message. */
  | { readonly type: 'recall'; readonly kind: ChatKind; readonly chatId: string; readonly operatorId: string; readonly messageId: string }
  /** Someone asked to be her friend; `answer` is missing when the backend cannot answer. */
  | { readonly type: 'friend-request'; readonly userId: string; readonly comment: string; readonly answer?: ((accept: boolean) => Promise<void>) | undefined }
  | { readonly type: 'group-invite'; readonly userId: string; readonly groupId: string }
  /** The other person in a private chat is typing (or stopped). */
  | { readonly type: 'typing'; readonly userId: string; readonly typing: boolean }

/** Connection health, for her status and the page. */
export interface Health {
  /** Connection state. */
  state: 'idle' | 'connecting' | 'open' | 'closed'
  /** When the state last changed, epoch ms. */
  since: number
  /** Last sign of life from the runtime (its heartbeat), epoch ms. */
  lastHeartbeat?: number | undefined
  /** Whether the QQ account is online per the runtime. */
  online?: boolean | undefined
  /** Delay before the next reconnect attempt. */
  retryInMs?: number | undefined
  /** Last error or close reason. */
  lastError?: string | undefined
  /** Successful connections so far. */
  connects: number
}

/** What the adapter hears from a backend. */
export interface BackendHandlers {
  /** An event on her account, in order. */
  event(event: QqEvent): void
  /** Connected (again); the adapter checks the login next. */
  open(): void
  /** The connection closed. */
  close(reason: string): void
  /** Health changed without a connect or close (account online or offline, heartbeat). */
  health(): void
}

/** The runtime that holds her QQ account. */
export interface QqBackend {
  /** What it is and where, for status lines (never a secret): `OneBot v11 at ws://…`. */
  readonly name: string
  readonly health: Health
  /** Connect, and keep reconnecting until {@link stop}. */
  start(handlers: BackendHandlers): void
  /** Disconnect for good; pending calls fail. */
  stop(): void
  /** The account the runtime is logged in as. */
  login(): Promise<{ readonly userId: string; readonly nickname?: string | undefined }>
  friends(): Promise<readonly { readonly userId: string; readonly name?: string | undefined }[]>
  groups(): Promise<readonly { readonly groupId: string; readonly name?: string | undefined }[]>
  /** Send one message. @returns its message id ('' when the runtime gives none). */
  send(kind: ChatKind, chatId: string, segments: readonly OutgoingSegment[]): Promise<string>
  /** One message by id, for a quoted reply. */
  message?(messageId: string): Promise<QqMessage | undefined>
  /** Recent messages of a chat, oldest first. */
  history?(kind: ChatKind, chatId: string, count: number): Promise<readonly QqMessage[]>
  /** An image by its `file` handle: the bytes, or a URL to fetch them from. */
  image?(file: string): Promise<{ readonly bytes?: Uint8Array | undefined; readonly url?: string | undefined }>
  /** The messages of a forward by its id. */
  forward?(id: string): Promise<readonly ForwardNode[]>
  poke?(kind: ChatKind, chatId: string, userId: string): Promise<void>
  /** React to a message with one emoji character or a QQ face id (1–3 digits). */
  react?(messageId: string, emoji: string): Promise<void>
  /** Mark a chat read. */
  markRead?(kind: ChatKind, chatId: string): Promise<void>
  /** Show "typing" to the other person in a private chat. */
  typing?(userId: string): Promise<void>
}
