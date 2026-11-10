/**
 * Automatic recall (DESIGN §8): the memory block injected at a turn start.
 * Everything is filtered by the session's audience in code and trimmed to a
 * token budget. Pure over the store.
 * @module @anima/memory/inject
 */

import { formatLocal } from '@anima/core'
import { describeScope, EVERYONE, type Audience } from './audience.ts'
import { estimateTokens } from './decay.ts'
import type { Memory, MemoryStore } from './store.ts'

/** Inputs of one memory block. */
export interface BlockInput {
  readonly store: MemoryStore
  readonly audience: Audience
  /** The person of a private chat, for their pinned facts. */
  readonly person?: string | undefined
  /** The channel, for its recent episodes. */
  readonly channelKey?: string | undefined
  /** Text of what just arrived, for full-text recall. */
  readonly query: string
  readonly tokenBudget: number
  readonly maxItems: number
}

/** One memory as a line of her context. */
export function memoryLine(memory: Memory, showScope: boolean): string {
  const about = memory.personId === undefined ? '' : ` about ${memory.personId}`
  const scope = showScope ? `; heard by: ${describeScope(memory.scope)}` : ''
  return `- ${memory.id} (${memory.kind}${about}, ${formatLocal(memory.createdAt).slice(0, 10)}${scope}): ${memory.text}`
}

/**
 * Build the memory block: pinned facts about the person, recent episodes of
 * the channel, then full-text hits, without duplicates, within the budget.
 * @returns the text and the ids it shows, or undefined when nothing fits.
 */
export function buildBlock(input: BlockInput): { text: string; ids: string[] } | undefined {
  const { store, audience } = input
  const candidates: Memory[] = []
  if (input.person !== undefined) candidates.push(...store.about(input.person, audience, input.maxItems))
  if (input.channelKey !== undefined) candidates.push(...store.recentEpisodes(input.channelKey, audience, 3))
  candidates.push(...store.recall(input.query, audience, { limit: input.maxItems }))
  const showScope = audience === EVERYONE
  const header = showScope
    ? '[memory] Things you remember that may matter now (each says who may hear it):'
    : '[memory] Things you remember that may be shared in this chat:'
  const lines: string[] = []
  const ids: string[] = []
  let tokens = estimateTokens(header)
  for (const memory of candidates) {
    if (ids.includes(memory.id) || ids.length >= input.maxItems) continue
    const line = memoryLine(memory, showScope)
    const cost = estimateTokens(line)
    if (tokens + cost > input.tokenBudget) continue
    tokens += cost
    lines.push(line)
    ids.push(memory.id)
  }
  if (ids.length === 0) return undefined
  return { text: [header, ...lines].join('\n'), ids }
}

/**
 * Query text of a Self turn: for a heartbeat, only what she woke up wanting
 * (the report's numbers would match everything); otherwise the whole text.
 * @param text - delivered message text.
 */
export function selfQuery(text: string): string {
  const marker = 'You woke up wanting to:'
  const at = text.indexOf(marker)
  if (at >= 0) return text.slice(at + marker.length).split('\n')[0] ?? ''
  if (text.includes('[heartbeat]')) return ''
  return text
}
