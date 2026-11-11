/**
 * Anima core configuration: identity, data directory and gate policy.
 * @module @anima/core/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { ClockConfig } from './clock.ts'
import { resolveRhythm, type Mode, type Rhythm, type RhythmConfig } from './rhythm.ts'
import { DEFAULT_NEEDS, type EnergyConfig, type MoodConfig, type NeedSpec } from './state.ts'
import { AnimaError, EFFECT_CLASSES, type EffectClass } from './types.ts'

/** Which counter a quota rule keeps. */
export type QuotaScope = 'channel' | 'platform' | 'global'

/** One sliding-window quota. A call counts against every rule it matches. */
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

/** Owner rule letting a `public` or `irreversible` behavior run without approval (DESIGN §10, Phase 1). */
export interface AllowRule {
  /** Tool name. */
  behavior: string
}

/** Owner rule making a behavior always need owner approval, whatever its effect class (DESIGN §10). */
export interface ApproveRule {
  /** Tool name. */
  behavior: string
}

/** Owner limit on a numeric fact of a call (`BehaviorMeta.facts`), e.g. a video's length. */
export interface LimitRule {
  /** Tool name. */
  behavior: string
  /** Fact name, e.g. `durationSeconds`. */
  fact: string
  /** Largest allowed value. */
  max: number
}

/** A model route for one kind of turn. */
export interface ModelRoute {
  /** DSH provider id, e.g. `deepseek-official`. */
  provider: string
  /** Provider model id, e.g. `deepseek-flash` (DeepSeek-V4.1-Flash). */
  model: string
}

/** Settings of one heartbeat mode (DESIGN §7 table). */
export interface ModeConfig {
  /** Model of triage turns. */
  triageModel: ModelRoute
  /** Model of action turns in the Self session. */
  actionModel: ModelRoute
  /** Shortest heartbeat interval she may choose (day). */
  minIntervalMinutes: number
  /** Longest heartbeat interval she may choose (day). */
  maxIntervalMinutes: number
  /** Interval when she does not choose one. */
  defaultIntervalMinutes: number
  /** Wake-ups allowed per night (night). */
  maxWakes: number
  /** Billable tokens per day (day mode) or per night (night mode). */
  tokenBudget: number
  /** Effect classes the gate allows in this mode. */
  allowedEffects: EffectClass[]
}

/** A local `HH:mm`–`HH:mm` window. */
export interface TimeWindow {
  from: string
  to: string
}

/** Rules for starting conversations. */
export interface InitiateConfig {
  /** Self-initiated conversations per day. */
  perDay: number
  /** Windows when she may not initiate, besides her own sleep. */
  quietHours: TimeWindow[]
  /** Who she may initiate with. */
  consent: {
    /** Any channel the adapter marks as the owner's. */
    owner: boolean
    /** Further channel keys `platform:account:kind:id`. */
    channels: string[]
  }
}

/** Plugin config of `@anima/core`. */
export interface Config {
  /** Character identity, part of every session id. */
  characterId: string
  /**
   * Generation of her Self session. Raising it starts a fresh Self session;
   * the old one stays in the sidebar. Her state, goals and memory live in the
   * data directory and carry over.
   */
  selfGeneration: number
  /** Her name, used in the default constitution. */
  name: string
  /** Plugin data directory; `~` expands to the home directory. */
  dataDir: string
  /** Quotas checked by the policy gate. */
  quotas: QuotaRule[]
  /** Limits on numeric facts of calls (DESIGN §10). */
  limits: LimitRule[]
  /** Owner allow rules for `public` and `irreversible` behaviors. */
  allow: AllowRule[]
  /** Behaviors that always need owner approval. */
  approve: ApproveRule[]
  /** Owner approvals (DESIGN §10). */
  approvals: {
    /** Real seconds before an unanswered request counts as denied. */
    timeoutSeconds: number
  }
  /** Her clock. */
  clock: ClockConfig
  /** Day rhythm. */
  rhythm: RhythmConfig
  /** Needs (DESIGN §7). */
  needs: NeedSpec[]
  /** Energy tuning. */
  energy: EnergyConfig
  /** Mood tuning. */
  mood: MoodConfig
  /** Per-mode models, intervals and budgets. */
  modes: Record<Mode, ModeConfig>
  /** Rules for starting conversations. */
  initiate: InitiateConfig
}

/** Default quotas: modest per-channel speech, a daily global ceiling. */
export const DEFAULT_QUOTAS: QuotaRule[] = [
  { effect: 'express', per: 'channel', limit: 30, windowMinutes: 60 },
  { per: 'global', limit: 200, windowMinutes: 24 * 60 },
  { behavior: 'schedule_create', per: 'global', limit: 20, windowMinutes: 24 * 60 },
  // Group triage may wake a group's conversation at most this often (DESIGN §5).
  { behavior: 'group_wake', per: 'channel', limit: 6, windowMinutes: 60 },
  // Bilibili browsing: calls per hour, and close views (tier 2) per day (DESIGN §11).
  { platform: 'bili', per: 'platform', limit: 60, windowMinutes: 60 },
  { behavior: 'bili_view_closely', per: 'global', limit: 3, windowMinutes: 24 * 60 },
]

/** Default limits: a close view looks at no more than 12 frames of a video up to 20 minutes. */
export const DEFAULT_LIMITS: LimitRule[] = [
  { behavior: 'bili_view_closely', fact: 'frames', max: 12 },
  { behavior: 'bili_view_closely', fact: 'durationSeconds', max: 20 * 60 },
]

/** Default model: DeepSeek-V4.1-Flash on the official API. */
export const DEFAULT_MODEL: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }

const effect = z.union(EFFECT_CLASSES.map(value => z.const(value))) as z<EffectClass>

const modelRoute = z.object({
  provider: z.string().default(DEFAULT_MODEL.provider),
  model: z.string().default(DEFAULT_MODEL.model),
})

function modeSchema(defaults: { min: number; max: number; def: number; wakes: number; budget: number; effects: EffectClass[] }) {
  return z.object({
    triageModel: modelRoute.description('Model of triage turns.'),
    actionModel: modelRoute.description('Model of action turns in the Self session.'),
    minIntervalMinutes: z.number().min(1).default(defaults.min).description('Shortest heartbeat interval she may choose.'),
    maxIntervalMinutes: z.number().min(1).default(defaults.max).description('Longest heartbeat interval she may choose.'),
    defaultIntervalMinutes: z.number().min(1).default(defaults.def).description('Interval when she does not choose one.'),
    maxWakes: z.number().min(0).default(defaults.wakes).description('Wake-ups allowed per night.'),
    tokenBudget: z.number().min(0).default(defaults.budget).description('Billable (non-cached) tokens allowed in this mode per day.'),
    allowedEffects: z.array(effect).default(defaults.effects).description('Effect classes allowed in this mode.'),
  })
}

const hhmm = z.string().pattern(/^\d{1,2}:\d{2}$/)

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  characterId: z.string().pattern(/^[a-z][a-z0-9-]*$/).default('anima')
    .description('Character identity, part of every session id. Changing it starts new sessions.'),
  selfGeneration: z.natural().min(1).default(1)
    .description('Generation of her Self session. Raising it starts a fresh Self session; state and goals carry over.'),
  name: z.string().default('Anima').description('Her name, used in the default constitution.'),
  dataDir: z.string().default('~/.anima').description('Plugin data directory.'),
  quotas: z.array(z.object({
    effect,
    behavior: z.string(),
    platform: z.string(),
    per: z.union([z.const('channel'), z.const('platform'), z.const('global')]).required(),
    limit: z.number().min(1).required(),
    windowMinutes: z.number().min(1).required(),
  })).default(DEFAULT_QUOTAS).description('Sliding-window quotas checked by the policy gate.'),
  limits: z.array(z.object({
    behavior: z.string().required(),
    fact: z.string().required(),
    max: z.number().min(0).required(),
  })).default(DEFAULT_LIMITS).description('Limits on numeric facts of calls, e.g. the length of a video she may view closely.'),
  allow: z.array(z.object({ behavior: z.string().required() })).default([])
    .description('Owner rules letting public or irreversible behaviors run without approval.'),
  approve: z.array(z.object({ behavior: z.string().required() })).default([])
    .description('Behaviors that always need owner approval, whatever their effect class.'),
  approvals: z.object({
    timeoutSeconds: z.number().min(1).default(600).description('Real seconds before an unanswered approval request counts as denied.'),
  }).description('Owner approvals over the owner line (e.g. the owner\'s QQ private chat).'),
  clock: z.object({
    speed: z.number().min(1).default(1).description('Simulated time per real time; 1 is real time. A test day uses e.g. 16.'),
    start: z.string().description('Simulated local start time, e.g. 2026-11-10T07:00. Omit to start at the real time.'),
  }).description('Her clock, the single time source.'),
  rhythm: z.object({
    wake: hhmm.default('07:30'),
    sleep: hhmm.default('23:30'),
    wakingMinutes: z.number().min(0).default(60),
    evening: hhmm.default('18:00'),
    windDownMinutes: z.number().min(0).default(60),
  }).description('Day rhythm.'),
  needs: z.array(z.object({
    name: z.string().pattern(/^[a-z][a-z0-9_-]*$/).required(),
    description: z.string().required(),
    baseline: z.number().min(0).max(1).default(0.3),
    driftPerHour: z.number().min(0).default(0.02),
    satisfiedBy: z.dict(z.number()).default({}),
  })).default(DEFAULT_NEEDS).description('Needs: name, description shown to her, baseline, drift per awake hour, satisfying behaviors.'),
  energy: z.object({
    drainPerHour: z.number().min(0).default(0.04),
    perTurn: z.number().min(0).default(0.03),
    restorePerHour: z.number().min(0).default(0.15),
  }),
  mood: z.object({
    valence: z.number().min(-1).max(1).default(0),
    arousal: z.number().min(0).max(1).default(0.3),
    halfLifeHours: z.number().min(0).default(3),
  }),
  modes: z.object({
    day: modeSchema({ min: 20, max: 240, def: 60, wakes: 0, budget: 300_000, effects: [...EFFECT_CLASSES] }),
    night: modeSchema({ min: 20, max: 480, def: 60, wakes: 1, budget: 20_000, effects: ['observe', 'internal'] }),
  }).description('Per-mode models, heartbeat intervals and token budgets.'),
  initiate: z.object({
    perDay: z.number().min(0).default(3).description('Self-initiated conversations per day.'),
    quietHours: z.array(z.object({ from: hhmm.required(), to: hhmm.required() })).default([]),
    consent: z.object({
      owner: z.boolean().default(true),
      channels: z.array(z.string()).default([]),
    }),
  }).description('Rules for starting conversations.'),
}) as z<Config>

/** Validated config with `dataDir` resolved to an absolute path and times parsed. */
export type ResolvedConfig = Readonly<Config> & {
  readonly day: Rhythm
  readonly quiet: readonly { from: number; to: number }[]
}

/**
 * Validate and normalize config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 * @returns the resolved config.
 */
export function resolveConfig(input: Partial<Config> | undefined): ResolvedConfig {
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-core row in cordis.yml.`)
  }
  for (const [index, rule] of config.quotas.entries()) {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      throw new AnimaError('anima/config-invalid', `quotas[${index}].limit must be a positive integer, got ${rule.limit}.`)
    }
  }
  for (const mode of ['day', 'night'] as const) {
    const m = config.modes[mode]
    if (m.minIntervalMinutes > m.maxIntervalMinutes) {
      throw new AnimaError('anima/config-invalid', `modes.${mode}: minIntervalMinutes (${m.minIntervalMinutes}) exceeds maxIntervalMinutes (${m.maxIntervalMinutes}).`)
    }
  }
  const names = new Set<string>()
  for (const need of config.needs) {
    if (names.has(need.name)) throw new AnimaError('anima/config-invalid', `needs: "${need.name}" is defined twice.`)
    names.add(need.name)
  }
  const quiet = config.initiate.quietHours.map(window => ({ from: minutes(window.from), to: minutes(window.to) }))
  return Object.freeze({ ...config, dataDir: expandHome(config.dataDir), day: resolveRhythm(config.rhythm), quiet })
}

function minutes(text: string): number {
  const [h, m] = text.split(':').map(Number) as [number, number]
  if (h > 23 || m > 59) throw new AnimaError('anima/config-invalid', `"${text}" is not a valid HH:mm time.`)
  return h * 60 + m
}

/**
 * Expand a leading `~` and make the path absolute.
 * @param path - user path.
 * @returns absolute path.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(path)
}
