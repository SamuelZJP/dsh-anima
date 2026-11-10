/**
 * Stimuli and routing (DESIGN §5): channel stimuli go to that channel's
 * conversation session, heartbeats to the day's triage session or to Self,
 * everything else to the Self session.
 * @module @anima/life/stimulus
 */

import { channelKey, type ChannelRef } from '@anima/core'
import { conversationSessionId, selfSessionId, triageSessionId } from './identity.ts'

/** A channel an adapter publishes, with a display name. */
export interface PublishedChannel extends ChannelRef {
  /** Human-readable name, e.g. `Owner (local)`. */
  readonly display: string
  /** Whether this is the owner's own channel (from bound account ids, never message text). */
  readonly isOwner?: boolean
}

/** Who sent a message. */
export interface Sender {
  readonly platformUserId: string
  readonly displayName: string
  /** From bound account ids only, never from message text. */
  readonly isOwner: boolean
}

/** Stimuli. */
export type Stimulus =
  | {
    readonly type: 'message'
    readonly channel: PublishedChannel
    readonly sender: Sender
    readonly text: string
    /** Epoch milliseconds on her clock. */
    readonly ts: number
  }
  | {
    /** A notice for her inner life, e.g. from the owner via `/anima self`. */
    readonly type: 'notice'
    readonly text: string
    readonly ts: number
  }
  | {
    /** A heartbeat: the situation report, to the triage session of her day or to Self. */
    readonly type: 'heartbeat'
    readonly to: 'triage' | 'self'
    /** Her day key, naming the triage session. */
    readonly day: string
    readonly text: string
    readonly ts: number
  }
  | {
    /** Self decided to start a conversation (DESIGN §5 intent handoff). */
    readonly type: 'intent'
    readonly channel: PublishedChannel
    readonly intentId: string
    readonly intent: string
    readonly context?: string | undefined
    readonly ts: number
  }

/** Where a stimulus goes. */
export type Route =
  | { readonly kind: 'conversation'; readonly sessionId: string; readonly channel: PublishedChannel; readonly channelKey: string }
  | { readonly kind: 'self'; readonly sessionId: string }
  | { readonly kind: 'triage'; readonly sessionId: string; readonly day: string }

/**
 * Route one stimulus to exactly one session.
 * @param characterId - character identity.
 * @param stimulus - the stimulus.
 * @returns the target session.
 */
export function route(characterId: string, stimulus: Stimulus, selfGeneration = 1): Route {
  switch (stimulus.type) {
    case 'message':
    case 'intent': {
      const key = channelKey(stimulus.channel)
      return { kind: 'conversation', sessionId: conversationSessionId(characterId, key), channel: stimulus.channel, channelKey: key }
    }
    case 'heartbeat':
      return stimulus.to === 'triage'
        ? { kind: 'triage', sessionId: triageSessionId(characterId, stimulus.day), day: stimulus.day }
        : { kind: 'self', sessionId: selfSessionId(characterId, selfGeneration) }
    case 'notice':
      return { kind: 'self', sessionId: selfSessionId(characterId, selfGeneration) }
  }
}

/**
 * Model-facing text of a stimulus, without the clock stamp.
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
    case 'heartbeat':
      return `[heartbeat]\n${stimulus.text}`
    case 'intent': {
      const { channel } = stimulus
      return [
        `[intent from your Self] (${stimulus.intentId}) You decided to start a conversation here, in ${channel.platform} ${channel.kind} ${JSON.stringify(channel.display)}.`,
        `What you want: ${stimulus.intent}`,
        ...stimulus.context === undefined || stimulus.context === '' ? [] : [`Context: ${stimulus.context}`],
        `Write your own words and send them with ${channel.platform}_say, or call stay_silent(reason) if on reflection it is not the right moment.`,
      ].join('\n')
    }
  }
}

/** One-line summary shown on the collapsed context row. */
export function stimulusSummary(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': return `${stimulus.sender.displayName} on ${stimulus.channel.platform}: ${stimulus.text}`
    case 'notice': return `Notice: ${stimulus.text}`
    case 'heartbeat': return stimulus.to === 'triage' ? 'Heartbeat' : 'Heartbeat: acting'
    case 'intent': return `Intent: ${stimulus.intent}`
  }
}

/** Reference recorded in the message source, so session events can be tied back (intent id). */
export function stimulusRef(stimulus: Stimulus): string | undefined {
  return stimulus.type === 'intent' ? stimulus.intentId : undefined
}
