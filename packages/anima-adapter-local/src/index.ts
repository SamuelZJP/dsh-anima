/**
 * Development adapter over the DSH web UI (DESIGN §11). One channel, the
 * owner; `/anima chat <text>` is the owner's incoming message and `local_say`
 * is her outgoing speech, appended to `<dataDir>/local/outbox.jsonl`.
 * @module @anima/adapter-local
 */

import { appendFileSync, mkdirSync } from 'node:fs'
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
  platform: PLATFORM, account: 'owner', kind: 'private', id: 'owner', display: 'Owner (local)',
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

  ctx.animaLife.publish([OWNER_CHANNEL])

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
          at: { type: 'string', required: true, description: 'Send time, ISO 8601.' },
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
      if (args.text.trim() === '') throw new AnimaError('anima/empty-message', 'text is empty; to stay silent, simply do not call local_say.')
      const at = new Date().toISOString()
      mkdirSync(dirname(outbox), { recursive: true })
      appendFileSync(outbox, `${JSON.stringify({ at, sessionId, channel: session.channelKey, text: args.text })}\n`)
      return { sent: true, at }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['conversation'] })

  ctx.anima.addSubcommand({
    name: 'chat',
    usage: 'chat <text> — send her a message as the owner on the local channel',
    run: async (args) => {
      if (args === '') return { kind: 'error', text: 'Usage: /anima chat <text>' }
      const sessionId = await ctx.animaLife.deliver({
        type: 'message',
        channel: OWNER_CHANNEL,
        sender: { platformUserId: 'owner', displayName: ownerName, isOwner: true },
        text: args,
        ts: Date.now(),
      })
      return { kind: 'success', text: `Delivered to "Anima · ${OWNER_CHANNEL.display}" (${sessionId}). Open it in the sidebar to watch her reply; you can also type there directly.` }
    },
  })
}
