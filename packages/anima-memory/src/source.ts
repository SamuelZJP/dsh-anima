/**
 * Where a memory came from (docs/design/memory.md, Where every memory came
 * from): the channel, the person, when. A label she reads, never a filter. Pure.
 * @module @anima/memory/source
 */

import { formatLocal, placeName, type ChannelRef } from '@anima/core'
import type { PersonLink } from './config.ts'

/** The owner's person id (across all the owner's accounts). */
export const OWNER = 'owner'

/**
 * Person id of a platform account: `owner` for the owner, a linked id, or `platform:userId`.
 * @param platform - platform id.
 * @param userId - platform user id.
 * @param isOwner - from bound account ids, never message text.
 * @param persons - hand-linked persons.
 */
export function personOf(platform: string, userId: string, isOwner: boolean, persons: readonly PersonLink[]): string {
  if (isOwner) return OWNER
  const account = `${platform}:${userId}`
  return persons.find(person => person.accounts.includes(account))?.id ?? account
}

/**
 * The person on the other side of a private chat. By adapter convention a
 * private channel's `id` is the other party's platform user id.
 * @returns the person id, or undefined for anything but a private chat.
 */
export function chatPerson(channel: ChannelRef, isOwner: boolean, persons: readonly PersonLink[]): string | undefined {
  if (channel.kind !== 'private') return undefined
  return personOf(channel.platform, channel.id, isOwner, persons)
}

/** What a source label needs to know about a memory. */
export interface SourceFacts {
  /** Channel key it came from, if any. */
  readonly channelKey?: string | undefined
  /** Person id it came from, if any. */
  readonly fromPerson?: string | undefined
  /** That person's name when it was kept. */
  readonly fromName?: string | undefined
  readonly createdAt: number
}

/**
 * Her label of where a memory came from, in her language, e.g.
 * `来源：Alice，[demo 私聊「Alice」 demo:me:private:alice]，11-10 10:00`.
 * @param facts - the memory's source.
 * @param channel - the channel as it is published now, if it still is.
 */
export function sourceLabel(facts: SourceFacts, channel: (ChannelRef & { readonly display?: string }) | undefined): string {
  const when = formatLocal(facts.createdAt).slice(5)
  const who = facts.fromName ?? facts.fromPerson
  if (facts.channelKey === undefined) return `来源：你自己${who === undefined ? '' : `，${who}`}，${when}`
  const where = channel === undefined ? facts.channelKey : `${placeName(channel)} ${facts.channelKey}`
  return `来源：${who === undefined ? '' : `${who}，`}[${where}]，${when}`
}
