/**
 * Anima core configuration: identity, data directory and gate policy.
 * @module @anima/core/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { AnimaError, EFFECT_CLASSES, type EffectClass } from './types.ts'

/** Which counter a quota rule keeps. */
export type QuotaScope = 'channel' | 'platform' | 'global'

/** One sliding-window quota. A call counts against every rule it matches. */
export interface QuotaRule {
  /** Only behaviors of this effect class; all when omitted. */
  effect?: EffectClass
  /** Only this behavior (tool name); all when omitted. */
  behavior?: string
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

/** Plugin config of `@anima/core`. */
export interface Config {
  /** Character identity, part of every session id. */
  characterId: string
  /** Her name, used in the default constitution. */
  name: string
  /** Plugin data directory; `~` expands to the home directory. */
  dataDir: string
  /** Quotas checked by the policy gate. */
  quotas: QuotaRule[]
  /** Owner allow rules for `public` and `irreversible` behaviors. */
  allow: AllowRule[]
}

/** Default quotas: modest per-channel speech, a daily global ceiling. */
export const DEFAULT_QUOTAS: QuotaRule[] = [
  { effect: 'express', per: 'channel', limit: 30, windowMinutes: 60 },
  { per: 'global', limit: 200, windowMinutes: 24 * 60 },
]

const effect = z.union(EFFECT_CLASSES.map(value => z.const(value))) as z<EffectClass>

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  characterId: z.string().pattern(/^[a-z][a-z0-9-]*$/).default('anima')
    .description('Character identity, part of every session id. Changing it starts new sessions.'),
  name: z.string().default('Anima').description('Her name, used in the default constitution.'),
  dataDir: z.string().default('~/.anima').description('Plugin data directory.'),
  quotas: z.array(z.object({
    effect,
    behavior: z.string(),
    per: z.union([z.const('channel'), z.const('platform'), z.const('global')]).required(),
    limit: z.number().min(1).required(),
    windowMinutes: z.number().min(1).required(),
  })).default(DEFAULT_QUOTAS).description('Sliding-window quotas checked by the policy gate.'),
  allow: z.array(z.object({ behavior: z.string().required() })).default([])
    .description('Owner rules letting public or irreversible behaviors run without approval.'),
}) as z<Config>

/** Validated config with `dataDir` resolved to an absolute path. */
export type ResolvedConfig = Readonly<Config>

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
