/**
 * Development adapter over the DSH web UI (DESIGN §11). The owner's channel,
 * plus test channels: `/anima chat [--as <name>] [--in group:<id>] <text>` is an
 * incoming message from the owner or a simulated person, in a private chat or a
 * simulated group. `local_say` is her outgoing speech, appended to
 * `<dataDir>/local/outbox.jsonl`.
 * @module @anima/adapter-local
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AnimaError } from '@anima/core'
import type {} from '@anima/core'
import type { PublishedChannel } from '@anima/life'
import type {} from '@anima/life'

/** Cordis plugin name. */
export const name = 'anima-adapter-local'
/** Services used by the plugin. */
export const inject = ['anima', 'animaLife', 'tools']

/** Platform id and tool prefix. */
export const PLATFORM = 'local'
/** The say behavior. */
export const SAY_TOOL = 'local_say'

/** Plugin config. */
export interface Config {
  /** How she sees the owner's name in messages. */
  ownerName: string
}

/** Plugin config schema. */
export const Config: z<Config> = z.object({
  ownerName: z.string().default('Owner').description('Owner display name in local messages.'),
}) as z<Config>

/** The single local channel: a private chat with the owner. */
export const OWNER_CHANNEL: PublishedChannel = {
  platform: PLATFORM, account: 'owner', kind: 'private', id: 'owner', display: 'Owner (local)', isOwner: true,
}

/** Parsed `/anima chat` arguments. */
export interface ChatArgs {
  /** Simulated sender name; the owner when undefined. */
  readonly as?: string | undefined
  /** Simulated group id; a private chat when undefined. */
  readonly group?: string | undefined
  readonly text: string
}

/**
 * Parse `[--as <name>] [--in group:<id>] <text>`.
 * @returns the arguments, or an error hint.
 */
export function parseChat(args: string): ChatArgs | { error: string } {
  let rest = args.trim()
  let as: string | undefined
  let group: string | undefined
  for (;;) {
    const match = /^--(as|in)\s+(\S+)\s*/.exec(rest)
    if (match === null) break
    const [whole, flag, value] = match as unknown as [string, string, string]
    if (flag === 'as') {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value)) return { error: `--as needs a simple name like alice, got "${value}".` }
      if (value.toLowerCase() === 'owner') return { error: 'to speak as the owner, leave out --as.' }
      as = value
    } else {
      const g = /^group:([A-Za-z0-9_-]{1,32})$/.exec(value)
      if (g === null) return { error: `--in needs group:<id>, e.g. group:test, got "${value}".` }
      group = g[1]
    }
    rest = rest.slice(whole.length)
  }
  if (rest === '') return { error: 'Usage: /anima chat [--as <name>] [--in group:<id>] <text>' }
  return { as, group, text: rest }
}

/** Display name of a simulated person: `alice` → `Alice`. */
function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * The channel of a chat: the owner's, a private test chat with a person, or a test group.
 * @param chat - parsed arguments.
 */
export function chatChannel(chat: Pick<ChatArgs, 'as' | 'group'>): PublishedChannel {
  if (chat.group !== undefined) {
    return { platform: PLATFORM, account: 'owner', kind: 'group', id: chat.group, display: `group ${chat.group} (local)` }
  }
  if (chat.as === undefined) return OWNER_CHANNEL
  const id = chat.as.toLowerCase()
  return { platform: PLATFORM, account: 'owner', kind: 'private', id, display: `${displayName(chat.as)} (local)` }
}

/**
 * Whether a group message addresses her directly: `@<name>` or her name
 * (DESIGN §5 direct-address rule, as this dev adapter applies it).
 */
export function addressesHer(text: string, herName: string): boolean {
  return text.toLowerCase().includes(herName.toLowerCase())
}

/** Path of the remembered test channels. */
export function channelsPath(dataDir: string): string {
  return join(dataDir, 'local', 'channels.json')
}

/**
 * Path of the local outbox.
 * @param dataDir - Anima data directory.
 */
export function outboxPath(dataDir: string): string {
  return join(dataDir, 'local', 'outbox.jsonl')
}

/**
 * Register the local channel, `local_say` and `/anima chat`.
 * @param ctx - root context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  const ownerName = config?.ownerName ?? 'Owner'
  const outbox = outboxPath(ctx.anima.config.dataDir)

  const dataDir = ctx.anima.config.dataDir
  ctx.animaLife.publish([OWNER_CHANNEL])

  // Test channels survive a restart, so their sessions resolve to them again.
  const known = new Map<string, PublishedChannel>()
  const channelsFile = channelsPath(dataDir)
  if (existsSync(channelsFile)) {
    for (const channel of JSON.parse(readFileSync(channelsFile, 'utf8')) as PublishedChannel[]) known.set(`${channel.kind}:${channel.id}`, channel)
    ctx.animaLife.publish([...known.values()])
  }
  const remember = (channel: PublishedChannel) => {
    if (channel === OWNER_CHANNEL || known.has(`${channel.kind}:${channel.id}`)) return
    known.set(`${channel.kind}:${channel.id}`, channel)
    ctx.animaLife.publish([channel])
    mkdirSync(dirname(channelsFile), { recursive: true })
    writeFileSync(channelsFile, `${JSON.stringify([...known.values()], null, 2)}\n`)
  }

  ctx.anima.registerBehavior(defineTool({
    name: SAY_TOOL,
    description: 'Say something to the person in this local chat. One call sends one chat message; they see only what you send this way.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message, exactly as it should appear in the chat.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true, description: 'Whether the message was delivered.' },
          at: { type: 'string', required: true, description: 'Send time on her clock, ISO 8601.' },
        },
      },
      render: () => [{ type: 'text', text: 'sent' }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const session = sessionId === undefined ? undefined : ctx.anima.describeSession(sessionId)
      if (session?.kind !== 'conversation' || session.channel.platform !== PLATFORM) {
        throw new AnimaError('anima/no-channel', 'this session is not bound to a local channel.')
      }
      if (args.text.trim() === '') throw new AnimaError('anima/empty-message', 'text is empty; to stay silent, call stay_silent instead.')
      const at = new Date(ctx.anima.clock.now()).toISOString()
      mkdirSync(dirname(outbox), { recursive: true })
      appendFileSync(outbox, `${JSON.stringify({ at, sessionId, channel: session.channelKey, text: args.text })}\n`)
      return { sent: true, at }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  ctx.anima.addSubcommand({
    name: 'chat',
    usage: 'chat [--as <name>] [--in group:<id>] <text> — message her as the owner, or (dev) as another person or in a simulated group',
    run: async (args) => {
      const chat = parseChat(args)
      if ('error' in chat) return { kind: 'error', text: chat.error }
      const channel = chatChannel(chat)
      remember(channel)
      const sender = chat.as === undefined
        ? { platformUserId: 'owner', displayName: ownerName, isOwner: true }
        : { platformUserId: chat.as.toLowerCase(), displayName: displayName(chat.as), isOwner: false }
      const addressed = channel.kind === 'group' ? addressesHer(chat.text, ctx.anima.config.name) : undefined
      const sessionId = await ctx.animaLife.deliver({
        type: 'message',
        channel,
        sender,
        text: chat.text,
        ts: ctx.anima.clock.now(),
        ...addressed === undefined ? {} : { addressed },
      })
      const how = channel.kind === 'group' && addressed !== true && !sender.isOwner
        ? 'as context (it does not address her, so it joins her next turn there)'
        : ''
      return { kind: 'success', text: `Delivered to "Anima · ${channel.display}" (${sessionId})${how === '' ? '' : ` ${how}`}. Open it in the sidebar to watch her reply.` }
    },
  })
}
