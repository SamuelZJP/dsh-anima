// A fake platform for sped-up exit demos only: never shipped, never in a bundle. Loaded by
// absolute path from a demo overlay, after anima-core and anima-life. It stands in for a chat
// platform the way a test double does: a demo driver delivers scripted messages as people on
// it (`deliverAs`), and her `demo_say` goes to <dataDir>/demo/outbox.jsonl, which the driver
// reads (`said`). Every line said on it, by people or by her, goes to <dataDir>/demo/history.jsonl,
// which is the platform's chat history (first contact in a waking, reading a group further back).
// Code here never decides what she says.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(new URL('../../packages/anima-core/package.json', import.meta.url))
const { defineTool } = await import(require.resolve('@deepseek-ai/dsh-tools'))
const { AnimaError, SAY_META, SAY_PARAMETERS, sayMessages } = await import(new URL('../../packages/anima-core/lib/index.js', import.meta.url).href)

export const name = 'anima-demo-platform'
export const inject = ['anima', 'animaLife']

/** Platform id and account of every demo channel. */
export const PLATFORM = 'demo'
const ACCOUNT = 'me'

/** A private chat with a person, or a group (`id` of the group). */
export function demoChannel(kind, id, display, isOwner = false) {
  return { platform: PLATFORM, account: ACCOUNT, kind, id, display, ...isOwner ? { isOwner: true } : {} }
}

/** Channel key of a demo channel. */
export const keyOf = channel => `${channel.platform}:${channel.account}:${channel.kind}:${channel.id}`

/** Path of her outbox on the demo platform. */
export const outboxPath = dataDir => join(dataDir, 'demo', 'outbox.jsonl')

/** Path of the demo platform's chat history. */
export const historyPath = dataDir => join(dataDir, 'demo', 'history.jsonl')

let seq = 0
function remember(dataDir, row) {
  const path = historyPath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  const messageId = row.messageId ?? `d${Date.now().toString(36)}${++seq}`
  appendFileSync(path, `${JSON.stringify({ ...row, messageId })}\n`)
  return messageId
}

function historyOf(dataDir, channelKey) {
  const path = historyPath(dataDir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.channel === channelKey)
}

/** What she said on one channel, in order. */
export function said(dataDir, channelKey) {
  const path = outboxPath(dataDir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.channel === channelKey)
}

export function apply(ctx) {
  const outbox = outboxPath(ctx.anima.config.dataDir)
  ctx.anima.registerBehavior(defineTool({
    name: 'demo_say',
    description: 'Say something in a demo chat, by its channel key: one message, or a list of messages sent in order. They see only what you send this way. A say ends your turn unless more: true.',
    parameters: { ...SAY_PARAMETERS },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'integer', required: true, description: 'How many messages were delivered.' },
          at: { type: 'string', required: true, description: 'Send time on her clock, ISO 8601.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.sent === 1 ? 'sent' : `sent ${value.sent} messages` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.id
      const channel = String(args.channel ?? '').trim()
      if (!channel.startsWith(`${PLATFORM}:`)) throw new AnimaError('anima/no-channel', `「${channel}」 is not a demo chat; use the channel key shown on its arrivals.`)
      const messages = sayMessages(args)
      if (messages.length === 0) throw new AnimaError('anima/empty-message', 'text is empty; to end the turn without speaking, call end_turn instead.')
      const at = new Date(ctx.anima.clock.now()).toISOString()
      mkdirSync(dirname(outbox), { recursive: true })
      for (const text of messages) {
        appendFileSync(outbox, `${JSON.stringify({ at, sessionId, channel, text })}\n`)
        remember(ctx.anima.config.dataDir, { channel, ts: ctx.anima.clock.now(), who: 'you', text })
      }
      return { sent: messages.length, at }
    },
  }), { platform: PLATFORM, effect: 'express', sessions: ['waking'], ...SAY_META })

  ctx.animaLife.provideHistory(PLATFORM, async (channel, request) => {
    const lines = historyOf(ctx.anima.config.dataDir, keyOf(channel))
    const end = request.before === undefined ? lines.length : lines.findIndex(line => line.messageId === request.before)
    return lines.slice(0, end < 0 ? 0 : end).slice(-request.count)
  })
}

/**
 * Deliver one message from a person on a demo channel, as an adapter would.
 * @param life - the animaLife service.
 * @param core - the anima service (for her clock).
 */
export function deliverAs(life, core, channel, sender, text, extra = {}) {
  const ts = core.clock.now()
  const who = `${sender.displayName}${sender.isOwner ? ' (owner)' : ''}`
  const messageId = remember(core.config.dataDir, { channel: keyOf(channel), ts, who, text, messageId: extra.messageId })
  return life.deliver({ type: 'message', channel, sender, text, ts, ...extra, messageId })
}
