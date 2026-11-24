/**
 * Anima memory plugin (docs/design/memory.md): one memory for every channel,
 * each memory with its source as a label. What comes to mind, recall,
 * consolidation in sleep from each ended waking's log, and decay.
 * @module @anima/memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import type {} from '@anima/life'
import { Config as ConfigSchema, resolveMemoryConfig, type Config as MemoryConfig } from './config.ts'
import { AnimaMemory } from './service.ts'

export { chatPerson, OWNER, personOf, sourceLabel, type SourceFacts } from './source.ts'
export { resolveMemoryConfig, type ConsolidationConfig, type DecayConfig, type PersonLink } from './config.ts'
export { decayStep, estimateTokens, gistOf, halfLife, type DecayInput, type DecayResult, type MemoryKind } from './decay.ts'
export { buildBlock, cueText, historyLine, MEMORY_HEADER, memoryLine, type BlockInput, type ChannelLookup, type Cues } from './inject.ts'
export { channelsIn, cutPieces, pieceFacts, renderLog, type LogLine, type Piece, type RenderOptions } from './log.ts'
export { MemoryStore, rowId, searchTerms, type Memory, type MemoryStatus, type NewMemory, type WakingProgress } from './store.ts'
export { AnimaMemory } from './service.ts'

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
