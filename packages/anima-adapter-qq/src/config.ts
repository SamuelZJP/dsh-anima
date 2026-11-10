/**
 * QQ adapter configuration. The adapter speaks only OneBot v11, so any OneBot
 * v11 runtime (NapCatQQ, LLOneBot) works by pointing `url` at it.
 * @module @anima/adapter-qq/config
 */

import { AnimaError } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** A chat on the allowlist. */
export interface AllowEntry {
  /** QQ user id (private chats) or group id. */
  id: string
  /** Display name; the id when omitted. */
  name?: string | undefined
}

/** Plugin config of `@anima/adapter-qq`. */
export interface Config {
  /** OneBot v11 forward WebSocket URL, e.g. `ws://127.0.0.1:3001`. */
  url: string
  /** OneBot access token, sent as `?access_token=`. */
  accessToken?: string | undefined
  /** Her QQ number (the logged-in account). */
  account: string
  /** The owner's QQ user id. Owner identity comes only from this. */
  owner: string
  /** The owner's display name in her context. */
  ownerName: string
  /** Chats she may talk in besides the owner's private chat. Everything else is dropped. */
  allow: {
    users: AllowEntry[]
    groups: AllowEntry[]
  }
  /** Real seconds an API call may take. */
  callTimeoutSeconds: number
  /** Longest wait between reconnect attempts. */
  reconnect: { maxSeconds: number }
  /** A missing OneBot heartbeat for this many intervals counts as a lost connection. */
  heartbeatGrace: number
}

const qqId = z.union([z.natural(), z.string().pattern(/^\d{4,12}$/)])
const entry = z.union([qqId, z.object({ id: qqId.required(), name: z.string() })])

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  url: z.string().pattern(/^wss?:\/\//).required().description('OneBot v11 forward WebSocket URL of the runtime (NapCatQQ: its "WebSocket server"), e.g. ws://127.0.0.1:3001.'),
  accessToken: z.string().role('secret').description('OneBot access token, if the runtime sets one.'),
  account: qqId.required().description('Her QQ number, the account logged in to the runtime.'),
  owner: qqId.required().description('The owner\'s QQ user id. Owner identity comes only from this.'),
  ownerName: z.string().default('Owner').description('The owner\'s display name in her context.'),
  allow: z.object({
    users: z.array(entry).default([]).description('QQ users she may talk with privately, besides the owner.'),
    groups: z.array(entry).default([]).description('QQ groups she may talk in.'),
  }).description('Allowlist. Messages from any other chat are dropped before they reach her.'),
  callTimeoutSeconds: z.number().min(1).default(10),
  reconnect: z.object({ maxSeconds: z.number().min(1).default(60) }),
  heartbeatGrace: z.number().min(1.5).default(2.5),
}) as unknown as z<Config>

/** Validated config with ids as strings. */
export type ResolvedQqConfig = Readonly<Config>

/**
 * Validate and normalize config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 */
export function resolveQqConfig(input: unknown): ResolvedQqConfig {
  let raw: Config
  try {
    raw = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. The anima-adapter-qq row needs url, account and owner.`)
  }
  const norm = (value: unknown): AllowEntry => typeof value === 'object' && value !== null
    ? { id: String((value as AllowEntry).id), name: (value as AllowEntry).name }
    : { id: String(value) }
  const config: Config = {
    ...raw,
    account: String(raw.account),
    owner: String(raw.owner),
    allow: { users: raw.allow.users.map(norm), groups: raw.allow.groups.map(norm) },
  }
  if (config.owner === config.account) throw new AnimaError('anima/config-invalid', 'owner and account are the same QQ number; she needs her own account.')
  return Object.freeze(config)
}
