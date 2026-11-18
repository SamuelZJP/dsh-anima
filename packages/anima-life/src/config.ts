/**
 * Anima life configuration: conversation turns, group triage and platform notices.
 * @module @anima/life/config
 */

import { AnimaError, type ModelRoute } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** Plugin config of `@anima/life`. */
export interface Config {
  /** Conversation turns (DESIGN §6, Turn shape). */
  conversation: {
    /** Real seconds a private chat must stay quiet before its messages wake her (a burst is one wake); 0 wakes at once. */
    settleSeconds: number
    /** Real seconds after a burst's first message after which she is woken anyway (Phase 9). */
    settleMaxSeconds: number
  }
  /** Group triage (DESIGN §5). */
  groupTriage: {
    /** Real seconds after she spoke in a group during which its messages wake her directly, skipping triage; 0 turns it off. */
    attentionSeconds: number
    /** Real seconds a group's buffer of unaddressed messages stays open. */
    windowSeconds: number
    /** A buffer with this many messages closes at once. */
    maxBatch: number
    /** Real seconds a batch may stay undecided before it is remembered. */
    timeoutSeconds: number
    /** Model of group-triage turns; the day triage model when omitted. */
    model?: Partial<ModelRoute> | undefined
  }
  /** Platform health as adapters report it. */
  platforms: {
    /** Real seconds a platform must stay offline before her Self session is told (short drops stay quiet). */
    noticeAfterSeconds: number
  }
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  conversation: z.object({
    settleSeconds: z.number().min(0).default(15).description('Real seconds a chat must stay quiet (no message, no typing) before its messages wake her, so a burst arrives as one wake; 0 wakes at once. Intents are never delayed.'),
    settleMaxSeconds: z.number().min(0).default(60).description('Real seconds after the first message of a burst after which she is woken anyway, however long the stream goes on.'),
  }).description('Conversation turns: the settle window of bursts.'),
  groupTriage: z.object({
    attentionSeconds: z.number().min(0).default(90).description('Real seconds after she spoke in a group during which its messages wake her directly (counted by the group_attention quota); 0 turns it off.'),
    windowSeconds: z.number().min(0.01).default(60).description('Real seconds a group\'s buffer of unaddressed messages stays open.'),
    maxBatch: z.natural().min(1).default(30).description('A buffer with this many messages closes at once.'),
    timeoutSeconds: z.number().min(0.01).default(300).description('Real seconds a batch may stay undecided before it is remembered.'),
    model: z.object({ provider: z.string(), model: z.string() }).description('Model of group-triage turns (provider and model); the day triage model when omitted.'),
  }).description('Group triage: buffered group chatter sorted into ignore, remember, or wake.'),
  platforms: z.object({
    noticeAfterSeconds: z.number().min(0).default(60).description('Real seconds a platform must stay offline before her Self session gets a notice; it gets another when the platform is back.'),
  }).description('Platform health notices to her Self session.'),
}) as z<Config>

/**
 * Validate life config. Fails loud with `anima/config-invalid`.
 * @param input - raw config.
 */
export function resolveLifeConfig(input: Partial<Config> | undefined): Readonly<Config> {
  if ((input as Record<string, unknown> | undefined)?.outbox !== undefined) {
    throw new AnimaError('anima/config-moved', 'outbox moved to the anima-guard row (holding her messages is done outside the persona). Move it there.')
  }
  if ((input as { conversation?: Record<string, unknown> } | undefined)?.conversation?.closeReminders !== undefined) {
    throw new AnimaError('anima/config-removed', 'conversation.closeReminders is gone: her plain text is her thinking, and nothing reminds her to speak. Remove it from the anima-life row.')
  }
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-life row in cordis.yml.`)
  }
  const model = config.groupTriage.model
  if (model !== undefined && (model.provider === undefined) !== (model.model === undefined)) {
    throw new AnimaError('anima/config-invalid', 'groupTriage.model needs both provider and model, or neither.')
  }
  return Object.freeze(config)
}

/** The group-triage model route, when the config sets one. */
export function groupTriageModel(config: Readonly<Config>): ModelRoute | undefined {
  const { provider, model } = config.groupTriage.model ?? {}
  return provider === undefined || model === undefined ? undefined : { provider, model }
}
