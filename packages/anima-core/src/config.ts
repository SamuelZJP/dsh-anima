/**
 * Anima core configuration: identity, data directory, her clock, rhythm and
 * physiology. Safety limits are not here: they are the guard's (outside the persona).
 * @module @anima/core/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { ClockConfig } from './clock.ts'
import { resolveRhythm, type Mode, type Rhythm, type RhythmConfig } from './rhythm.ts'
import { DEFAULT_NEEDS, type EnergyConfig, type MoodConfig, type NeedSpec } from './state.ts'
import { AnimaError, EFFECT_CLASSES, type EffectClass } from './types.ts'

/** A model: DSH provider id and provider model id. */
export interface ModelRoute {
  /** DSH provider id, e.g. `deepseek-official`. */
  provider: string
  /** Provider model id, e.g. `deepseek-flash` (DeepSeek-V4.1-Flash). */
  model: string
}

/** Settings of one mode: awake (`day`) or asleep (`night`). */
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
  /** Wake-ups per night (night). */
  maxWakes: number
  /** Effect classes her body can do in this mode (asleep: only inner things). */
  allowedEffects: EffectClass[]
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
  /**
   * Generation of her conversation sessions. Raising it starts a fresh session
   * in every chat; the old ones stay in the sidebar, and memory carries over.
   */
  conversationGeneration: number
  /** Her name, used in the default persona card. */
  name: string
  /** Plugin data directory; `~` expands to the home directory. */
  dataDir: string
  /** Her clock. */
  clock: ClockConfig
  /** Day rhythm. */
  rhythm: RhythmConfig
  /** Needs. */
  needs: NeedSpec[]
  /** Energy tuning. */
  energy: EnergyConfig
  /** Mood tuning. */
  mood: MoodConfig
  /** Per-mode models and intervals. */
  modes: Record<Mode, ModeConfig>
  /** Her self-model. */
  selfModel: {
    /** Most notes she may keep. */
    maxEntries: number
    /** Longest note, in characters. */
    maxEntryChars: number
    /** Characters of the short digest in conversation prompts. */
    digestChars: number
    /** Changes her self-model takes in 24 hours: it changes slowly (physiology). */
    changesPerDay: number
  }
}

/** Keys that moved to the `anima-guard` row (R1): set on core, they fail the load. */
const MOVED_TO_GUARD = ['quotas', 'limits', 'allow', 'approve', 'approvals', 'initiate'] as const

/** Default model: DeepSeek-V4.1-Flash on the official API. */
export const DEFAULT_MODEL: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }

const effect = z.union(EFFECT_CLASSES.map(value => z.const(value))) as z<EffectClass>

const modelRoute = z.object({
  provider: z.string().default(DEFAULT_MODEL.provider),
  model: z.string().default(DEFAULT_MODEL.model),
})

function modeSchema(defaults: { min: number; max: number; def: number; wakes: number; effects: EffectClass[] }) {
  return z.object({
    triageModel: modelRoute.description('Model of triage turns.'),
    actionModel: modelRoute.description('Model of action turns in the Self session.'),
    minIntervalMinutes: z.number().min(1).default(defaults.min).description('Shortest heartbeat interval she may choose.'),
    maxIntervalMinutes: z.number().min(1).default(defaults.max).description('Longest heartbeat interval she may choose.'),
    defaultIntervalMinutes: z.number().min(1).default(defaults.def).description('Interval when she does not choose one.'),
    maxWakes: z.number().min(0).default(defaults.wakes).description('Wake-ups allowed per night.'),
    allowedEffects: z.array(effect).default(defaults.effects).description('Effect classes her body can do in this mode.'),
  })
}

const hhmm = z.string().pattern(/^\d{1,2}:\d{2}$/)

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  characterId: z.string().pattern(/^[a-z][a-z0-9-]*$/).default('anima')
    .description('Character identity, part of every session id. Changing it starts new sessions.'),
  selfGeneration: z.natural().min(1).default(1)
    .description('Generation of her Self session. Raising it starts a fresh Self session; state and goals carry over.'),
  conversationGeneration: z.natural().min(1).default(2)
    .description('Generation of her conversation sessions. Raising it starts a fresh session in every chat; memory carries over.'),
  name: z.string().default('Anima').description('Her name, used in the default constitution.'),
  dataDir: z.string().default('~/.anima').description('Plugin data directory.'),
  clock: z.object({
    speed: z.number().min(1).default(1).description('Simulated time per real time; 1 is real time. A test day uses e.g. 16.'),
    start: z.string().description('Simulated local start time, e.g. 2026-11-10T07:00. Omit to start at the real time.'),
  }).description('Her clock, the single time source.'),
  rhythm: z.object({
    wake: hhmm.default('07:30'),
    bedtime: z.object({
      earliest: hhmm.default('22:30').description('From this time she may go to sleep with sleep.'),
      latest: hhmm.default('00:30').description('At this time she falls asleep anyway, if she is not asleep yet.'),
      wokenMinutes: z.number().min(0).default(30).description('After the owner wakes her past the latest bedtime, minutes she stays awake unless she sleeps sooner.'),
    }).description('The bedtime window: she chooses when to sleep inside it (Phase 9).'),
    wakingMinutes: z.number().min(0).default(60),
    evening: hhmm.default('18:00'),
    windDownMinutes: z.number().min(0).default(60).description('Length of winding down before the latest bedtime.'),
    sleep: z.string().description('Removed in Phase 9: use bedtime { earliest, latest }. Set, it fails the load.'),
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
    day: modeSchema({ min: 20, max: 240, def: 60, wakes: 0, effects: [...EFFECT_CLASSES] }),
    night: modeSchema({ min: 20, max: 480, def: 60, wakes: 1, effects: ['observe', 'internal'] }),
  }).description('Per-mode models and heartbeat intervals.'),
  selfModel: z.object({
    maxEntries: z.natural().min(1).default(40).description('Most self-model notes she may keep.'),
    maxEntryChars: z.natural().min(20).default(200).description('Longest self-model note, in characters.'),
    digestChars: z.natural().min(0).default(600).description('Characters of the short self-model digest in conversation prompts.'),
    changesPerDay: z.natural().min(1).default(3).description('Changes her self-model takes in 24 hours; it changes slowly.'),
  }).description('Her self-model.'),
}) as z<Config>

/** Validated config with `dataDir` resolved to an absolute path and times parsed. */
export type ResolvedConfig = Readonly<Config> & {
  readonly day: Rhythm
}

/**
 * Validate and normalize config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 * @returns the resolved config.
 */
export function resolveConfig(input: Partial<Config> | undefined): ResolvedConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const moved: string[] = MOVED_TO_GUARD.filter(key => raw[key] !== undefined)
  const modes = raw.modes as Record<string, Record<string, unknown> | undefined> | undefined
  if (modes?.day?.tokenBudget !== undefined || modes?.night?.tokenBudget !== undefined) moved.push('modes.*.tokenBudget')
  if (moved.length > 0) {
    throw new AnimaError('anima/config-moved', `${moved.join(', ')} moved to the anima-guard row (safety limits live outside the persona). Move them there; modes.day/night.tokenBudget becomes budget.day/night.`)
  }
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-core row in cordis.yml.`)
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
  return Object.freeze({ ...config, dataDir: expandHome(config.dataDir), day: resolveRhythm(config.rhythm) })
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
