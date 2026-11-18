/**
 * QQ adapter (docs/design/channels.md). It reaches her QQ account through a
 * {@link QqBackend} (today OneBot v11: NotRainMeow, or any OneBot v11 runtime),
 * publishes every friend and group, turns messages, pokes, recalls and friend
 * requests into stimuli, and registers `qq_say` and the other QQ behaviors; a
 * behavior the backend cannot do is not registered. The owner's private chat is
 * the owner line. Nothing here knows the backend's protocol.
 * @module @anima/adapter-qq
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AnimaError, formatLocal, SAY_META, SAY_PARAMETERS, sayMessages } from '@anima/core'
import type {} from '@anima/core'
import { paceMessages, type PublishedChannel } from '@anima/life'
import type {} from '@anima/life'
import type { ChatKind, ForwardNode, Health, OutgoingSegment, QqBackend, QqEvent, QqMessage } from './backend.ts'
import { Config as ConfigSchema, resolveQqConfig, type BackendConfig, type Config as QqConfig, type ResolvedQqConfig } from './config.ts'
import { normalizeMessage, outgoing, renderSegments, type NormalizedMessage } from './normalize.ts'
import { fetchCapped, MediaBook, normalizeMediaId, reactionOf, sniffImage, type MediaEntry } from './media.ts'
import { OneBotBackend } from './onebot/backend.ts'

export type { BackendHandlers, ChatKind, ForwardNode, Health, OutgoingSegment, QqBackend, QqEvent, QqMessage, QqSegment } from './backend.ts'
export { resolveQqConfig, type BackendConfig, type ResolvedQqConfig } from './config.ts'
export { normalizeMessage, outgoing, renderSegments, type MediaKind, type NormalizedMessage, type RenderContext, type Rendered } from './normalize.ts'
export { MediaBook, normalizeMediaId, reactionOf, sniffImage, type MediaEntry } from './media.ts'
export { OneBotBackend, type OneBotOptions } from './onebot/backend.ts'
export { authHeaders, backoff, OneBotClient, type ClientOptions } from './onebot/client.ts'
export { emojiId, oneBotSegments, parseCQ, qqMessage, qqSegments, segmentsOf } from './onebot/segments.ts'

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

/**
 * A QQ chat as a published channel; the owner's private chat is marked as hers.
 * @param config - adapter config.
 * @param kind - private or group.
 * @param id - the other person's user id, or the group id.
 * @param name - display name, when known.
 */
export function qqChannel(config: ResolvedQqConfig, kind: 'private' | 'group', id: string, name?: string): PublishedChannel {
  const base = { platform: PLATFORM, account: config.account, kind, id }
  if (kind === 'private' && id === config.owner) return { ...base, display: `${config.ownerName} (QQ)`, isOwner: true }
  return { ...base, display: `${name === undefined || name === '' ? kind === 'group' ? `group ${id}` : `QQ ${id}` : name} (QQ)` }
}

/**
 * The backend for a config's `backend` section: one implementation per protocol.
 * @param config - the validated `backend` section.
 */
export function createBackend(config: BackendConfig): QqBackend {
  switch (config.protocol) {
    case 'onebot11': return new OneBotBackend({
      url: config.url,
      accessToken: config.accessToken,
      callTimeoutMs: config.callTimeoutSeconds * 1000,
      maxBackoffMs: config.reconnect.maxSeconds * 1000,
      heartbeatGrace: config.heartbeatGrace,
    })
  }
}

/**
 * Register the QQ adapter.
 * @param ctx - root context.
 * @param input - plugin config.
 */
export function apply(ctx: Context, input: Partial<Config> | undefined): void {
  const config = resolveQqConfig(input)
  attach(ctx, config, createBackend(config.backend))
}

/**
 * Register the QQ adapter over a given backend (tests pass a fake one).
 * @param ctx - root context.
 * @param config - validated adapter config.
 * @param backend - the runtime that holds her account; started and stopped here.
 */
export function attach(ctx: Context, config: ResolvedQqConfig, backend: QqBackend): void {
  const core = ctx.anima
  const life = ctx.animaLife
  const herName = core.config.name

  // Every chat of the account is published; which ones may reach her is the guard's allowlist, outside.
  const byKey = new Map<string, PublishedChannel>()
  const channelOf = (kind: 'private' | 'group', id: string, name?: string): PublishedChannel => {
    const key = qqChannelKey(config.account, kind, id)
    const known = byKey.get(key)
    if (known !== undefined) return known
    const channel = qqChannel(config, kind, id, name)
    byKey.set(key, channel)
    life.publish([channel])
    return channel
  }
  channelOf('private', config.owner)

  const names = new Map<string, string>()
  const sentIds = new Set<string>()
  const remember = (id: string) => {
    sentIds.add(id)
    if (sentIds.size > SENT_IDS) sentIds.delete(sentIds.values().next().value!)
  }
  const login = { ready: false, nickname: undefined as string | undefined, problem: undefined as string | undefined }
  const counts = { delivered: 0, sent: 0, typing: 0, read: 0 }
  const media = new MediaBook(join(core.config.dataDir, 'qq', 'media.json'), config.look.cacheEntries)
  /** Rendering for one chat: images, stickers and forwards get ids that belong to it. */
  const renderIn = (chat: string) => ({
    selfId: config.account, herName, name: (id: string) => names.get(id),
    ref: (kind: Parameters<MediaBook['idFor']>[1], source: Parameters<MediaBook['idFor']>[2]) => media.idFor(chat, kind, source),
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

  ctx.effect(() => {
    backend.start({
      open: () => { void verifyLogin().finally(updateHealth) },
      close: () => {
        login.ready = false
        updateHealth()
      },
      health: () => updateHealth(),
      event: (event) => {
        // One at a time, so a group's messages reach her in order.
        queue = queue.then(() => handle(event)).catch((error: unknown) => ctx.logger.warn(`anima qq: ${error instanceof Error ? error.message : String(error)}`))
      },
    })
    return () => backend.stop()
  }, 'anima-adapter-qq.backend')

  /** Why QQ is not usable now, or undefined when it is. */
  function downReason(): string | undefined {
    const { health } = backend
    if (health.state !== 'open') return `${health.lastError ?? 'not connected'} (${health.state}${health.retryInMs === undefined ? '' : `, retry in ${Math.round(health.retryInMs / 1000)} s`})`
    if (login.problem !== undefined) return login.problem
    if (!login.ready) return 'connected, checking the login'
    if (health.online === false) return `the runtime reports the QQ account offline${health.lastError === undefined ? '' : ` (${health.lastError})`}`
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
      const info = await backend.login()
      if (info.userId !== config.account) {
        login.ready = false
        login.problem = `the runtime is logged in as ${info.userId}, but the config says account ${config.account}; nothing is delivered or sent until they match.`
        ctx.logger.error(`anima qq: ${login.problem}`)
        return
      }
      login.nickname = info.nickname
      login.problem = undefined
      login.ready = true
      await publishChats()
    } catch (error: unknown) {
      login.problem = `the login check failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function send(kind: ChatKind, id: string, message: readonly OutgoingSegment[]): Promise<string> {
    if (!login.ready) throw new AnimaError('anima/qq-offline', `QQ is not ready (${login.problem ?? backend.health.lastError ?? backend.health.state}); the message was not sent.`)
    const messageId = await backend.send(kind, id, message)
    if (messageId !== '') remember(messageId)
    counts.sent += 1
    return messageId
  }

  // A chat that woke her is read, like a person opening it; held inbox messages never reach here (Phase 9).
  ctx.on('anima/read', ({ channel }) => {
    if (backend.markRead === undefined || !config.markRead || channel.platform !== PLATFORM || channel.account !== config.account || !login.ready) return
    counts.read += 1
    backend.markRead(channel.kind as ChatKind, channel.id).catch((error: unknown) => ctx.logger.debug(`anima qq: mark read: ${error instanceof Error ? error.message : String(error)}`))
  })

  /** Show typing in a private chat, when the backend can. */
  function showTyping(userId: string): void {
    if (backend.typing === undefined || !config.typing.enabled || !login.ready) return
    backend.typing(userId).catch((error: unknown) => ctx.logger.debug(`anima qq: typing: ${error instanceof Error ? error.message : String(error)}`))
  }

  // While the outside holds a message she started in a private chat, QQ shows typing shortly before it goes out.
  ctx.on('anima/outgoing-held', (held) => {
    const channel = byKey.get(held.channelKey)
    if (channel === undefined || channel.kind !== 'private' || !config.typing.enabled || backend.typing === undefined) return
    const typing = setTimeout(() => showTyping(channel.id), Math.max(0, held.sendsAt - Date.now() - config.typing.leadSeconds * 1000))
    void held.done.finally(() => clearTimeout(typing))
  })

  core.provideOwnerLine({
    name: `QQ private chat with the owner (${config.owner})`,
    send: async (text) => { await send('private', config.owner, [{ type: 'text', text }]) },
  })

  /** Who wrote a message, as she knows them. */
  function whoIs(userId: string, displayName?: string): string {
    if (userId === config.account) return 'you'
    if (userId === config.owner) return config.ownerName
    return names.get(userId) ?? displayName ?? userId
  }

  /**
   * A replied-to message: whether it is hers, and who wrote what. From the
   * recent-message cache, else the backend (the reply is always in the same chat).
   */
  async function quoted(messageId: string, chat: string): Promise<{ hers: boolean; who?: string; text?: string }> {
    const known = recent.get(messageId)
    if (known !== undefined) return { hers: known.who === 'you', who: known.who, text: known.text }
    try {
      const msg = await backend.message?.(messageId)
      if (msg === undefined) return { hers: sentIds.has(messageId) }
      const who = whoIs(msg.userId, msg.displayName)
      const text = renderSegments(msg.segments, renderIn(chat)).text
      keep(messageId, who, text)
      return { hers: msg.userId === config.account, who, text }
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

  /** Publish every friend and group of the account. */
  async function publishChats(): Promise<void> {
    try {
      for (const friend of await backend.friends()) channelOf('private', friend.userId, friend.name)
    } catch (error: unknown) {
      ctx.logger.warn(`anima qq: friend list: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      for (const group of await backend.groups()) channelOf('group', group.groupId, group.name)
    } catch (error: unknown) {
      ctx.logger.warn(`anima qq: group list: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function deliverMessage(message: NormalizedMessage): Promise<void> {
    const channel = channelOf(message.kind, message.chatId, message.kind === 'private' ? message.displayName : undefined)
    names.set(message.userId, message.displayName)
    const isOwner = message.userId === config.owner
    if (isOwner && message.kind === 'private') {
      // The outside consumes owner replies such as "yes a3"; then they never reach her.
      const answer = ctx.bail('anima/owner-message', message.text)
      if (answer !== undefined) {
        await send('private', config.owner, [{ type: 'text', text: answer }])
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

  async function handle(event: QqEvent): Promise<void> {
    if (!login.ready) return
    switch (event.type) {
      case 'message': {
        const { message } = event
        if (message.userId === config.account) return
        const normalized = normalizeMessage(message, renderIn(qqChannelKey(config.account, message.kind, message.chatId)))
        return deliverMessage(normalized)
      }
      case 'typing': {
        // The other person is typing in a private chat (Phase 9).
        if (event.userId === config.account) return
        const typingIn = channelOf('private', event.userId)
        if (event.typing) life.typing(typingIn)
        counts.typing += 1
        return
      }
      case 'poke': {
        if (event.targetId !== config.account || event.userId === config.account) return
        const channel = channelOf(event.kind, event.chatId)
        const isOwner = event.userId === config.owner
        counts.delivered += 1
        await life.deliver({
          type: 'message', channel,
          sender: { platformUserId: event.userId, displayName: isOwner ? config.ownerName : names.get(event.userId) ?? event.userId, isOwner },
          text: '[戳了戳你]', ts: core.clock.now(),
          ...channel.kind === 'group' ? { addressed: true } : {},
        })
        return
      }
      case 'recall': {
        if (event.operatorId === config.account) return
        const channel = channelOf(event.kind, event.chatId)
        const who = event.operatorId === config.owner ? config.ownerName : names.get(event.operatorId) ?? event.operatorId
        await life.deliver({ type: 'channel-event', channel, text: `${who} recalled a message (msg ${event.messageId}).`, ts: core.clock.now() })
        return
      }
      case 'friend-request':
        // Not awaited: the owner's answer arrives as a later event on this same queue.
        friendRequest(event).catch((error: unknown) => ctx.logger.warn(`anima qq: friend request: ${error instanceof Error ? error.message : String(error)}`))
        return
      case 'group-invite':
        life.note(`QQ user ${event.userId} invited you to group ${event.groupId}. You do not join groups yourself; the owner decides.`)
    }
  }

  async function friendRequest(event: Extract<QqEvent, { type: 'friend-request' }>): Promise<void> {
    const { userId, comment, answer } = event
    const who = `QQ user ${userId}${comment === '' ? '' : ` ("${comment}")`}`
    // Whoever handles friend requests outside the persona answers it; without anyone, or when the backend cannot answer, it stays unanswered.
    const taken = answer !== undefined && ctx.bail('anima/friend-request', {
      platform: PLATFORM, userId,
      summary: `${who} wants to add her (${config.account}) as a QQ friend.`,
      answer: async (accept) => {
        await answer(accept)
        life.note(`The owner ${accept ? 'accepted' : 'declined'} the QQ friend request from ${userId}.`)
      },
      leave: why => life.note(`The QQ friend request from ${userId} was left unanswered (${why}).`),
    }) === true
    life.note(taken ? `${who} asked to be your friend on QQ; the owner was asked to decide.` : `${who} asked to be your friend on QQ; it stays unanswered.`)
  }

  function sessionChannel(sessionId: string | undefined): PublishedChannel {
    const session = sessionId === undefined ? undefined : core.describeSession(sessionId)
    if (session?.kind !== 'conversation' || session.channel.platform !== PLATFORM) {
      throw new AnimaError('anima/no-channel', 'this session is not bound to a QQ chat.')
    }
    const channel = byKey.get(session.channelKey)
    if (channel === undefined) throw new AnimaError('anima/no-channel', 'this QQ chat is not known to the adapter.')
    return channel
  }

  core.registerBehavior(defineTool({
    name: SAY_TOOL,
    description: 'Send a message in this QQ chat, or a list of messages sent in order. They see only what you send this way. In groups you can reply to a message id and mention people by user id (both apply to the first message). A say ends your turn unless more: true.',
    parameters: {
      ...SAY_PARAMETERS,
      replyTo: { type: 'string', description: 'Optional message id to reply to (the "msg" number shown with each message).' },
      mention: { type: 'array', items: { type: 'string' }, description: 'Optional QQ user ids to @ before the text (groups only).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true, description: 'Whether the messages went out.' },
          messageId: { type: 'string', required: true, description: 'QQ message id of the (last) message you sent.' },
          messageIds: { type: 'array', items: { type: 'string' }, description: 'QQ message ids, when you sent several.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.messageIds === undefined ? `sent (msg ${value.messageId})` : `sent ${value.messageIds.length} messages (msg ${value.messageIds.join(', ')})` }],
    },
    async execute(args, exec) {
      const channel = sessionChannel(exec.agent?.id)
      const messages = sayMessages(args)
      if (messages.length === 0) throw new AnimaError('anima/empty-message', 'text is empty; to end the turn without speaking, call end_turn instead.')
      const mention = args.mention ?? []
      if (mention.length > 0 && channel.kind !== 'group') throw new AnimaError('anima/bad-args', 'mention works only in group chats.')
      if (mention.some(id => !/^\d{4,12}$/.test(id))) throw new AnimaError('anima/bad-args', 'mention takes QQ user ids (digits), as shown with each message.')
      const ids: string[] = []
      // Messages after the first wait a typing time from their length, with typing shown in private chats (Phase 9).
      await paceMessages(messages, config.pacing, async (index, text) => {
        try {
          const id = await send(channel.kind as ChatKind, channel.id, outgoing(text, index === 0 ? { replyTo: args.replyTo, mention } : { mention: [] }))
          keep(id, 'you', text)
          ids.push(id)
        } catch (error: unknown) {
          if (ids.length === 0) throw error
          const reason = error instanceof Error ? error.message : String(error)
          throw new AnimaError('anima/partly-sent', `${ids.length} of ${messages.length} messages went out (msg ${ids.join(', ')}); message ${index + 1} failed: ${reason}`)
        }
      }, {
        beforeWait: () => {
          if (channel.kind === 'private') showTyping(channel.id)
        },
      })
      return { sent: true, messageId: ids.at(-1)!, ...ids.length > 1 ? { messageIds: ids } : {} }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'], ...SAY_META })

  if (backend.history !== undefined) core.registerBehavior(defineTool({
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
      const messages: readonly QqMessage[] = (await backend.history!(channel.kind as ChatKind, channel.id, count)).slice(-count)
      const lines = messages.map((message) => {
        const { userId } = message
        const who = userId === config.account ? 'you' : userId === config.owner ? `${config.ownerName} (owner)` : `${message.displayName} [qq ${userId}]`
        const { text, replyTo } = renderSegments(message.segments, renderIn(session.channelKey))
        keep(message.messageId, userId === config.account ? 'you' : who, text)
        const when = message.time === undefined ? '?' : formatLocal(message.time)
        return `${when} ${who} [msg ${message.messageId}]: ${replyTo === undefined ? '' : `${replyLabel(replyTo, recent.get(replyTo))} `}${text}`
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

  /** The bytes of an image: its URL first, then the backend by its file handle. */
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
    if (entry.file !== undefined && backend.image !== undefined) {
      try {
        const info = await backend.image(entry.file)
        if (info.bytes !== undefined) {
          if (info.bytes.byteLength > maxBytes) throw new Error(`the image is more than the ${maxBytes} bytes allowed`)
          return info.bytes
        }
        if (info.url !== undefined) return await fetchCapped(info.url, maxBytes, timeout, signal)
        problems.push('the runtime gave no bytes or http URL')
      } catch (error: unknown) {
        if (error instanceof Error && /bytes allowed/.test(error.message)) throw new AnimaError('anima/look-too-large', error.message)
        problems.push(`runtime: ${error instanceof Error ? error.message : String(error)}`)
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
  function forwardLines(nodes: readonly ForwardNode[], chat: string, depth: number, out: string[], budget: { messages: number; chars: number; hidden: number }): void {
    for (const node of nodes) {
      if (budget.messages <= 0 || budget.chars <= 0) {
        budget.hidden += 1
        continue
      }
      const inner = depth < 2 ? node.segments.filter(seg => seg.type === 'forward' && seg.content !== undefined) : []
      const text = renderSegments(node.segments.filter(seg => !inner.includes(seg)), renderIn(chat)).text
      const line = `${'  '.repeat(depth)}${node.name}: ${inner.length > 0 && text === '[empty message]' ? '[forwarded messages]' : text}`
      const fits = [...line].slice(0, budget.chars).join('')
      out.push(fits.length < line.length ? `${fits}…` : line)
      budget.messages -= 1
      budget.chars -= fits.length
      for (const seg of inner) if (seg.type === 'forward') forwardLines(seg.content!, chat, depth + 1, out, budget)
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
      let messages = media.content(entry.id) as readonly ForwardNode[] | undefined
      if (messages === undefined) {
        if (entry.forwardId === undefined || backend.forward === undefined) throw new AnimaError('anima/forward-failed', 'this forward can no longer be fetched.')
        try {
          messages = await backend.forward(entry.forwardId)
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

  if (backend.poke !== undefined) core.registerBehavior(defineTool({
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
      await backend.poke!(channel.kind as ChatKind, channel.id, userId)
      return { poked: whoIs(userId) }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  if (backend.react !== undefined) core.registerBehavior(defineTool({
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
      const reaction = reactionOf(args.emoji)
      if (reaction === undefined) throw new AnimaError('anima/bad-args', 'emoji must be exactly one emoji character (like 👍) or a QQ face id of 1–3 digits.')
      if (!login.ready) throw new AnimaError('anima/qq-offline', `QQ is not ready (${offline.reason}); no reaction was sent.`)
      await backend.react!(args.messageId.trim(), reaction)
      return { reacted: reaction }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  core.addStatus(() => [
    ...offline.down ? [`QQ OFFLINE since ${formatLocal(offline.since)}: ${offline.reason}`] : [],
    ...statusLines(config, backend, login, counts),
  ])
  // Owner surface shared with the Anima page (DESIGN §12); the access token is never shown.
  core.providePlatform({
    platform: PLATFORM,
    title: 'QQ',
    view: () => {
      const { health } = backend
      const ok = login.ready && health.state === 'open' && health.online !== false
      return {
        health: ok ? 'ok' : health.state === 'open' ? 'warn' : 'down',
        summary: `${offline.down ? `OFFLINE since ${formatLocal(offline.since)}: ${offline.reason}. ` : ''}${statusLines(config, backend, login, counts)[0]!.replace(/^QQ: /, '')}`,
        details: {
          offline: offline.down ? { since: offline.since, reason: offline.reason } : null,
          backend: backend.name,
          account: config.account,
          nickname: login.nickname ?? null,
          state: health.state,
          online: health.online ?? null,
          lastHeartbeat: health.lastHeartbeat ?? null,
          connects: health.connects,
          lastError: health.lastError ?? null,
          problem: login.problem ?? null,
          chats: { owner: config.owner, friends: [...byKey.values()].filter(c => c.kind === 'private').length, groups: [...byKey.values()].filter(c => c.kind === 'group').length },
          traffic: { ...counts },
        },
      }
    },
  })
  life.addReportLine(() => {
    if (!offline.down) return []
    return [`QQ is offline since ${formatLocal(offline.since)} (${offline.reason}); messages there cannot be sent or received now.`]
  })
}

function ago(at: number | undefined): string {
  return at === undefined ? 'never' : `${Math.round((Date.now() - at) / 1000)} s ago`
}

/** `/anima status` lines of the QQ adapter. */
export function statusLines(config: ResolvedQqConfig, backend: { readonly name: string; readonly health: Health }, login: { ready: boolean; nickname?: string | undefined; problem?: string | undefined }, counts: { delivered: number; sent: number }): string[] {
  const { health } = backend
  const state = health.state === 'open'
    ? `connected to ${backend.name} as ${config.account}${login.nickname === undefined ? '' : ` (${login.nickname})`}${login.ready ? '' : ', not ready'}`
    : `${health.state}${health.retryInMs === undefined ? '' : `, retry in ${Math.round(health.retryInMs / 1000)} s`}`
  return [
    `QQ: ${state}; account ${health.state !== 'open' ? 'status unknown while disconnected' : health.online === false ? 'OFFLINE' : health.online === true ? 'online' : 'status unknown'}; last heartbeat ${ago(health.lastHeartbeat)}; connects ${health.connects}`,
    ...login.problem === undefined ? [] : [`QQ problem: ${login.problem}`],
    ...health.lastError === undefined ? [] : [`QQ last error: ${health.lastError}`],
    `QQ traffic: delivered ${counts.delivered}, sent ${counts.sent}`,
  ]
}
