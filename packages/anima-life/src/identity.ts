/**
 * Session identity: her waking sessions are named from her character and the
 * moment the waking was prepared; a consolidation session from the waking it sorts.
 * @module @anima/life/identity
 */

import { createHash } from 'node:crypto'

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)
}

/**
 * Session id of one waking (docs/design/life.md).
 * @param characterId - character identity.
 * @param at - when it was prepared (she fell asleep, or her first waking), on her clock.
 * @returns `anima-w-<24 hex>`.
 */
export function wakingSessionId(characterId: string, at: number): string {
  return `anima-w-${digest('waking', characterId, String(at))}`
}

/**
 * Consolidation session id of one ended waking (docs/design/memory.md).
 * @param characterId - character identity.
 * @param waking - the ended waking session's id.
 * @returns `anima-m-<24 hex>`.
 */
export function consolidationSessionId(characterId: string, waking: string): string {
  return `anima-m-${digest('consolidation', characterId, waking)}`
}
