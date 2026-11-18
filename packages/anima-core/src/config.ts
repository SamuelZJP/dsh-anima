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
  /** Per-mode models. */
  modes: Record<Mode, ModeConfig>
  /** Her heart (genes): the rhythm of her self-drive. */
  heartbeat: {
    /** Her resting rhythm: minutes on her clock between beats. */
    restingMinutes: number
  }
  /** Her self-model. */
  selfModel: {
    /** Characters of the short digest in conversation prompts. */
    digestChars: number
  }
}

/** Keys that moved to the `anima-guard` row (R1): set on core, they fail the load. */
const MOVED_TO_GUARD = ['quotas', 'limits', 'allow', 'approve', 'approvals', 'initiate'] as const

/**
 * Keys removed in R2 because they were rules inside the persona, not her body
 * (docs/CONSTITUTION.md): set, they fail the load with the reason.
 */
const REMOVED: readonly { path: readonly string[]; why: string }[] = [
  ...(['day', 'night'] as const).flatMap(mode => (['minIntervalMinutes', 'maxIntervalMinutes', 'defaultIntervalMinutes', 'maxWakes'] as const).map(key => ({
    path: ['modes', mode, key],
    why: 'her heartbeat is her self-drive, not something she or anyone chooses or bounds; its rhythm is heartbeat.restingMinutes (a gene)',
  }))),
  ...(['maxEntries', 'maxEntryChars', 'changesPerDay'] as const).map(key => ({
    path: ['selfModel', key],
    why: 'nothing inside the persona limits her self-model; the owner can revert changes from outside',
  })),
]

function valueAt(raw: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = raw
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** Default model: DeepSeek-V4.1-Flash on the official API. */
export const DEFAULT_MODEL: ModelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }

const effect = z.union(EFFECT_CLASSES.map(value => z.const(value))) as z<EffectClass>

const modelRoute = z.object({
  provider: z.string().default(DEFAULT_MODEL.provider),
  model: z.string().default(DEFAULT_MODEL.model),
})

function modeSchema(defaults: { effects: EffectClass[] }) {
  return z.object({
    triageModel: modelRoute.description('Model of triage turns.'),
    actionModel: modelRoute.description('Model of action turns in the Self session.'),
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
    day: modeSchema({ effects: [...EFFECT_CLASSES] }),
    night: modeSchema({ effects: ['observe', 'internal'] }),
  }).description('Per-mode models.'),
  heartbeat: z.object({
    restingMinutes: z.number().min(1).default(60).description('Her resting heart rhythm (a gene): minutes on her clock between beats. Nothing she does and nothing outside changes it.'),
  }).description('Her heart: the rhythm of her self-drive (genes, not limits).'),
  selfModel: z.object({
    digestChars: z.natural().min(0).default(600).description('Characters of the short self-model digest in conversation prompts.'),
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
  const removed = REMOVED.filter(entry => valueAt(raw, entry.path) !== undefined)
  if (removed.length > 0) {
    throw new AnimaError('anima/config-removed', removed.map(entry => `${entry.path.join('.')} is gone: ${entry.why}`).join('; ') + '. Remove it from the anima-core row.')
  }
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-core row in cordis.yml.`)
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
