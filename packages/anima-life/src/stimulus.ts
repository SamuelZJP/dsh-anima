/**
 * Stimuli and routing (DESIGN §5): channel stimuli go to that channel's
 * conversation session, everything else to the Self session.
 * @module @anima/life/stimulus
 */

import { channelKey, type ChannelRef } from '@anima/core'
import { conversationSessionId, selfSessionId } from './identity.ts'

/** A channel an adapter publishes, with a display name. */
export interface PublishedChannel extends ChannelRef {
  /** Human-readable name, e.g. `Owner (local)`. */
  readonly display: string
}

/** Who sent a message. */
export interface Sender {
  readonly platformUserId: string
  readonly displayName: string
  /** From bound account ids only, never from message text. */
  readonly isOwner: boolean
}

/** Phase 1 stimuli. */
export type Stimulus =
  | {
    readonly type: 'message'
    readonly channel: PublishedChannel
    readonly sender: Sender
    readonly text: string
    /** Epoch milliseconds. */
    readonly ts: number
  }
  | {
    /** A notice for her inner life, e.g. from the owner via `/anima self`. */
    readonly type: 'notice'
    readonly text: string
    readonly ts: number
  }

/** Where a stimulus goes. */
export type Route =
  | { readonly kind: 'conversation'; readonly sessionId: string; readonly channel: PublishedChannel; readonly channelKey: string }
  | { readonly kind: 'self'; readonly sessionId: string }

/**
 * Route one stimulus to exactly one session.
 * @param characterId - character identity.
 * @param stimulus - the stimulus.
 * @returns the target session.
 */
export function route(characterId: string, stimulus: Stimulus): Route {
  switch (stimulus.type) {
    case 'message': {
      const key = channelKey(stimulus.channel)
      return { kind: 'conversation', sessionId: conversationSessionId(characterId, key), channel: stimulus.channel, channelKey: key }
    }
    case 'notice':
      return { kind: 'self', sessionId: selfSessionId(characterId) }
  }
}

/**
 * Model-facing text of a stimulus.
 * @returns e.g. `[local private "Owner (local)"] Sam (owner): hello`.
 */
export function stimulusText(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': {
      const { channel, sender } = stimulus
      return `[${channel.platform} ${channel.kind} ${JSON.stringify(channel.display)}] ${sender.displayName}${sender.isOwner ? ' (owner)' : ''}: ${stimulus.text}`
    }
    case 'notice':
      return `[notice] ${stimulus.text}`
  }
}

/** One-line summary shown on the collapsed context row. */
export function stimulusSummary(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': return `${stimulus.sender.displayName} on ${stimulus.channel.platform}: ${stimulus.text}`
    case 'notice': return `Notice: ${stimulus.text}`
  }
}
