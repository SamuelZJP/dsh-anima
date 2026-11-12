/**
 * QQ adapter (DESIGN §11) over OneBot v11. It connects as a WebSocket client
 * to the runtime's forward WebSocket server (NapCatQQ, or any OneBot v11
 * runtime), turns private and group messages, pokes, recalls and friend
 * requests from allowlisted chats into stimuli, and registers `qq_say` and
 * `qq_history`. The owner's private chat is the owner line for approvals.
 * @module @anima/adapter-qq
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AnimaError, formatLocal } from '@anima/core'
import type {} from '@anima/core'
import type { PublishedChannel } from '@anima/life'
import type {} from '@anima/life'
import { Config as ConfigSchema, resolveQqConfig, type Config as QqConfig, type ResolvedQqConfig } from './config.ts'
import { displayNameOf, normalizeMessage, outgoing, renderSegments, segmentsOf, type NormalizedMessage, type OneBotEvent, type Segment } from './normalize.ts'
import { emojiId, fetchCapped, MediaBook, normalizeMediaId, sniffImage, type MediaEntry } from './media.ts'
import { OneBotClient, type Health } from './onebot.ts'

export { resolveQqConfig, type AllowEntry, type ResolvedQqConfig } from './config.ts'
export { displayNameOf, normalizeMessage, outgoing, parseCQ, renderSegments, segmentsOf, type NormalizedMessage, type OneBotEvent, type RenderContext, type Rendered, type Segment } from './normalize.ts'
export { backoff, connectUrl, OneBotClient, type ClientOptions, type Health } from './onebot.ts'
export { emojiId, MediaBook, normalizeMediaId, sniffImage, type MediaEntry } from './media.ts'

/** Cordis plugin name. */
export const name = 'anima-adapter-qq'
/** Services used by the plugin. */
export const inject = ['anima', 'animaLife', 'tools']

/** Platform id and tool prefix. */
export const PLATFORM = 'qq'
/** The say behavior. */
export const SAY_TOOL = 'qq_say'
/** The history behavior. */
export const HISTORY_TOOL = 'qq_history'
/** Look at an image or sticker by its id. */
export const LOOK_TOOL = 'qq_look'
/** Read a forwarded message by its id. */
export const FORWARD_TOOL = 'qq_read_forward'
/** Poke someone. */
export const POKE_TOOL = 'qq_poke'
/** React to a message with an emoji. */
export const REACT_TOOL = 'qq_react'

/** Plugin config. */
export type Config = QqConfig
/** Plugin config schema. */
export const Config = ConfigSchema

/** Message ids she sent, to recognize replies to her. */
const SENT_IDS = 500
/** Most messages `qq_history` returns. */
const HISTORY_MAX = 30
/** Recent message texts kept for quoted-reply snippets. */
const RECENT_TEXTS = 500

/** Channel key of a QQ chat. */
export function qqChannelKey(account: string, kind: 'private' | 'group', id: string): string {
  return `${PLATFORM}:${account}:${kind}:${id}`
}

/** The channels the config allows: the owner's private chat first. */
export function allowedChannels(config: ResolvedQqConfig): PublishedChannel[] {
  const base = { platform: PLATFORM, account: config.account }
  return [
    { ...base, kind: 'private', id: config.owner, display: `${config.ownerName} (QQ)`, isOwner: true },
    ...config.allow.users.filter(user => user.id !== config.owner).map(user => ({ ...base, kind: 'private', id: user.id, display: `${user.name ?? `QQ ${user.id}`} (QQ)` })),
    ...config.allow.groups.map(group => ({ ...base, kind: 'group', id: group.id, display: `${group.name ?? `group ${group.id}`} (QQ)` })),
  ]
}

/**
 * Register the QQ adapter.
 * @param ctx - root context.
 * @param input - plugin config.
 */
export function apply(ctx: Context, input: Partial<Config> | undefined): void {
  const config = resolveQqConfig(input)
  const core = ctx.anima
  const life = ctx.animaLife
  const herName = core.config.name

  const channels = allowedChannels(config)
  const byKey = new Map(channels.map(channel => [qqChannelKey(config.account, channel.kind as 'private' | 'group', channel.id), channel]))
  const channelOf = (kind: 'private' | 'group', id: string) => byKey.get(qqChannelKey(config.account, kind, id))
  life.publish(channels)
  core.restrictChannels(PLATFORM, key => byKey.has(key))

  const names = new Map<string, string>()
  const sentIds = new Set<string>()
  const remember = (id: string) => {
    sentIds.add(id)
    if (sentIds.size > SENT_IDS) sentIds.delete(sentIds.values().next().value!)
  }
  const login = { ready: false, nickname: undefined as string | undefined, problem: undefined as string | undefined }
  const counts = { delivered: 0, dropped: 0, sent: 0 }
  const media = new MediaBook(join(core.config.dataDir, 'qq', 'media.json'), config.look.cacheEntries)
  /** Rendering for one chat: images, stickers and forwards get ids that belong to it. */
  const renderIn = (chat: string) => ({
    selfId: config.account, herName, name: (id: string) => names.get(id),
    ref: (kind: Parameters<MediaBook['idFor']>[1], data: Readonly<Record<string, unknown>>) => media.idFor(chat, kind, data),
  })
  /** Recent message texts by id, for quoted replies: who wrote it and what. */
  const recent = new Map<string, { who: string; text: string }>()
  const keep = (messageId: string, who: string, text: string) => {
    if (messageId === '') return
    recent.delete(messageId)
    recent.set(messageId, { who, text })
    if (recent.size > RECENT_TEXTS) recent.delete(recent.keys().next().value!)
  }
  /** Whether QQ can send and receive now, and since when and why not (real time). */
  const offline = { down: true, since: Date.now(), reason: 'not connected yet' as string }
  let queue: Promise<void> = Promise.resolve()

  const client = new OneBotClient({
    url: config.url,
    accessToken: config.accessToken,
    callTimeoutMs: config.callTimeoutSeconds * 1000,
    maxBackoffMs: config.reconnect.maxSeconds * 1000,
    heartbeatGrace: config.heartbeatGrace,
    onOpen: () => { void verifyLogin().finally(updateHealth) },
    onClose: () => {
      login.ready = false
      updateHealth()
    },
    onEvent: (event) => {
      if (event.post_type === 'meta_event' || event.notice_type === 'bot_offline') updateHealth()
      // One at a time, so a group's messages reach her in order.
      queue = queue.then(() => handle(event)).catch((error: unknown) => ctx.logger.warn(`anima qq: ${error instanceof Error ? error.message : String(error)}`))
    },
  })
  ctx.effect(() => {
    client.start()
    return () => client.stop()
  }, 'anima-adapter-qq.client')

  /** Why QQ is not usable now, or undefined when it is. */
  function downReason(): string | undefined {
    const { health } = client
    if (health.state !== 'open') return `${health.lastError ?? 'not connected'} (${health.state}${health.retryInMs === undefined ? '' : `, retry in ${Math.round(health.retryInMs / 1000)} s`})`
    if (login.problem !== undefined) return login.problem
    if (!login.ready) return 'connected, checking the login'
    if (health.online === false) return health.lastError?.startsWith('bot offline') === true ? `NapCat reports the account offline (${health.lastError})` : 'the runtime reports the QQ account offline'
    return undefined
  }

  /** Log each change of QQ's usability once, and tell anima-life (DESIGN §11). A development warning only. */
  function updateHealth(): void {
    const reason = downReason()
    const down = reason !== undefined
    if (down === offline.down) {
      if (down) offline.reason = reason
      return
    }
    offline.down = down
    offline.since = Date.now()
    offline.reason = reason ?? ''
    life.platformStatus(PLATFORM, !down, reason)
  }
  ctx.effect(() => {
    life.platformStatus(PLATFORM, false, offline.reason)
    return () => {}
  }, 'anima-adapter-qq.health')

  async function verifyLogin(): Promise<void> {
    try {
      const info = await client.call<{ user_id?: number | string; nickname?: string }>('get_login_info')
      if (String(info.user_id) !== config.account) {
        login.ready = false
        login.problem = `the runtime is logged in as ${String(info.user_id)}, but the config says account ${config.account}; nothing is delivered or sent until they match.`
        ctx.logger.error(`anima qq: ${login.problem}`)
        return
      }
      login.nickname = info.nickname
      login.problem = undefined
      login.ready = true
    } catch (error: unknown) {
      login.problem = `get_login_info failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function send(kind: 'private' | 'group', id: string, message: Segment[]): Promise<string> {
    if (!login.ready) throw new AnimaError('anima/qq-offline', `QQ is not ready (${login.problem ?? client.health.lastError ?? client.health.state}); the message was not sent.`)
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const target = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }
    const result = await client.call<{ message_id?: number | string }>(action, { ...target, message })
    const messageId = String(result?.message_id ?? '')
    if (messageId !== '') remember(messageId)
    counts.sent += 1
    return messageId
  }

  core.provideOwnerLine({
    name: `QQ private chat with the owner (${config.owner})`,
    send: async (text) => { await send('private', config.owner, [{ type: 'text', data: { text } }]) },
  })

  /** Who wrote a message, as she knows them. */
  function whoIs(userId: string, event?: OneBotEvent): string {
    if (userId === config.account) return 'you'
    if (userId === config.owner) return config.ownerName
    return names.get(userId) ?? (event === undefined ? userId : displayNameOf(event))
  }

  /**
   * A replied-to message: whether it is hers, and who wrote what. From the
   * recent-message cache, else `get_msg` (the reply is always in the same chat).
   */
  async function quoted(messageId: string, chat: string): Promise<{ hers: boolean; who?: string; text?: string }> {
    const known = recent.get(messageId)
    if (known !== undefined) return { hers: known.who === 'you', who: known.who, text: known.text }
    try {
      const msg = await client.call<OneBotEvent>('get_msg', { message_id: Number(messageId) })
      const userId = String(msg?.sender?.user_id ?? msg?.user_id ?? '')
      const who = whoIs(userId, msg)
      const text = renderSegments(segmentsOf(msg?.message), renderIn(chat)).text
      keep(messageId, who, text)
      return { hers: userId === config.account, who, text }
    } catch {
      return { hers: sentIds.has(messageId) }
    }
  }

  /** `(replying to Cat, msg 123: "…")`, or just the id when nothing is known. */
  function replyLabel(messageId: string, quote: { who?: string | undefined; text?: string | undefined } | undefined): string {
    if (quote?.who === undefined || quote.text === undefined || config.quoteChars === 0) return `(replying to msg ${messageId})`
    const text = [...quote.text]
    const snippet = text.length > config.quoteChars ? `${text.slice(0, config.quoteChars).join('')}…` : quote.text
    return `(replying to ${quote.who}, msg ${messageId}: ${JSON.stringify(snippet)})`
  }

  const drop = () => { counts.dropped += 1 }

  async function deliverMessage(message: NormalizedMessage): Promise<void> {
    const channel = channelOf(message.kind, message.chatId)
    if (channel === undefined) return drop()
    names.set(message.userId, message.displayName)
    const isOwner = message.userId === config.owner
    if (isOwner && message.kind === 'private') {
      const answer = core.handleOwnerReply(message.text)
      if (answer !== undefined) {
        await send('private', config.owner, [{ type: 'text', data: { text: answer } }])
        return
      }
    }
    const chat = qqChannelKey(config.account, message.kind, message.chatId)
    const quote = message.replyTo === undefined ? undefined : await quoted(message.replyTo, chat)
    const addressed = message.kind === 'group'
      ? message.mentionsHer || quote?.hers === true
      : undefined
    keep(message.messageId, isOwner ? config.ownerName : message.displayName, message.text)
    const text = message.replyTo === undefined ? message.text : `${replyLabel(message.replyTo, quote)} ${message.text}`
    counts.delivered += 1
    await life.deliver({
      type: 'message',
      channel,
      sender: { platformUserId: message.userId, displayName: isOwner ? config.ownerName : message.displayName, isOwner },
      text,
      ts: core.clock.now(),
      messageId: message.messageId,
      ...addressed === undefined ? {} : { addressed },
    })
  }

  async function handle(event: OneBotEvent): Promise<void> {
    if (event.self_id !== undefined && String(event.self_id) !== config.account) return
    if (!login.ready) return
    switch (event.post_type) {
      case 'message': {
        if (String(event.user_id) === config.account) return
        const chatId = event.message_type === 'group' ? String(event.group_id ?? '') : String(event.user_id ?? event.sender?.user_id ?? '')
        const kind = event.message_type === 'group' ? 'group' : 'private'
        const message = normalizeMessage(event, renderIn(qqChannelKey(config.account, kind, chatId)))
        if (message !== undefined) await deliverMessage(message)
        return
      }
      case 'notice': return notice(event)
      case 'request':
        // Not awaited: the owner's answer arrives as a later event on this same queue.
        request(event).catch((error: unknown) => ctx.logger.warn(`anima qq: friend request: ${error instanceof Error ? error.message : String(error)}`))
        return
      default: return // message_sent, meta_event (the client reads heartbeats)
    }
  }

  async function notice(event: OneBotEvent): Promise<void> {
    const userId = String(event.user_id ?? '')
    const groupId = event.group_id === undefined ? undefined : String(event.group_id)
    const channel = groupId === undefined ? channelOf('private', userId) : channelOf('group', groupId)
    if (event.notice_type === 'notify' && event.sub_type === 'poke') {
      if (String(event.target_id) !== config.account || userId === config.account) return
      if (channel === undefined) return drop()
      const isOwner = userId === config.owner
      counts.delivered += 1
      await life.deliver({
        type: 'message', channel,
        sender: { platformUserId: userId, displayName: isOwner ? config.ownerName : names.get(userId) ?? userId, isOwner },
        text: '[pokes you]', ts: core.clock.now(),
        ...channel.kind === 'group' ? { addressed: true } : {},
      })
      return
    }
    if (event.notice_type === 'friend_recall' || event.notice_type === 'group_recall') {
      const operator = String(event.operator_id ?? userId)
      if (operator === config.account || channel === undefined) return
      const who = operator === config.owner ? config.ownerName : names.get(operator) ?? operator
      await life.deliver({ type: 'channel-event', channel, text: `${who} recalled a message (msg ${String(event.message_id)}).`, ts: core.clock.now() })
    }
    // bot_offline is read by the client as a health signal.
  }

  async function request(event: OneBotEvent): Promise<void> {
    const userId = String(event.user_id ?? '')
    const comment = (event.comment ?? '').trim()
    if (event.request_type === 'friend') {
      const who = `QQ user ${userId}${comment === '' ? '' : ` ("${comment}")`}`
      life.note(`${who} asked to be your friend on QQ; the owner was asked to decide.`)
      const answer = await core.requestApproval(`${who} wants to add her (${config.account}) as a QQ friend.`)
      if (answer === 'approved' || answer === 'denied') {
        await client.call('set_friend_add_request', { flag: event.flag, approve: answer === 'approved' })
        life.note(`The owner ${answer === 'approved' ? 'accepted' : 'declined'} the QQ friend request from ${userId}.`)
      } else {
        life.note(`The QQ friend request from ${userId} was left unanswered (${answer === 'timeout' ? 'the owner did not answer in time' : 'the owner could not be asked'}).`)
      }
      return
    }
    if (event.request_type === 'group' && event.sub_type === 'invite') {
      life.note(`QQ user ${userId} invited you to group ${String(event.group_id)}. You do not join groups yourself; the owner decides.`)
    }
  }

  function sessionChannel(sessionId: string | undefined): PublishedChannel {
    const session = sessionId === undefined ? undefined : core.describeSession(sessionId)
    if (session?.kind !== 'conversation' || session.channel.platform !== PLATFORM) {
      throw new AnimaError('anima/no-channel', 'this session is not bound to a QQ chat.')
    }
    const channel = byKey.get(session.channelKey)
    if (channel === undefined) throw new AnimaError('anima/not-allowlisted', 'this QQ chat is not on the owner\'s allowlist.')
    return channel
  }

  core.registerBehavior(defineTool({
    name: SAY_TOOL,
    description: 'Send one message in this QQ chat. They see only what you send this way. In groups you can reply to a message id and mention people by user id.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message, exactly as it should appear.' },
      replyTo: { type: 'string', description: 'Optional message id to reply to (the "msg" number shown with each message).' },
      mention: { type: 'array', items: { type: 'string' }, description: 'Optional QQ user ids to @ before the text (groups only).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true, description: 'Whether the message went out.' },
          messageId: { type: 'string', required: true, description: 'QQ message id of what you sent.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `sent (msg ${value.messageId})` }],
    },
    async execute(args, exec) {
      const channel = sessionChannel(exec.agent?.id)
      if (args.text.trim() === '') throw new AnimaError('anima/empty-message', 'text is empty; to stay silent, call stay_silent instead.')
      const mention = args.mention ?? []
      if (mention.length > 0 && channel.kind !== 'group') throw new AnimaError('anima/bad-args', 'mention works only in group chats.')
      if (mention.some(id => !/^\d{4,12}$/.test(id))) throw new AnimaError('anima/bad-args', 'mention takes QQ user ids (digits), as shown with each message.')
      // Typing shows only while a message she chose waits in the outbox, in private chats.
      let typing: ReturnType<typeof setTimeout> | undefined
      try {
        await life.holdOutgoing(exec.agent!.id, args.text, {
          onHeld: (held) => {
            if (channel.kind !== 'private' || !config.typing.enabled) return
            typing = setTimeout(() => {
              if (!login.ready) return
              client.call('set_input_status', { user_id: Number(channel.id), event_type: 1 })
                .catch((error: unknown) => ctx.logger.debug(`anima qq: set_input_status: ${error instanceof Error ? error.message : String(error)}`))
            }, Math.max(0, held.sendsAt - Date.now() - config.typing.leadSeconds * 1000))
          },
        })
      } finally {
        clearTimeout(typing)
      }
      const messageId = await send(channel.kind as 'private' | 'group', channel.id, outgoing(args.text, { replyTo: args.replyTo, mention }))
      keep(messageId, 'you', args.text)
      return { sent: true, messageId }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  core.registerBehavior(defineTool({
    name: HISTORY_TOOL,
    description: 'Read recent messages of this QQ chat, oldest first, including ones that did not reach you.',
    parameters: {
      count: { type: 'integer', description: `How many recent messages, 1–${HISTORY_MAX} (default 15).` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true, description: 'One line per message.' } } },
      render: (_args, value) => [{ type: 'text', text: value.lines.length === 0 ? 'No messages.' : value.lines.join('\n') }],
    },
    async execute(args, exec) {
      const channel = sessionChannel(exec.agent?.id)
      const session = { channelKey: qqChannelKey(config.account, channel.kind as 'private' | 'group', channel.id) }
      const count = Math.max(1, Math.min(HISTORY_MAX, Math.round(args.count ?? 15)))
      const result = channel.kind === 'group'
        ? await client.call<{ messages?: OneBotEvent[] }>('get_group_msg_history', { group_id: Number(channel.id), count })
        : await client.call<{ messages?: OneBotEvent[] }>('get_friend_msg_history', { user_id: Number(channel.id), count })
      const messages = (result?.messages ?? []).slice(-count)
      const lines = messages.map((event) => {
        const userId = String(event.user_id ?? event.sender?.user_id ?? '')
        const who = userId === config.account ? 'you' : userId === config.owner ? `${config.ownerName} (owner)` : `${displayNameOf(event)} [qq ${userId}]`
        const { text, replyTo } = renderSegments(segmentsOf(event.message), renderIn(session.channelKey))
        keep(String(event.message_id ?? ''), userId === config.account ? 'you' : who, text)
        const when = typeof event.time === 'number' ? formatLocal(event.time * 1000) : '?'
        return `${when} ${who} [msg ${String(event.message_id)}]: ${replyTo === undefined ? '' : `${replyLabel(replyTo, recent.get(replyTo))} `}${text}`
      })
      return { lines }
    },
  }), { platform: PLATFORM, effect: 'observe', sessions: ['conversation'] })

  /** The channel key of the calling conversation, and the channel. */
  function sessionChat(exec: ToolExecution): { channel: PublishedChannel; key: string } {
    const channel = sessionChannel(exec.agent?.id)
    return { channel, key: qqChannelKey(config.account, channel.kind as 'private' | 'group', channel.id) }
  }

  /** Refuse when the chat's model route cannot take images (as DSH's read_image does), before anything enters history. */
  async function assertVision(exec: ToolExecution): Promise<void> {
    const agent = exec.agent as unknown as { session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }; options?: { provider?: string; model?: string } } | undefined
    const routed = agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? agent?.options?.provider
    const model = routed?.model ?? agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) {
      throw new AnimaError('anima/no-vision', 'the model of this chat could not be determined, so the image is not shown.')
    }
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (info.inputModalities?.includes('image') !== true) {
      throw new AnimaError('anima/no-vision', `this chat's model (${model}) cannot see images; the image was not opened. Its placeholder text is all there is.`)
    }
  }

  /** The bytes of an image: its URL first, then `get_image` through the runtime. */
  async function imageBytes(entry: MediaEntry, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const { maxBytes, fetchTimeoutSeconds } = config.look
    const timeout = fetchTimeoutSeconds * 1000
    const problems: string[] = []
    if (entry.url !== undefined) {
      try {
        return await fetchCapped(entry.url, maxBytes, timeout, signal)
      } catch (error: unknown) {
        problems.push(`url: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (entry.file !== undefined) {
      try {
        const info = await client.call<{ base64?: string; url?: string }>('get_image', { file: entry.file })
        if (typeof info?.base64 === 'string' && info.base64 !== '') {
          const data = Buffer.from(info.base64, 'base64')
          if (data.byteLength > maxBytes) throw new Error(`the image is more than the ${maxBytes} bytes allowed`)
          return new Uint8Array(data)
        }
        if (typeof info?.url === 'string' && /^https?:\/\//.test(info.url)) return await fetchCapped(info.url, maxBytes, timeout, signal)
        problems.push('get_image gave no bytes or http URL')
      } catch (error: unknown) {
        if (error instanceof Error && /bytes allowed/.test(error.message)) throw new AnimaError('anima/look-too-large', error.message)
        problems.push(`get_image: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const tooLarge = problems.find(p => /bytes allowed/.test(p))
    if (tooLarge !== undefined) throw new AnimaError('anima/look-too-large', `${tooLarge.replace(/^url: /, '')}.`)
    throw new AnimaError('anima/look-failed', `the image could not be fetched (${problems.join('; ') || 'no source'}). It may have expired on QQ.`)
  }

  core.registerBehavior(defineTool({
    name: LOOK_TOOL,
    description: 'Look at an image or sticker someone sent in this chat, by the id in its placeholder (e.g. "#i3" in "[image #i3: …]"). You see the picture itself. Only open what you want to see; each look costs.',
    parameters: {
      id: { type: 'string', required: true, description: 'The image id from the placeholder, e.g. "#i3".' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: 'The image id.' },
          kind: { type: 'string', required: true, description: 'image or sticker.' },
          summary: { type: 'string', description: 'The runtime\'s summary, if any.' },
          image: {
            type: 'object', additionalProperties: false, required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `The ${value.kind} #${value.id}${value.summary === undefined ? '' : ` (${value.summary})`}, ${value.image.width}x${value.image.height} px:` },
        { type: 'image', attachment: value.image as unknown as ImageAttachmentRef },
      ],
    },
    async execute(args, exec) {
      const { key } = sessionChat(exec)
      const entry = media.get(key, args.id)
      if (entry === undefined || entry.kind === 'forward') {
        throw new AnimaError('anima/no-image', `there is no image "${normalizeMediaId(args.id)}" in this chat. Use the id shown in an image placeholder here, e.g. #i3.`)
      }
      await assertVision(exec)
      let ref = entry.ref as ImageAttachmentRef | undefined
      if (ref === undefined) {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new AnimaError('anima/no-attachments', 'DSH has no attachment service, so images cannot be shown to a model.')
        const data = await imageBytes(entry, exec.signal)
        const mediaType = sniffImage(data)
        if (mediaType === undefined) throw new AnimaError('anima/look-failed', 'the file is not a PNG, JPEG, GIF or WebP image.')
        try {
          ref = await attachments.saveImage({ data, mediaType, name: `qq-${entry.id}.${mediaType.slice(6)}` })
        } catch (error: unknown) {
          throw new AnimaError('anima/look-failed', `the image could not be stored for viewing: ${error instanceof Error ? error.message : String(error)}`)
        }
        media.setRef(entry, { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...ref.name === undefined ? {} : { name: ref.name } })
      }
      const summary = entry.summary?.replace(/^\[(.*)\]$/, '$1').trim()
      return {
        id: entry.id, kind: entry.kind, ...summary === undefined || summary === '' ? {} : { summary },
        image: { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, ...ref.name === undefined ? {} : { name: ref.name } },
      }
    },
  }), { platform: PLATFORM, effect: 'observe', sessions: ['conversation'] })

  /** Lines of forwarded messages, capped; nested forwards are shown inline. */
  function forwardLines(messages: readonly unknown[], chat: string, depth: number, out: string[], budget: { messages: number; chars: number; hidden: number }): void {
    for (const raw of messages) {
      const node = raw as OneBotEvent & { data?: { nickname?: string; user_id?: number | string; content?: unknown; message?: unknown } }
      const isNode = node.type === 'node' && node.data !== undefined
      const name = isNode ? String(node.data!.nickname ?? node.data!.user_id ?? '?') : (displayNameOf(node) || '?')
      const segments = segmentsOf(isNode ? node.data!.content ?? node.data!.message : node.message)
      if (budget.messages <= 0 || budget.chars <= 0) {
        budget.hidden += 1
        continue
      }
      const inner = depth < 2 ? segments.filter(seg => seg.type === 'forward' && Array.isArray(seg.data.content)) : []
      const text = renderSegments(segments.filter(seg => !inner.includes(seg)), renderIn(chat)).text
      const line = `${'  '.repeat(depth)}${name}: ${inner.length > 0 && text === '[empty message]' ? '[forwarded messages]' : text}`
      const fits = [...line].slice(0, budget.chars).join('')
      out.push(fits.length < line.length ? `${fits}…` : line)
      budget.messages -= 1
      budget.chars -= fits.length
      for (const seg of inner) forwardLines(seg.data.content as unknown[], chat, depth + 1, out, budget)
    }
  }

  core.registerBehavior(defineTool({
    name: FORWARD_TOOL,
    description: 'Read a forwarded chat record someone sent in this chat, by the id in its placeholder (e.g. "#f2" in "[forwarded messages #f2]").',
    parameters: {
      id: { type: 'string', required: true, description: 'The forward id from the placeholder, e.g. "#f2".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' }, required: true, description: 'One line per forwarded message.' } } },
      render: (args, value) => [{ type: 'text', text: value.lines.length === 0 ? 'The forward is empty.' : `Forwarded messages #${normalizeMediaId(args.id)}:\n${value.lines.join('\n')}` }],
    },
    async execute(args, exec) {
      const { key } = sessionChat(exec)
      const entry = media.get(key, args.id)
      if (entry === undefined || entry.kind !== 'forward') {
        throw new AnimaError('anima/no-forward', `there is no forward "${normalizeMediaId(args.id)}" in this chat. Use the id shown in a forward placeholder here, e.g. #f2.`)
      }
      let messages = media.content(entry.id)
      if (messages === undefined) {
        if (entry.forwardId === undefined) throw new AnimaError('anima/forward-failed', 'this forward can no longer be fetched.')
        try {
          const result = await client.call<{ messages?: unknown[]; message?: unknown[] }>('get_forward_msg', { id: entry.forwardId, message_id: entry.forwardId })
          messages = result?.messages ?? result?.message ?? []
        } catch (error: unknown) {
          if (error instanceof AnimaError && error.code === 'anima/qq-offline') throw error
          throw new AnimaError('anima/forward-failed', `the forward could not be fetched (${error instanceof Error ? error.message.replace(/^[a-z]+\/[a-z-]+:\s*/, '') : String(error)}). It may have expired on QQ.`)
        }
      }
      const lines: string[] = []
      const budget = { messages: config.forward.maxMessages, chars: config.forward.maxChars, hidden: 0 }
      forwardLines(messages, key, 0, lines, budget)
      if (budget.hidden > 0) lines.push(`(${budget.hidden} more message${budget.hidden === 1 ? '' : 's'} not shown)`)
      return { lines }
    },
  }), { platform: PLATFORM, effect: 'observe', sessions: ['conversation'] })

  core.registerBehavior(defineTool({
    name: POKE_TOOL,
    description: 'Poke someone in this QQ chat (a light nudge, no text). In a private chat it pokes the other person; in a group give their user id.',
    parameters: {
      userId: { type: 'string', description: 'QQ user id to poke (groups: required; private chats: only the other person).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { poked: { type: 'string', required: true, description: 'Who was poked.' } } },
      render: (_args, value) => [{ type: 'text', text: `poked ${value.poked}` }],
    },
    async execute(args, exec) {
      const { channel } = sessionChat(exec)
      const userId = args.userId?.trim() || (channel.kind === 'private' ? channel.id : '')
      if (!/^\d{4,12}$/.test(userId)) throw new AnimaError('anima/bad-args', channel.kind === 'group' ? 'in a group, qq_poke needs the user id of the person (digits, as shown with each message).' : 'userId must be digits.')
      if (channel.kind === 'private' && userId !== channel.id) throw new AnimaError('anima/bad-args', 'in a private chat you can only poke the person you are talking with.')
      if (userId === config.account) throw new AnimaError('anima/bad-args', 'you cannot poke yourself.')
      if (!login.ready) throw new AnimaError('anima/qq-offline', `QQ is not ready (${offline.reason}); nobody was poked.`)
      if (channel.kind === 'group') await client.call('group_poke', { group_id: Number(channel.id), user_id: Number(userId) })
      else await client.call('friend_poke', { user_id: Number(userId) })
      return { poked: whoIs(userId) }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  core.registerBehavior(defineTool({
    name: REACT_TOOL,
    description: 'React to a message in this QQ chat with one emoji (e.g. "👍", "😂", "❤️"), by its msg id. Lighter than a reply.',
    parameters: {
      messageId: { type: 'string', required: true, description: 'The "msg" number shown with the message.' },
      emoji: { type: 'string', required: true, description: 'One emoji character, or a QQ face id (1–3 digits).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { reacted: { type: 'string', required: true, description: 'The emoji.' } } },
      render: (args, value) => [{ type: 'text', text: `reacted ${value.reacted} to msg ${args.messageId}` }],
    },
    async execute(args, exec) {
      sessionChat(exec)
      if (!/^-?\d{1,20}$/.test(args.messageId.trim())) throw new AnimaError('anima/bad-args', 'messageId is the "msg" number shown with a message.')
      const id = emojiId(args.emoji)
      if (id === undefined) throw new AnimaError('anima/bad-args', 'emoji must be exactly one emoji character (like 👍) or a QQ face id of 1–3 digits.')
      if (!login.ready) throw new AnimaError('anima/qq-offline', `QQ is not ready (${offline.reason}); no reaction was sent.`)
      await client.call('set_msg_emoji_like', { message_id: Number(args.messageId.trim()), emoji_id: id, set: true })
      return { reacted: args.emoji.trim() }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  core.addStatus(() => [
    ...offline.down ? [`QQ OFFLINE since ${formatLocal(offline.since)}: ${offline.reason}`] : [],
    ...statusLines(config, client.health, login, counts),
  ])
  // Owner surface shared with the Anima page (DESIGN §12); the access token is never shown.
  core.providePlatform({
    platform: PLATFORM,
    title: 'QQ',
    view: () => {
      const { health } = client
      const ok = login.ready && health.state === 'open' && health.online !== false
      return {
        health: ok ? 'ok' : health.state === 'open' ? 'warn' : 'down',
        summary: `${offline.down ? `OFFLINE since ${formatLocal(offline.since)}: ${offline.reason}. ` : ''}${statusLines(config, health, login, counts)[0]!.replace(/^QQ: /, '')}`,
        details: {
          offline: offline.down ? { since: offline.since, reason: offline.reason } : null,
          url: config.url,
          account: config.account,
          nickname: login.nickname ?? null,
          state: health.state,
          online: health.online ?? null,
          lastHeartbeat: health.lastHeartbeat ?? null,
          connects: health.connects,
          lastError: health.lastError ?? null,
          problem: login.problem ?? null,
          allowlist: { owner: config.owner, users: config.allow.users, groups: config.allow.groups },
          traffic: { ...counts },
        },
      }
    },
  })
  life.addReportLine(() => {
    const { health } = client
    if (!offline.down) return []
    return [`QQ is offline since ${formatLocal(offline.since)} (${offline.reason}); messages there cannot be sent or received now.`]
  })
}

function ago(at: number | undefined): string {
  return at === undefined ? 'never' : `${Math.round((Date.now() - at) / 1000)} s ago`
}

/** `/anima status` lines of the QQ adapter. */
export function statusLines(config: ResolvedQqConfig, health: Health, login: { ready: boolean; nickname?: string | undefined; problem?: string | undefined }, counts: { delivered: number; dropped: number; sent: number }): string[] {
  const state = health.state === 'open'
    ? `connected to ${config.url} as ${config.account}${login.nickname === undefined ? '' : ` (${login.nickname})`}${login.ready ? '' : ', not ready'}`
    : `${health.state}${health.retryInMs === undefined ? '' : `, retry in ${Math.round(health.retryInMs / 1000)} s`}`
  return [
    `QQ: ${state}; account ${health.state !== 'open' ? 'status unknown while disconnected' : health.online === false ? 'OFFLINE' : health.online === true ? 'online' : 'status unknown'}; last heartbeat ${ago(health.lastHeartbeat)}; connects ${health.connects}`,
    ...login.problem === undefined ? [] : [`QQ problem: ${login.problem}`],
    ...health.lastError === undefined ? [] : [`QQ last error: ${health.lastError}`],
    `QQ allowlist: owner ${config.owner}; users ${config.allow.users.map(u => u.id).join(', ') || 'none'}; groups ${config.allow.groups.map(g => g.id).join(', ') || 'none'}`,
    `QQ traffic: delivered ${counts.delivered}, dropped (not allowlisted) ${counts.dropped}, sent ${counts.sent}`,
  ]
}
