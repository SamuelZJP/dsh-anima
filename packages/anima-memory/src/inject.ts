/**
 * What comes to mind (docs/design/memory.md, Coming to mind): the `[memory]`
 * message added at a step of her waking session. Cues pick the memories; every
 * memory says where it came from, and nothing is filtered by who will hear her.
 * Pure over the store.
 * @module @anima/memory/inject
 */

import { formatLocal, type ChannelRef } from '@anima/core'
import { estimateTokens } from './decay.ts'
import { sourceLabel } from './source.ts'
import type { Memory, MemoryStore } from './store.ts'

/** Looks up a channel as it is published now, for source labels. */
export type ChannelLookup = (key: string) => (ChannelRef & { readonly display?: string }) | undefined

/** One memory as a line of her context, with where it came from. */
export function memoryLine(memory: Memory, channel: ChannelLookup): string {
  const about = memory.personId === undefined ? '' : `，关于 ${memory.personId}`
  const label = sourceLabel(memory, memory.channelKey === undefined ? undefined : channel(memory.channelKey))
  return `- ${memory.id}（${memory.kind}${about}；${label}）：${memory.text}`
}

/** Cues of one `[memory]` message. */
export interface Cues {
  /** People who just wrote, or whose messages wait in her inbox. */
  readonly people: readonly string[]
  /** Channels that just wrote. */
  readonly channels: readonly string[]
  /** Text of what just arrived, for full-text recall. */
  readonly query: string
  /** Latest episodes to come to mind (at waking). */
  readonly latest: number
}

/** Inputs of one `[memory]` message. */
export interface BlockInput {
  readonly store: MemoryStore
  readonly cues: Cues
  /** Recent episodes per channel. */
  readonly channelEpisodes: number
  /** Memories already shown in this waking: not shown again. */
  readonly exclude: ReadonlySet<string>
  /** Lines that come first and are not memories (open goals, a chat from before she woke). */
  readonly extra?: readonly string[] | undefined
  readonly channel: ChannelLookup
  readonly tokenBudget: number
  readonly maxItems: number
}

/** Header of the `[memory]` message. */
export const MEMORY_HEADER = '[memory] 你此刻想起的事（每条写着你是从哪里知道的）：'

/**
 * Build the `[memory]` message: latest episodes (at waking), facts about the
 * people, recent episodes of the channels, then full-text hits, without
 * repeats, within the budget.
 * @returns the text and the memory ids it shows, or undefined when nothing comes to mind.
 */
export function buildBlock(input: BlockInput): { text: string; ids: string[] } | undefined {
  const { store, cues } = input
  const candidates: Memory[] = []
  if (cues.latest > 0) candidates.push(...store.latestEpisodes(cues.latest))
  for (const person of cues.people) candidates.push(...store.about(person, input.maxItems))
  for (const key of cues.channels) candidates.push(...store.recentEpisodes(key, input.channelEpisodes))
  candidates.push(...store.recall(cues.query, { limit: input.maxItems }))
  const lines: string[] = []
  const ids: string[] = []
  let tokens = estimateTokens(MEMORY_HEADER)
  for (const line of input.extra ?? []) {
    const cost = estimateTokens(line)
    if (tokens + cost > input.tokenBudget) break
    tokens += cost
    lines.push(line)
  }
  const memories: string[] = []
  for (const memory of candidates) {
    if (ids.includes(memory.id) || input.exclude.has(memory.id) || ids.length >= input.maxItems) continue
    const line = memoryLine(memory, input.channel)
    const cost = estimateTokens(line)
    if (tokens + cost > input.tokenBudget) continue
    tokens += cost
    memories.push(line)
    ids.push(memory.id)
  }
  if (lines.length === 0 && memories.length === 0) return undefined
  return { text: [MEMORY_HEADER, ...memories, ...lines].join('\n'), ids }
}

/**
 * Query text of an arrival: nothing for a heartbeat (her state's numbers would
 * match everything); otherwise the text without its clock stamp and place tag.
 * @param text - delivered message text.
 */
export function cueText(text: string): string {
  if (/^(\[[^\]]*\]\s*)*\[心跳\]/u.test(text)) return ''
  return text.replace(/^(\[[^\]]*\]\s*)+/u, '')
}

/** A history line as she remembers a chat from before she woke. */
export function historyLine(line: { readonly ts: number; readonly who: string; readonly text: string }): string {
  return `  ${formatLocal(line.ts).slice(5)} ${line.who}: ${line.text}`
}
