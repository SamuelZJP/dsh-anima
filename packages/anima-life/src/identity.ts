/**
 * Deterministic session identity (DESIGN §5): the same channel always maps to
 * the same session, so there is no mapping table to corrupt.
 * @module @anima/life/identity
 */

import { createHash } from 'node:crypto'

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)
}

/**
 * Conversation session id of a channel.
 * @param characterId - character identity.
 * @param key - channel key `platform:account:kind:id`.
 * @returns `anima-c-<24 hex>`.
 */
export function conversationSessionId(characterId: string, key: string): string {
  return `anima-c-${digest('conversation', characterId, key)}`
}

/**
 * Self session id of a character.
 * @param characterId - character identity.
 * @returns `anima-self-<24 hex>`.
 */
export function selfSessionId(characterId: string): string {
  return `anima-self-${digest('self', characterId)}`
}
