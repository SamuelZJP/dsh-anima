/**
 * QQ adapter (DESIGN §11) over OneBot v11. It connects as a WebSocket client
 * to the runtime's forward WebSocket server (NapCatQQ, or any OneBot v11
 * runtime), turns private and group messages, pokes, recalls and friend
 * requests from allowlisted chats into stimuli, and registers `qq_say` and
 * `qq_history`. The owner's private chat is the owner line for approvals.
 * @module @anima/adapter-qq
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AnimaError, formatLocal } from '@anima/core'
import type {} from '@anima/core'
import type { PublishedChannel } from '@anima/life'
import type {} from '@anima/life'
import { Config as ConfigSchema, resolveQqConfig, type Config as QqConfig, type ResolvedQqConfig } from './config.ts'
import { displayNameOf, normalizeMessage, outgoing, renderSegments, segmentsOf, type NormalizedMessage, type OneBotEvent, type Segment } from './normalize.ts'
import { OneBotClient, type Health } from './onebot.ts'

export { resolveQqConfig, type AllowEntry, type ResolvedQqConfig } from './config.ts'
export { displayNameOf, normalizeMessage, outgoing, parseCQ, renderSegments, segmentsOf, type NormalizedMessage, type OneBotEvent, type RenderContext, type Rendered, type Segment } from './normalize.ts'
export { backoff, connectUrl, OneBotClient, type ClientOptions, type Health } from './onebot.ts'

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

/** Plugin config. */
export type Config = QqConfig
/** Plugin config schema. */
export const Config = ConfigSchema

/** Message ids she sent, to recognize replies to her. */
const SENT_IDS = 500
/** Most messages `qq_history` returns. */
const HISTORY_MAX = 30

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
  const render = { selfId: config.account, herName, name: (id: string) => names.get(id) }
  let queue: Promise<void> = Promise.resolve()

  const client = new OneBotClient({
    url: config.url,
    accessToken: config.accessToken,
    callTimeoutMs: config.callTimeoutSeconds * 1000,
    maxBackoffMs: config.reconnect.maxSeconds * 1000,
    heartbeatGrace: config.heartbeatGrace,
    onOpen: () => { void verifyLogin() },
    onClose: () => { login.ready = false },
    onEvent: (event) => {
      // One at a time, so a group's messages reach her in order.
      queue = queue.then(() => handle(event)).catch((error: unknown) => ctx.logger.warn(`anima qq: ${error instanceof Error ? error.message : String(error)}`))
    },
  })
  ctx.effect(() => {
    client.start()
    return () => client.stop()
  }, 'anima-adapter-qq.client')

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

  /** Whether a replied-to message is one of hers. */
  async function isHers(messageId: string): Promise<boolean> {
    if (sentIds.has(messageId)) return true
    try {
      const msg = await client.call<{ sender?: { user_id?: number | string }; user_id?: number | string }>('get_msg', { message_id: Number(messageId) })
      return String(msg?.sender?.user_id ?? msg?.user_id) === config.account
    } catch {
      return false
    }
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
    const addressed = message.kind === 'group'
      ? message.mentionsHer || (message.replyTo !== undefined && await isHers(message.replyTo))
      : undefined
    const text = message.replyTo === undefined ? message.text : `(replying to msg ${message.replyTo}) ${message.text}`
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
        const message = normalizeMessage(event, render)
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
      await life.holdOutgoing(exec.agent!.id, args.text)
      const messageId = await send(channel.kind as 'private' | 'group', channel.id, outgoing(args.text, { replyTo: args.replyTo, mention }))
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
      const count = Math.max(1, Math.min(HISTORY_MAX, Math.round(args.count ?? 15)))
      const result = channel.kind === 'group'
        ? await client.call<{ messages?: OneBotEvent[] }>('get_group_msg_history', { group_id: Number(channel.id), count })
        : await client.call<{ messages?: OneBotEvent[] }>('get_friend_msg_history', { user_id: Number(channel.id), count })
      const messages = (result?.messages ?? []).slice(-count)
      const lines = messages.map((event) => {
        const userId = String(event.user_id ?? event.sender?.user_id ?? '')
        const who = userId === config.account ? 'you' : userId === config.owner ? `${config.ownerName} (owner)` : `${displayNameOf(event)} [qq ${userId}]`
        const { text, replyTo } = renderSegments(segmentsOf(event.message), render)
        const when = typeof event.time === 'number' ? formatLocal(event.time * 1000) : '?'
        return `${when} ${who} [msg ${String(event.message_id)}]: ${replyTo === undefined ? '' : `(replying to msg ${replyTo}) `}${text}`
      })
      return { lines }
    },
  }), { platform: PLATFORM, effect: 'observe', sessions: ['conversation'] })

  core.addStatus(() => statusLines(config, client.health, login, counts))
  life.addReportLine(() => {
    const { health } = client
    if (login.ready && health.state === 'open' && health.online !== false) return []
    return [`QQ is offline since ${formatLocal(health.since)}; messages there cannot be sent or received now.`]
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
    `QQ: ${state}; account ${health.online === false ? 'OFFLINE' : health.online === true ? 'online' : 'status unknown'}; last heartbeat ${ago(health.lastHeartbeat)}; connects ${health.connects}`,
    ...login.problem === undefined ? [] : [`QQ problem: ${login.problem}`],
    ...health.lastError === undefined ? [] : [`QQ last error: ${health.lastError}`],
    `QQ allowlist: owner ${config.owner}; users ${config.allow.users.map(u => u.id).join(', ') || 'none'}; groups ${config.allow.groups.map(g => g.id).join(', ') || 'none'}`,
    `QQ traffic: delivered ${counts.delivered}, dropped (not allowlisted) ${counts.dropped}, sent ${counts.sent}`,
  ]
}
