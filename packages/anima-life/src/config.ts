/**
 * Anima life configuration: the waking session's model, bursts, groups, `wait`
 * and platform notices.
 * @module @anima/life/config
 */

import { AnimaError, DEFAULT_MODEL, type ModelRoute } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** Plugin config of `@anima/life`. */
export interface Config {
  /** Her waking sessions (docs/design/life.md). */
  waking: {
    /** The model of her waking sessions. */
    model: ModelRoute
    /** Chats her waking context names, with their keys: those she was last in touch with. */
    contextChannels: number
  }
  /** Bursts of chat messages. */
  conversation: {
    /** Real seconds a chat must stay quiet before its messages reach her (a burst is one arrival); 0 delivers at once. */
    settleSeconds: number
    /** Real seconds after a burst's first message after which it reaches her anyway. */
    settleMaxSeconds: number
  }
  /** Groups (docs/design/life.md, Groups). */
  groups: {
    /** Real seconds after she spoke in a group during which its messages reach her directly; 0 turns it off. */
    attentionSeconds: number
    /** Lines kept per group, read and unread. */
    bufferMessages: number
    /** Latest lines per group that `groups_glance` shows. */
    glanceLines: number
  }
  /** `wait(seconds)`. */
  wait: {
    /** Longest wait, in seconds on her clock. */
    maxSeconds: number
  }
  /** Platform health as adapters report it. */
  platforms: {
    /** Real seconds a platform must stay offline before she is told (short drops stay quiet). */
    noticeAfterSeconds: number
  }
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  waking: z.object({
    model: z.object({
      provider: z.string().default(DEFAULT_MODEL.provider),
      model: z.string().default(DEFAULT_MODEL.model),
    }).description('Model of her waking sessions (provider and model).'),
    contextChannels: z.natural().default(8).description('Chats her waking context names, with their channel keys: the ones she was last in touch with.'),
  }).description('Her waking sessions: one per period of wakefulness.'),
  conversation: z.object({
    settleSeconds: z.number().min(0).default(15).description('Real seconds a chat must stay quiet (no message, no typing) before its messages reach her, so a burst arrives as one; 0 delivers at once.'),
    settleMaxSeconds: z.number().min(0).default(60).description('Real seconds after the first message of a burst after which it reaches her anyway, however long the stream goes on.'),
  }).description('Bursts: the settle window of chat messages.'),
  groups: z.object({
    attentionSeconds: z.number().min(0).default(90).description('Real seconds after she spoke in a group during which its messages reach her directly; 0 turns it off.'),
    bufferMessages: z.natural().min(1).default(200).description('Lines kept per group (read and unread); group_read reads back through them.'),
    glanceLines: z.natural().min(1).default(3).description('Latest lines per group that groups_glance shows.'),
  }).description('Groups: unaddressed messages wait in a buffer per group until she looks.'),
  wait: z.object({
    maxSeconds: z.number().min(1).default(900).description('Longest wait(seconds), in seconds on her clock.'),
  }).description('wait: keeping her attention open.'),
  platforms: z.object({
    noticeAfterSeconds: z.number().min(0).default(60).description('Real seconds a platform must stay offline before she gets a notice; she gets another when it is back.'),
  }).description('Platform health notices.'),
}) as z<Config>

/** Keys removed in R4, with the reason; set, they fail the load. */
const REMOVED: readonly { key: string; why: string }[] = [
  { key: 'groupTriage', why: 'group triage is gone (R4): unaddressed group messages wait in a buffer per group until she looks (groups { attentionSeconds, bufferMessages, glanceLines })' },
]

/**
 * Validate life config. Fails loud with `anima/config-invalid`.
 * @param input - raw config.
 */
export function resolveLifeConfig(input: Partial<Config> | undefined): Readonly<Config> {
  const raw = (input ?? {}) as Record<string, unknown>
  if (raw.outbox !== undefined) {
    throw new AnimaError('anima/config-moved', 'outbox moved to the anima-guard row (holding her messages is done outside the persona). Move it there.')
  }
  if ((raw.conversation as Record<string, unknown> | undefined)?.closeReminders !== undefined) {
    throw new AnimaError('anima/config-removed', 'conversation.closeReminders is gone: her plain text is her thinking, and nothing reminds her to speak. Remove it from the anima-life row.')
  }
  const removed = REMOVED.filter(entry => raw[entry.key] !== undefined)
  if (removed.length > 0) {
    throw new AnimaError('anima/config-removed', `${removed.map(entry => `${entry.key} is gone: ${entry.why}`).join('; ')}. Remove it from the anima-life row.`)
  }
  try {
    return Object.freeze(Config((input ?? {}) as Config))
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-life row in cordis.yml.`)
  }
}
