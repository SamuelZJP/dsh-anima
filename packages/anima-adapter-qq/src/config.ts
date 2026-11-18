/**
 * QQ adapter configuration. How to reach the runtime that holds her account is
 * the `backend` section; today the one protocol is OneBot v11 (NotRainMeow, or
 * any OneBot v11 runtime).
 * @module @anima/adapter-qq/config
 */

import { AnimaError } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** The runtime that holds her QQ account. */
export interface BackendConfig {
  /** Its protocol; each protocol is one backend implementation. */
  protocol: 'onebot11'
  /** OneBot v11 forward WebSocket URL, e.g. `ws://127.0.0.1:3001`. */
  url: string
  /** OneBot access token, sent as `Authorization: Bearer`. */
  accessToken?: string | undefined
  /** Real seconds an API call may take. */
  callTimeoutSeconds: number
  /** Longest wait between reconnect attempts. */
  reconnect: { maxSeconds: number }
  /** A missing heartbeat for this many intervals counts as a lost connection. */
  heartbeatGrace: number
}

/** Plugin config of `@anima/adapter-qq`. */
export interface Config {
  backend: BackendConfig
  /** Her QQ number (the logged-in account). */
  account: string
  /** The owner's QQ user id. Owner identity comes only from this. */
  owner: string
  /** The owner's display name in her context. */
  ownerName: string
  /** Images she chooses to look at with `qq_look` (quotas are in the gate). */
  look: {
    /** Image, sticker and forward ids remembered (`<dataDir>/qq/media.json`); the oldest are forgotten first. */
    cacheEntries: number
    /** Largest image downloaded, in bytes. */
    maxBytes: number
    /** Real seconds a download may take. */
    fetchTimeoutSeconds: number
  }
  /** Forwarded messages read with `qq_read_forward`. */
  forward: {
    /** Most messages shown of one forward. */
    maxMessages: number
    /** Most characters shown of one forward. */
    maxChars: number
  }
  /** Characters of the quoted message shown with a reply. */
  quoteChars: number
  /** Typing status in private chats while her chosen message waits in the outbox. */
  typing: {
    enabled: boolean
    /** Real seconds before the held message goes out when typing is shown. */
    leadSeconds: number
  }
  /** Spacing between the messages of one say (Phase 9): a typing time from each message's length. */
  pacing: {
    baseSeconds: number
    perCharSeconds: number
    maxSeconds: number
  }
  /** Mark a chat read when its messages reach her awake (Phase 9); held inbox messages stay unread. */
  markRead: boolean
}

const qqId = z.union([z.natural(), z.string().pattern(/^\d{4,12}$/)])

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  backend: z.object({
    protocol: z.const('onebot11').default('onebot11').description('Protocol of the runtime: onebot11 (NotRainMeow, or any OneBot v11 runtime).'),
    url: z.string().pattern(/^wss?:\/\//).required().description('OneBot v11 forward WebSocket URL of the runtime (its "WebSocket server"), e.g. ws://127.0.0.1:3001.'),
    accessToken: z.string().role('secret').description('OneBot access token, if the runtime sets one.'),
    callTimeoutSeconds: z.number().min(1).default(10),
    reconnect: z.object({ maxSeconds: z.number().min(1).default(60) }),
    heartbeatGrace: z.number().min(1.5).default(2.5),
  }).required().description('The runtime that holds her QQ account.'),
  account: qqId.required().description('Her QQ number, the account logged in to the runtime.'),
  owner: qqId.required().description('The owner\'s QQ user id. Owner identity comes only from this.'),
  ownerName: z.string().default('Owner').description('The owner\'s display name in her context.'),
  look: z.object({
    cacheEntries: z.natural().min(10).default(300).description('Image, sticker and forward ids remembered; the oldest are forgotten first.'),
    maxBytes: z.natural().min(1024).default(5 * 1024 * 1024).description('Largest image qq_look downloads, in bytes.'),
    fetchTimeoutSeconds: z.number().min(1).default(15).description('Real seconds an image download may take.'),
  }).description('Images she chooses to look at (qq_look). Quotas are core quotas.'),
  forward: z.object({
    maxMessages: z.natural().min(1).default(50).description('Most messages qq_read_forward shows of one forward.'),
    maxChars: z.natural().min(100).default(4000).description('Most characters qq_read_forward shows of one forward.'),
  }).description('Forwarded messages (qq_read_forward).'),
  quoteChars: z.natural().min(0).default(60).description('Characters of the quoted message shown with a reply; 0 shows only the message id.'),
  typing: z.object({
    enabled: z.boolean().default(true).description('Show typing in a private chat while her chosen message waits in the outbox.'),
    leadSeconds: z.number().min(0).default(8).description('Real seconds before the held message goes out when typing is shown.'),
  }).description('Typing status (private chats): during the outbox hold and between her messages.'),
  pacing: z.object({
    baseSeconds: z.number().min(0).default(1).description('Seconds before every message of a say after the first.'),
    perCharSeconds: z.number().min(0).default(0.15).description('Seconds per character of that message.'),
    maxSeconds: z.number().min(0).default(6).description('Most seconds before one message.'),
  }).description('Spacing between the messages of one say, like typing time (Phase 9).'),
  markRead: z.boolean().default(true).description('Mark a chat read on QQ when its messages reach her awake; messages held while she sleeps stay unread.'),
}) as unknown as z<Config>

/** Top-level keys that moved into `backend`. */
const MOVED = ['url', 'accessToken', 'callTimeoutSeconds', 'reconnect', 'heartbeatGrace'] as const

/** Validated config with ids as strings. */
export type ResolvedQqConfig = Readonly<Config>

/**
 * Validate and normalize config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 */
export function resolveQqConfig(input: unknown): ResolvedQqConfig {
  const moved = MOVED.filter(key => (input as Record<string, unknown> | undefined)?.[key] !== undefined)
  if (moved.length > 0) {
    throw new AnimaError('anima/config-moved', `${moved.join(', ')} moved into backend { protocol: onebot11, url, accessToken, callTimeoutSeconds, reconnect, heartbeatGrace } (how to reach the QQ runtime is the backend's).`)
  }
  if ((input as { allow?: unknown } | undefined)?.allow !== undefined) {
    throw new AnimaError('anima/config-moved', 'allow moved to the anima-guard row as allowlist.qq { users, groups } (which chats may reach her is decided outside the persona). The adapter publishes every friend and group.')
  }
  let raw: Config
  try {
    raw = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. The anima-adapter-qq row needs backend.url, account and owner.`)
  }
  const config: Config = {
    ...raw,
    account: String(raw.account),
    owner: String(raw.owner),
  }
  if (config.owner === config.account) throw new AnimaError('anima/config-invalid', 'owner and account are the same QQ number; she needs her own account.')
  return Object.freeze(config)
}
