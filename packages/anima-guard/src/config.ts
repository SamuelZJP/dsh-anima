/**
 * Anima guard configuration (docs/design/outside.md): everything the owner
 * restricts from outside the persona. Every tunable is a validated field.
 * @module @anima/guard/config
 */

import { AnimaError, EFFECT_CLASSES, type EffectClass } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** Where a quota counts. */
export type QuotaScope = 'channel' | 'platform' | 'global'

/** One sliding-window quota. */
export interface QuotaRule {
  /** Only behaviors of this effect class; all when omitted. */
  effect?: EffectClass
  /** Only this behavior (tool name); all when omitted. */
  behavior?: string
  /** Only behaviors of this platform (e.g. `bili`); all when omitted. */
  platform?: string
  /** One counter per channel, per platform, or one global counter. */
  per: QuotaScope
  /** Maximum total cost inside the window. */
  limit: number
  /** Window length in minutes. */
  windowMinutes: number
}

/** An owner rule letting a `public` or `irreversible` behavior run without approval. */
export interface AllowRule {
  /** Tool name. */
  behavior: string
}

/** A behavior that always waits for the owner. */
export interface ApproveRule {
  /** Tool name. */
  behavior: string
  /** `all` (default), or `others`: only calls whose target is not one of the owner's channels. */
  targets?: 'all' | 'others' | undefined
}

/** A limit on a numeric fact of a call (a video's length). */
export interface LimitRule {
  /** Tool name. */
  behavior: string
  /** Fact name, e.g. `durationSeconds`. */
  fact: string
  /** Largest allowed value. */
  max: number
}

/** A daily window, `HH:mm`. */
export interface TimeWindow {
  from: string
  to: string
}

/** Plugin config of `@anima/guard`. */
export interface Config {
  quotas: QuotaRule[]
  limits: LimitRule[]
  allow: AllowRule[]
  approve: ApproveRule[]
  approvals: {
    /** Real seconds before an unanswered request counts as denied. */
    timeoutSeconds: number
  }
  initiate: {
    /** Conversations she may start per day. */
    perDay: number
    /** Windows when she may not start one. */
    quietHours: TimeWindow[]
    consent: {
      /** Any channel the adapter marks as the owner's. */
      owner: boolean
      /** Further channel keys `platform:account:kind:id`. */
      channels: string[]
    }
  }
  /** Billable (non-cached) tokens per day (awake) and per night (asleep). */
  budget: { day: number; night: number }
  outbox: {
    /** Real seconds a message she starts waits before it goes out; 0 sends at once. */
    delaySeconds: number
    /** Tell the owner on the owner line about each held message (not for the owner's own chat). */
    notifyOwner: boolean
    /** Real minutes a held message waits for its platform to come back before it expires. */
    offlineHoldMinutes: number
  }
}

/** Default quotas: modest per-channel speech, a daily global ceiling, and platform protection. */
export const DEFAULT_QUOTAS: QuotaRule[] = [
  { effect: 'express', per: 'channel', limit: 30, windowMinutes: 60 },
  { per: 'global', limit: 200, windowMinutes: 24 * 60 },
  { behavior: 'schedule_create', per: 'global', limit: 20, windowMinutes: 24 * 60 },
  { behavior: 'group_wake', per: 'channel', limit: 6, windowMinutes: 60 },
  { behavior: 'group_attention', per: 'channel', limit: 10, windowMinutes: 60 },
  { platform: 'bili', per: 'platform', limit: 60, windowMinutes: 60 },
  { behavior: 'bili_view_closely', per: 'global', limit: 3, windowMinutes: 24 * 60 },
  { behavior: 'qq_look', per: 'channel', limit: 10, windowMinutes: 60 },
  { behavior: 'qq_look', per: 'global', limit: 30, windowMinutes: 24 * 60 },
  { behavior: 'qq_read_forward', per: 'channel', limit: 10, windowMinutes: 60 },
  { behavior: 'qq_poke', per: 'channel', limit: 3, windowMinutes: 60 },
  { behavior: 'qq_react', per: 'channel', limit: 10, windowMinutes: 60 },
]

/** Default limits: a close view looks at no more than 12 frames of a video up to 20 minutes; a say sends at most 5 messages. */
export const DEFAULT_LIMITS: LimitRule[] = [
  { behavior: 'bili_view_closely', fact: 'frames', max: 12 },
  { behavior: 'bili_view_closely', fact: 'durationSeconds', max: 20 * 60 },
  { behavior: 'qq_say', fact: 'messages', max: 5 },
  { behavior: 'local_say', fact: 'messages', max: 5 },
]

const effect = z.union(EFFECT_CLASSES.map(value => z.const(value))) as z<EffectClass>
const hhmm = z.string().pattern(/^\d{1,2}:\d{2}$/)

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  quotas: z.array(z.object({
    effect,
    behavior: z.string(),
    platform: z.string(),
    per: z.union([z.const('channel'), z.const('platform'), z.const('global')]).required(),
    limit: z.number().min(1).required(),
    windowMinutes: z.number().min(1).required(),
  })).default(DEFAULT_QUOTAS).description('Sliding-window quotas.'),
  limits: z.array(z.object({
    behavior: z.string().required(),
    fact: z.string().required(),
    max: z.number().min(0).required(),
  })).default(DEFAULT_LIMITS).description('Limits on numeric facts of calls, e.g. the length of a video she may view closely.'),
  allow: z.array(z.object({ behavior: z.string().required() })).default([])
    .description('Rules letting public or irreversible behaviors run without approval.'),
  approve: z.array(z.object({
    behavior: z.string().required(),
    targets: z.union([z.const('all'), z.const('others')]).description('all (default), or others: only calls whose target is not one of the owner\'s channels.'),
  })).default([]).description('Behaviors that always need owner approval, whatever their effect class.'),
  approvals: z.object({
    timeoutSeconds: z.number().min(1).default(600).description('Real seconds before an unanswered approval request counts as denied.'),
  }).description('Owner approvals over the owner line.'),
  initiate: z.object({
    perDay: z.number().min(0).default(3).description('Conversations she may start per day.'),
    quietHours: z.array(z.object({ from: hhmm.required(), to: hhmm.required() })).default([]),
    consent: z.object({
      owner: z.boolean().default(true),
      channels: z.array(z.string()).default([]),
    }),
  }).description('Rules for conversations she starts.'),
  budget: z.object({
    day: z.number().min(0).default(300_000).description('Billable tokens allowed per day while she is awake.'),
    night: z.number().min(0).default(20_000).description('Billable tokens allowed per night while she sleeps.'),
  }).description('Token budgets.'),
  outbox: z.object({
    delaySeconds: z.number().min(0).default(45).description('Real seconds a message she starts waits before it goes out; 0 sends at once.'),
    notifyOwner: z.boolean().default(false).description('Tell the owner on the owner line about each held message (not for the owner\'s own chat).'),
    offlineHoldMinutes: z.number().min(0.01).default(30).description('Real minutes a held message waits for its platform to come back before it expires.'),
  }).description('Outbox hold for messages she starts.'),
}) as z<Config>

/** Validated config with quiet hours parsed to minutes after midnight. */
export type ResolvedGuardConfig = Readonly<Config> & { readonly quiet: readonly { from: number; to: number }[] }

/**
 * Validate config. Fails loud with `anima/config-invalid`.
 * @param input - raw config.
 */
export function resolveGuardConfig(input: Partial<Config> | undefined): ResolvedGuardConfig {
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-guard row in cordis.yml.`)
  }
  for (const [index, rule] of config.quotas.entries()) {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      throw new AnimaError('anima/config-invalid', `quotas[${index}].limit must be a positive integer, got ${rule.limit}.`)
    }
  }
  const quiet = config.initiate.quietHours.map(window => ({ from: minutes(window.from), to: minutes(window.to) }))
  return Object.freeze({ ...config, quiet })
}

function minutes(text: string): number {
  const [h, m] = text.split(':').map(Number) as [number, number]
  if (h > 23 || m > 59) throw new AnimaError('anima/config-invalid', `"${text}" is not a valid HH:mm time.`)
  return h * 60 + m
}
