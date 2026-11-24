/**
 * Anima core configuration: identity, data directory, her clock and
 * physiology (genes). Safety limits are not here: they are the guard's (outside the persona).
 * @module @anima/core/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { ClockConfig } from './clock.ts'
import { checkSleepGenes, type SleepGenes } from './sleep.ts'
import { DEFAULT_NEEDS, type EnergyConfig, type MoodConfig, type NeedSpec } from './state.ts'
import { AnimaError } from './types.ts'

/** A model: DSH provider id and provider model id. */
export interface ModelRoute {
  /** DSH provider id, e.g. `deepseek-official`. */
  provider: string
  /** Provider model id, e.g. `deepseek-flash` (DeepSeek-V4.1-Flash). */
  model: string
}

/** Plugin config of `@anima/core`. */
export interface Config {
  /** Character identity, part of every session id. */
  characterId: string
  /** Her name, used in the default persona card. */
  name: string
  /** Plugin data directory; `~` expands to the home directory. */
  dataDir: string
  /** Her clock. */
  clock: ClockConfig
  /** Her sleep (genes). */
  sleep: SleepGenes
  /** Needs. */
  needs: NeedSpec[]
  /** Energy tuning. */
  energy: EnergyConfig
  /** Mood tuning. */
  mood: MoodConfig
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
  { path: ['rhythm'], why: 'no clock time decides when she sleeps or wakes (R4): her sleep pressure does, with the genes in sleep { risePerHour, fallPerHour, fallAsleepAbove, overwhelmAbove, wakeBelow }' },
  { path: ['modes'], why: 'there are no day and night modes (R4): her waking session has one model, waking.model on the anima-life row, and asleep she has no turns but sleep\'s own' },
  { path: ['selfGeneration'], why: 'there is no Self session (R4): each waking opens a new session of its own' },
  { path: ['conversationGeneration'], why: 'there are no conversation sessions (R4): each waking opens a new session of its own' },
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

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  characterId: z.string().pattern(/^[a-z][a-z0-9-]*$/).default('anima')
    .description('Character identity, part of every session id. Changing it starts new sessions.'),
  name: z.string().default('Anima').description('Her name, used in the default constitution.'),
  dataDir: z.string().default('~/.anima').description('Plugin data directory.'),
  clock: z.object({
    speed: z.number().min(1).default(1).description('Simulated time per real time; 1 is real time. A test day uses e.g. 16.'),
    start: z.string().description('Simulated local start time, e.g. 2026-11-10T07:00. Omit to start at the real time.'),
  }).description('Her clock, the single time source.'),
  sleep: z.object({
    risePerHour: z.number().min(0).default(0.055).description('Sleep pressure gained per awake hour.'),
    fallPerHour: z.number().min(0).default(0.11).description('Sleep pressure lost per sleeping hour.'),
    fallAsleepAbove: z.number().min(0).max(1).default(0.6).description('Above this pressure, sleep comes when she goes to bed.'),
    overwhelmAbove: z.number().min(0).max(1).default(0.98).description('At or above this pressure, sleep takes her once her running turn ends.'),
    wakeBelow: z.number().min(0).max(1).default(0.1).description('At or below this pressure, asleep, she wakes by herself.'),
  }).description('Her sleep (genes, not rules): pressure rises awake and falls asleep; no clock time decides.'),
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
  heartbeat: z.object({
    restingMinutes: z.number().min(1).default(60).description('Her resting heart rhythm (a gene): minutes on her clock between beats. Nothing she does and nothing outside changes it.'),
  }).description('Her heart: the rhythm of her self-drive (genes, not limits).'),
  selfModel: z.object({
    digestChars: z.natural().min(0).default(600).description('Characters of the short self-model digest in conversation prompts.'),
  }).description('Her self-model.'),
}) as z<Config>

/** Validated config with `dataDir` resolved to an absolute path. */
export type ResolvedConfig = Readonly<Config>

/**
 * Validate and normalize config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 * @returns the resolved config.
 */
export function resolveConfig(input: Partial<Config> | undefined): ResolvedConfig {
  const raw = (input ?? {}) as Record<string, unknown>
  const moved: string[] = MOVED_TO_GUARD.filter(key => raw[key] !== undefined)
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
  checkSleepGenes(config.sleep)
  return Object.freeze({ ...config, dataDir: expandHome(config.dataDir) })
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
