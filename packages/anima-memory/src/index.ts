/**
 * Anima memory plugin: one store for every platform, scoped by audience
 * (DESIGN §8). Recall, auto-injection, consolidation and decay.
 * @module @anima/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import type {} from '@anima/life'
import { Config as ConfigSchema, resolveMemoryConfig, type Config as MemoryConfig } from './config.ts'
import { AnimaMemory } from './service.ts'

export { audienceOf, chatPerson, describeScope, EVERYONE, hears, learnScope, narrow, OWNER, personOf, PUBLIC, SELF, type Audience, type Keep, type Scope, type SessionFacts } from './audience.ts'
export { resolveMemoryConfig, type ConsolidationConfig, type DecayConfig, type PersonLink } from './config.ts'
export { decayStep, estimateTokens, gistOf, halfLife, type DecayInput, type DecayResult, type MemoryKind } from './decay.ts'
export { buildBlock, memoryLine, selfQuery, type BlockInput } from './inject.ts'
export { MemoryStore, rowId, searchTerms, type Memory, type MemoryStatus, type NewMemory, type Segment, type TranscriptLine } from './store.ts'
export { AnimaMemory, OBSERVATIONS, type Observation } from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-memory'
/** Services used by the plugin. */
export const inject = ['anima', 'animaLife', 'tools']

/** Plugin config. */
export type Config = MemoryConfig
/** Plugin config schema. */
export const Config = ConfigSchema

/**
 * Mount the memory service.
 * @param ctx - root context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  ctx.plugin(AnimaMemory, resolveMemoryConfig(config))
}
