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
 * @param generation - Self session generation; 1 keeps the original id.
 * @returns `anima-self-<24 hex>`.
 */
export function selfSessionId(characterId: string, generation = 1): string {
  return generation === 1 ? `anima-self-${digest('self', characterId)}` : `anima-self-${digest('self', characterId, String(generation))}`
}

/**
 * Triage session id of one of her days (one session per day keeps triage history short).
 * @param characterId - character identity.
 * @param day - her day key, `YYYY-MM-DD`.
 * @returns `anima-t-<24 hex>`.
 */
export function triageSessionId(characterId: string, day: string): string {
  return `anima-t-${digest('triage', characterId, day)}`
}

/**
 * Consolidation session id of one of her days (DESIGN §8): one short session per night.
 * @param characterId - character identity.
 * @param day - her day key, `YYYY-MM-DD`.
 * @returns `anima-m-<24 hex>`.
 */
export function consolidationSessionId(characterId: string, day: string): string {
  return `anima-m-${digest('consolidation', characterId, day)}`
}

/**
 * Group-triage session id of one of her days (DESIGN §5): one short session per day.
 * @param characterId - character identity.
 * @param day - her day key, `YYYY-MM-DD`.
 * @returns `anima-g-<24 hex>`.
 */
export function groupTriageSessionId(characterId: string, day: string): string {
  return `anima-g-${digest('group-triage', characterId, day)}`
}
