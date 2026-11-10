/**
 * Anima memory configuration: person links, auto-injection budget, decay and
 * consolidation (DESIGN §8). Every tunable is a validated field.
 * @module @anima/memory/config
 */

import z from '@deepseek-ai/schemastery'
import { AnimaError, DEFAULT_MODEL, type ModelRoute } from '@anima/core'

/** A person with accounts on one or more platforms, linked by hand (DESIGN §3). */
export interface PersonLink {
  /** Person id used in scopes, e.g. `alice` gives `private:alice`. */
  id: string
  /** Accounts `platform:userId`, e.g. `qq:12345`, `local:alice`. */
  accounts: string[]
}

/** Decay tuning (DESIGN §8 Forgetting). */
export interface DecayConfig {
  /** Half-life in days of an episode with no importance and no recalls. */
  halfLifeDays: number
  /** Multiplier on the half-life of facts (facts last longer than episodes). */
  factFactor: number
  /** Extra half-life per recall, as a fraction (0.5 = +50 % per recall). */
  recallBonus: number
  /** Strength below which a memory is compressed to a one-line gist. */
  gistBelow: number
  /** Strength below which a memory leaves the active index for the archive. */
  archiveBelow: number
  /** Maximum characters of a gist. */
  gistChars: number
}

/** Consolidation tuning. */
export interface ConsolidationConfig {
  /** Model of the consolidation session (a cheap one). */
  model: ModelRoute
  /** Most transcript tokens handed to one consolidation run. */
  maxInputTokens: number
  /** Run consolidation without her when the oldest pending line is older than this (hours on her clock). */
  fallbackHours: number
  /** Real seconds a consolidation run may take before it is given up and retried. */
  timeoutSeconds: number
}

/** Plugin config of `@anima/memory`. */
export interface Config {
  /** Hand-linked persons. Unlinked accounts are persons of their own (`platform:userId`). */
  persons: PersonLink[]
  /** Auto-injection at turn start. */
  inject: {
    /** Token budget of the injected memory block. */
    tokenBudget: number
    /** Most memories in the block. */
    maxItems: number
  }
  decay: DecayConfig
  consolidation: ConsolidationConfig
}

const modelRoute = z.object({
  provider: z.string().default(DEFAULT_MODEL.provider),
  model: z.string().default(DEFAULT_MODEL.model),
})

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  persons: z.array(z.object({
    id: z.string().pattern(/^[A-Za-z0-9_.:-]+$/).required(),
    accounts: z.array(z.string().pattern(/^[a-z][a-z0-9_-]*:.+$/)).default([]),
  })).default([]).description('Persons linked across platforms; accounts are "platform:userId".'),
  inject: z.object({
    tokenBudget: z.number().min(0).default(800).description('Token budget of the memory block injected at each turn start.'),
    maxItems: z.natural().min(1).default(12).description('Most memories in the injected block.'),
  }),
  decay: z.object({
    halfLifeDays: z.number().min(0.01).default(7),
    factFactor: z.number().min(1).default(4),
    recallBonus: z.number().min(0).default(0.5),
    gistBelow: z.number().min(0).max(1).default(0.2),
    archiveBelow: z.number().min(0).max(1).default(0.05),
    gistChars: z.natural().min(20).default(80),
  }).description('Daily decay of memory strength.'),
  consolidation: z.object({
    model: modelRoute.description('Model of the consolidation session.'),
    maxInputTokens: z.natural().min(200).default(6000).description('Most transcript tokens per consolidation run.'),
    fallbackHours: z.number().min(0.05).default(24).description('Consolidate without her when the oldest pending line is older than this (her clock).'),
    timeoutSeconds: z.number().min(10).default(600).description('Real seconds before a stuck run is given up.'),
  }),
}) as z<Config>

/**
 * Validate config. Fails loud with `anima/config-invalid`.
 * @param input - raw config.
 */
export function resolveMemoryConfig(input: Partial<Config> | undefined): Readonly<Config> {
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-memory row in cordis.yml.`)
  }
  if (config.decay.archiveBelow >= config.decay.gistBelow) {
    throw new AnimaError('anima/config-invalid', `decay.archiveBelow (${config.decay.archiveBelow}) must be below decay.gistBelow (${config.decay.gistBelow}).`)
  }
  const seen = new Map<string, string>()
  for (const person of config.persons) {
    if (person.id === 'owner') throw new AnimaError('anima/config-invalid', 'persons: "owner" is reserved; the owner is identified by bound accounts.')
    for (const account of person.accounts) {
      const other = seen.get(account)
      if (other !== undefined) throw new AnimaError('anima/config-invalid', `persons: account "${account}" is linked to both "${other}" and "${person.id}".`)
      seen.set(account, person.id)
    }
  }
  return Object.freeze(config)
}
