/**
 * The OneBot v11 backend: {@link QqBackend} over a OneBot v11 forward WebSocket
 * server (NotRainMeow, or any OneBot v11 runtime). It turns QQ actions into
 * OneBot calls and OneBot events into QQ events. Runtime dialects stay here:
 * NapCat-style extensions (`notify/input_status`, `bot_offline`,
 * `set_msg_emoji_like` with code points, the `*_msg_history` and `mark_*_as_read`
 * actions), which NotRainMeow implements too.
 * @module @anima/adapter-qq/onebot/backend
 */

import type { BackendHandlers, ChatKind, ForwardNode, Health, OutgoingSegment, QqBackend, QqEvent, QqMessage } from '../backend.ts'
import { OneBotClient } from './client.ts'
import { emojiId, forwardNodes, oneBotSegments, qqMessage } from './segments.ts'
import type { OneBotEvent } from './types.ts'

/** Options of the OneBot backend (the `backend` section of the adapter config). */
export interface OneBotOptions {
  /** Forward WebSocket URL, e.g. `ws://127.0.0.1:3001`. */
  readonly url: string
  /** Access token, sent as `Authorization: Bearer`. */
  readonly accessToken?: string | undefined
  readonly callTimeoutMs: number
  readonly maxBackoffMs: number
  /** Heartbeat intervals without one before the connection counts as lost. */
  readonly heartbeatGrace: number
  /** First reconnect delay; 1 s by default. */
  readonly minBackoffMs?: number
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** Whether a OneBot `group_id` names a group (NapCat sends 0 for private notices). */
function isGroup(groupId: unknown): boolean {
  return groupId !== undefined && groupId !== null && str(groupId) !== '' && str(groupId) !== '0'
}

const chatParams = (kind: ChatKind, chatId: string) => kind === 'group' ? { group_id: Number(chatId) } : { user_id: Number(chatId) }

/** {@link QqBackend} over OneBot v11. */
export class OneBotBackend implements QqBackend {
  readonly name: string
  private readonly client: OneBotClient
  private handlers: BackendHandlers | undefined
  /** The account the runtime said it is logged in as; events for another account are dropped. */
  private selfId: string | undefined

  constructor(options: OneBotOptions) {
    this.name = `OneBot v11 at ${options.url}`
    this.client = new OneBotClient({
      ...options,
      onOpen: () => this.handlers?.open(),
      onClose: reason => this.handlers?.close(reason),
      onHealth: () => this.handlers?.health(),
      onEvent: (event) => {
        const qq = this.toEvent(event)
        if (qq !== undefined) this.handlers?.event(qq)
      },
    })
  }

  get health(): Health {
    return this.client.health
  }

  start(handlers: BackendHandlers): void {
    this.handlers = handlers
    this.client.start()
  }

  stop(): void {
    this.client.stop()
    this.handlers = undefined
  }

  async login(): Promise<{ userId: string; nickname?: string | undefined }> {
    const info = await this.client.call<{ user_id?: number | string; nickname?: string }>('get_login_info')
    this.selfId = str(info?.user_id)
    return { userId: this.selfId, ...info?.nickname === undefined ? {} : { nickname: info.nickname } }
  }

  async friends(): Promise<{ userId: string; name?: string | undefined }[]> {
    const friends = await this.client.call<{ user_id?: number | string; nickname?: string; remark?: string }[]>('get_friend_list')
    return (friends ?? []).filter(f => f.user_id !== undefined).map(f => ({ userId: str(f.user_id), name: f.remark || f.nickname }))
  }

  async groups(): Promise<{ groupId: string; name?: string | undefined }[]> {
    const groups = await this.client.call<{ group_id?: number | string; group_name?: string }[]>('get_group_list')
    return (groups ?? []).filter(g => g.group_id !== undefined).map(g => ({ groupId: str(g.group_id), name: g.group_name }))
  }

  async send(kind: ChatKind, chatId: string, segments: readonly OutgoingSegment[]): Promise<string> {
    const result = await this.client.call<{ message_id?: number | string }>(kind === 'group' ? 'send_group_msg' : 'send_private_msg', { ...chatParams(kind, chatId), message: oneBotSegments(segments) })
    return str(result?.message_id)
  }

  async message(messageId: string): Promise<QqMessage | undefined> {
    const msg = await this.client.call<OneBotEvent>('get_msg', { message_id: Number(messageId) })
    return msg === undefined || msg === null ? undefined : qqMessage({ message_type: 'private', ...msg })
  }

  async history(kind: ChatKind, chatId: string, count: number): Promise<QqMessage[]> {
    const result = await this.client.call<{ messages?: OneBotEvent[] }>(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', { ...chatParams(kind, chatId), count })
    return (result?.messages ?? []).map(event => qqMessage(event, { kind, chatId })).filter(m => m !== undefined)
  }

  async image(file: string): Promise<{ bytes?: Uint8Array | undefined; url?: string | undefined }> {
    const info = await this.client.call<{ base64?: string; url?: string }>('get_image', { file })
    if (typeof info?.base64 === 'string' && info.base64 !== '') return { bytes: new Uint8Array(Buffer.from(info.base64, 'base64')) }
    return typeof info?.url === 'string' && /^https?:\/\//.test(info.url) ? { url: info.url } : {}
  }

  async forward(id: string): Promise<ForwardNode[]> {
    const result = await this.client.call<{ messages?: unknown[]; message?: unknown[] }>('get_forward_msg', { id, message_id: id })
    return forwardNodes(result?.messages ?? result?.message ?? [])
  }

  async poke(kind: ChatKind, chatId: string, userId: string): Promise<void> {
    if (kind === 'group') await this.client.call('group_poke', { group_id: Number(chatId), user_id: Number(userId) })
    else await this.client.call('friend_poke', { user_id: Number(userId) })
  }

  async react(messageId: string, emoji: string): Promise<void> {
    const id = emojiId(emoji)
    if (id === undefined) throw new Error(`"${emoji}" is not one emoji or a QQ face id`)
    await this.client.call('set_msg_emoji_like', { message_id: Number(messageId), emoji_id: id, set: true })
  }

  async markRead(kind: ChatKind, chatId: string): Promise<void> {
    await this.client.call(kind === 'group' ? 'mark_group_msg_as_read' : 'mark_private_msg_as_read', chatParams(kind, chatId))
  }

  async typing(userId: string): Promise<void> {
    await this.client.call('set_input_status', { user_id: Number(userId), event_type: 1 })
  }

  /** A OneBot event in QQ terms, or undefined for what the adapter does not use (meta events, own sends). */
  private toEvent(event: OneBotEvent): QqEvent | undefined {
    if (this.selfId !== undefined && event.self_id !== undefined && str(event.self_id) !== this.selfId) return undefined
    switch (event.post_type) {
      case 'message': {
        const message = qqMessage(event)
        return message === undefined ? undefined : { type: 'message', message }
      }
      case 'notice': return this.toNotice(event)
      case 'request': {
        const userId = str(event.user_id)
        if (event.request_type === 'friend') {
          const flag = event.flag
          return {
            type: 'friend-request', userId, comment: (event.comment ?? '').trim(),
            answer: async (accept) => { await this.client.call('set_friend_add_request', { flag, approve: accept }) },
          }
        }
        if (event.request_type === 'group' && event.sub_type === 'invite') return { type: 'group-invite', userId, groupId: str(event.group_id) }
        return undefined
      }
      default: return undefined // message_sent, meta_event (the client reads heartbeats)
    }
  }

  private toNotice(event: OneBotEvent): QqEvent | undefined {
    const userId = str(event.user_id)
    // NapCat's input status, which NotRainMeow mirrors: private chats only, group_id 0.
    if (event.notice_type === 'notify' && event.sub_type === 'input_status') return { type: 'typing', userId, typing: str(event.status_text) !== '' }
    const kind: ChatKind = isGroup(event.group_id) ? 'group' : 'private'
    const chatId = kind === 'group' ? str(event.group_id) : userId
    if (event.notice_type === 'notify' && event.sub_type === 'poke') return { type: 'poke', kind, chatId, userId, targetId: str(event.target_id) }
    if (event.notice_type === 'friend_recall' || event.notice_type === 'group_recall') {
      return { type: 'recall', kind, chatId, operatorId: str(event.operator_id ?? event.user_id), messageId: str(event.message_id) }
    }
    return undefined // bot_offline is read by the client as a health signal.
  }
}
