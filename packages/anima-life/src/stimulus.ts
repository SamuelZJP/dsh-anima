/**
 * Stimuli and routing (DESIGN §5): channel stimuli go to that channel's
 * conversation session, heartbeats to the day's triage session or to Self,
 * everything else to the Self session.
 * @module @anima/life/stimulus
 */

import { channelKey, type ChannelRef } from '@anima/core'
import { consolidationSessionId, conversationSessionId, groupTriageSessionId, selfSessionId, triageSessionId } from './identity.ts'

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
    /**
     * Group messages only: whether it addresses her directly (@, her name,
     * reply to her). Set by the adapter from platform data. Unaddressed group
     * messages are context and do not wake a turn (DESIGN §5).
     */
    readonly addressed?: boolean
    /** Platform message id, so she can reply to it. */
    readonly messageId?: string | undefined
  }
  | {
    /**
     * Something that happened in a channel that needs no answer (a recalled
     * message). Joins that conversation's next turn as context, only when the
     * session already exists; never wakes, never creates a session.
     */
    readonly type: 'channel-event'
    readonly channel: PublishedChannel
    readonly text: string
    readonly ts: number
  }
  | {
    /** Buffered group messages for the cheap group triage decision (DESIGN §5). */
    readonly type: 'group-batch'
    /** Her day key, naming the group-triage session. */
    readonly day: string
    /** Batch id, e.g. `b12`. */
    readonly batch: string
    readonly channel: PublishedChannel
    readonly text: string
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
  | {
    /** Sort unconsolidated conversation into memories (DESIGN §8), in the day's consolidation session. */
    readonly type: 'consolidate'
    /** Her day key, naming the consolidation session. */
    readonly day: string
    readonly text: string
    /** Reference recorded in the message source (the consolidation run id). */
    readonly run: string
    readonly ts: number
  }

/** Where a stimulus goes. */
export type Route =
  | { readonly kind: 'conversation'; readonly sessionId: string; readonly channel: PublishedChannel; readonly channelKey: string }
  | { readonly kind: 'self'; readonly sessionId: string }
  | { readonly kind: 'triage'; readonly sessionId: string; readonly day: string }
  | { readonly kind: 'consolidation'; readonly sessionId: string; readonly day: string }
  | { readonly kind: 'group-triage'; readonly sessionId: string; readonly day: string }

/**
 * Whether a stimulus wakes a turn by default. Group messages wake only when
 * they address her or come from the owner (DESIGN §5); channel events never do.
 * (Life sends other group messages through group triage first.)
 */
export function wakes(stimulus: Stimulus): boolean {
  if (stimulus.type === 'channel-event') return false
  if (stimulus.type !== 'message' || stimulus.channel.kind !== 'group') return true
  return stimulus.addressed === true || stimulus.sender.isOwner
}

/**
 * Route one stimulus to exactly one session.
 * @param characterId - character identity.
 * @param stimulus - the stimulus.
 * @returns the target session.
 */
export function route(characterId: string, stimulus: Stimulus, selfGeneration = 1): Route {
  switch (stimulus.type) {
    case 'message':
    case 'channel-event':
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
    case 'consolidate':
      return { kind: 'consolidation', sessionId: consolidationSessionId(characterId, stimulus.day), day: stimulus.day }
    case 'group-batch':
      return { kind: 'group-triage', sessionId: groupTriageSessionId(characterId, stimulus.day), day: stimulus.day }
  }
}

/**
 * How a message names its sender: in groups with the user id and message id,
 * so she can mention or reply (`Alice [qq 10001, msg 5521]`).
 */
export function senderLabel(stimulus: Extract<Stimulus, { type: 'message' }>): string {
  const { channel, sender } = stimulus
  const name = `${sender.displayName}${sender.isOwner ? ' (owner)' : ''}`
  if (channel.kind === 'private') return stimulus.messageId === undefined ? name : `${name} [msg ${stimulus.messageId}]`
  const ids = [`${channel.platform} ${sender.platformUserId}`, ...stimulus.messageId === undefined ? [] : [`msg ${stimulus.messageId}`]]
  return `${name} [${ids.join(', ')}]`
}

/**
 * Model-facing text of a stimulus, without the clock stamp.
 * @returns e.g. `[local private "Owner (local)"] Sam (owner): hello`.
 */
export function stimulusText(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': {
      const { channel } = stimulus
      return `[${channel.platform} ${channel.kind} ${JSON.stringify(channel.display)}] ${senderLabel(stimulus)}: ${stimulus.text}`
    }
    case 'channel-event': {
      const { channel } = stimulus
      return `[${channel.platform} ${channel.kind} ${JSON.stringify(channel.display)}] [event] ${stimulus.text}`
    }
    case 'group-batch':
      return `[group batch ${stimulus.batch}]\n${stimulus.text}`
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
    case 'consolidate':
      return `[consolidate]\n${stimulus.text}`
  }
}

/** One-line summary shown on the collapsed context row. */
export function stimulusSummary(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': return `${stimulus.sender.displayName} on ${stimulus.channel.platform}: ${stimulus.text}`
    case 'notice': return `Notice: ${stimulus.text}`
    case 'heartbeat': return stimulus.to === 'triage' ? 'Heartbeat' : 'Heartbeat: acting'
    case 'intent': return `Intent: ${stimulus.intent}`
    case 'consolidate': return 'Consolidating memories'
    case 'channel-event': return `Event in ${stimulus.channel.display}: ${stimulus.text}`
    case 'group-batch': return `Group batch ${stimulus.batch}: ${stimulus.channel.display}`
  }
}

/** Reference recorded in the message source, so session events can be tied back (intent id). */
export function stimulusRef(stimulus: Stimulus): string | undefined {
  if (stimulus.type === 'intent') return stimulus.intentId
  if (stimulus.type === 'consolidate') return stimulus.run
  if (stimulus.type === 'group-batch') return stimulus.batch
  return undefined
}
