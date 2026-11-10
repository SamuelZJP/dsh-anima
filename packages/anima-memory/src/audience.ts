/**
 * Audience scopes (DESIGN §8): who may hear a memory. Code sets every scope
 * from the session a memory was learned in, and recall filters by who will
 * hear the answer. Privacy never depends on the model's choice. Pure.
 * @module @anima/memory/audience
 */

import type { SessionInfo } from '@anima/core'
import type { PersonLink } from './config.ts'

/** A scope: `private:<personId>`, `group:<channelKey>`, `owner`, `self` or `public`. */
export type Scope = string

/** Scope that only she hears (her inner life). */
export const SELF: Scope = 'self'
/** Scope everyone may hear. */
export const PUBLIC: Scope = 'public'
/** Scope of what the owner told her (across all the owner's accounts). */
export const OWNER: Scope = 'owner'

/** Every audience: the Self session hears everything. */
export const EVERYONE = Symbol('everyone')

/** Scopes a session may hear: a list, or {@link EVERYONE}. */
export type Audience = readonly Scope[] | typeof EVERYONE

/**
 * Person id of a platform account: `owner` for the owner, a linked id, or `platform:userId`.
 * @param platform - platform id.
 * @param userId - platform user id.
 * @param isOwner - from bound account ids, never message text.
 * @param persons - hand-linked persons.
 */
export function personOf(platform: string, userId: string, isOwner: boolean, persons: readonly PersonLink[]): string {
  if (isOwner) return 'owner'
  const account = `${platform}:${userId}`
  return persons.find(person => person.accounts.includes(account))?.id ?? account
}

/** What a scope decision needs to know about a session. */
export interface SessionFacts {
  readonly info: SessionInfo | undefined
  /** Whether a conversation's channel is the owner's own. */
  readonly isOwner: boolean
}

/**
 * The person on the other side of a private chat. By adapter convention a
 * private channel's `id` is the other party's platform user id.
 * @returns the person id, or undefined for anything but a private conversation.
 */
export function chatPerson(facts: SessionFacts, persons: readonly PersonLink[]): string | undefined {
  const { info } = facts
  if (info?.kind !== 'conversation' || info.channel.kind !== 'private') return undefined
  return personOf(info.channel.platform, info.channel.id, facts.isOwner, persons)
}

/**
 * Scope of what she learns in a session.
 * - private chat: `private:<personId>`, or `owner` in the owner's own chat
 * - any other channel kind (group, thread): `group:<channelKey>`
 * - Self and consolidation: `self`
 * @returns the scope, or undefined where she learns nothing (triage, non-Anima sessions).
 */
export function learnScope(facts: SessionFacts, persons: readonly PersonLink[]): Scope | undefined {
  const { info } = facts
  if (info === undefined || info.kind === 'triage' || info.kind === 'group-triage') return undefined
  if (info.kind === 'self' || info.kind === 'consolidation') return SELF
  const person = chatPerson(facts, persons)
  if (person !== undefined) return person === 'owner' ? OWNER : `private:${person}`
  return `group:${info.channelKey}`
}

/**
 * Scopes that may be heard in a session.
 * - a conversation hears its own scope and `public`
 * - Self hears everything
 * - triage, consolidation and non-Anima sessions hear nothing (consolidation gets its input explicitly)
 */
export function audienceOf(facts: SessionFacts, persons: readonly PersonLink[]): Audience {
  const { info } = facts
  if (info?.kind === 'self') return EVERYONE
  if (info?.kind !== 'conversation') return []
  const own = learnScope(facts, persons)
  return own === undefined ? [PUBLIC] : [own, PUBLIC]
}

/** Whether a scope may be heard by an audience. */
export function hears(audience: Audience, scope: Scope): boolean {
  return audience === EVERYONE || audience.includes(scope)
}

/** Narrowing she may choose: keep it with the people here, or only to herself. */
export type Keep = 'here' | 'self'

/**
 * Scope of a memory she keeps. `keep: 'self'` is the only narrowing; there is
 * no way to widen a scope.
 * @param learned - the session's learn scope.
 * @param keep - her choice.
 */
export function narrow(learned: Scope, keep: Keep | undefined): Scope {
  return keep === 'self' ? SELF : learned
}

/** Human-readable label of a scope for her context, e.g. `private chat with local:alice`. */
export function describeScope(scope: Scope): string {
  if (scope === SELF) return 'only you'
  if (scope === PUBLIC) return 'public'
  if (scope === OWNER) return 'the owner'
  if (scope.startsWith('private:')) return `private, ${scope.slice('private:'.length)}`
  if (scope.startsWith('group:')) return `group ${scope.slice('group:'.length)}`
  return scope
}
