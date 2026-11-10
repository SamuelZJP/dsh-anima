/**
 * Intent outcomes (DESIGN §5): after Self hands an intent to a conversation,
 * the conversation's own events tell what happened: it spoke (`sent`), the say
 * failed (`failed`), it chose `stay_silent` (`declined`), or the turn ended with
 * neither (`no-action`). After `sent`, the next owner message there is `replied`.
 * A pure state machine fed with session events.
 * @module @anima/life/intent
 */

/** An intent Self handed to a conversation. */
export interface Intent {
  readonly id: string
  readonly sessionId: string
  readonly channelKey: string
  readonly display: string
  readonly intent: string
  /** Delivery time on her clock. */
  readonly at: number
}

/** What became of an intent. */
export type OutcomeKind = 'sent' | 'failed' | 'declined' | 'no-action' | 'replied'

/** One outcome. */
export interface Outcome {
  readonly intent: Intent
  readonly kind: OutcomeKind
  /** Reason given with `stay_silent`, or the error text of a failed say. */
  readonly detail?: string
}

/** Persistable tracker state. */
export interface TrackerState {
  /** Delivered, not yet claimed by a conversation turn. */
  pending: Intent[]
  /** Claimed by a running conversation turn. */
  active: Intent[]
  /** Sent, waiting for a reply. */
  awaitingReply: Intent[]
}

/**
 * Text of an outcome for the Self notice and the situation report.
 * @returns e.g. `Your intent i3 for Owner (local) ("say good morning"): declined — he is busy.`
 */
export function describeOutcome(outcome: Outcome): string {
  const { intent, kind, detail } = outcome
  const what = {
    sent: 'sent — you spoke there',
    failed: 'failed — the message did not go out',
    declined: 'declined — you chose to stay silent there',
    'no-action': 'declined — the conversation ended without speaking',
    replied: 'they replied',
  }[kind]
  return `Your intent ${intent.id} for ${intent.display} (${JSON.stringify(intent.intent)}): ${what}${detail === undefined || detail === '' ? '' : `: ${detail}`}.`
}

/** Tracks intents through conversation session events. */
export class IntentTracker {
  private readonly calls = new Map<string, { name: string; reason?: string | undefined }>()

  /**
   * @param state - persisted state (mutated in place).
   * @param isSay - whether a tool name is a platform say behavior.
   */
  constructor(readonly state: TrackerState, private readonly isSay: (name: string) => boolean) {}

  /** Record a delivered intent. */
  open(intent: Intent): void {
    this.state.pending.push(intent)
  }

  /** A conversation turn claimed a stimulus message; an intent becomes active. */
  onUserMessage(sessionId: string, ref: string | undefined): void {
    if (ref === undefined) return
    const index = this.state.pending.findIndex(intent => intent.sessionId === sessionId && intent.id === ref)
    if (index < 0) return
    const [intent] = this.state.pending.splice(index, 1)
    this.state.active.push(intent!)
  }

  /**
   * A tool call in a session.
   * @param reason - the `reason` argument, when the call has one.
   */
  onToolCall(sessionId: string, callId: string, name: string, reason?: string): void {
    if (this.state.active.some(intent => intent.sessionId === sessionId)) this.calls.set(`${sessionId}|${callId}`, { name, reason })
  }

  /**
   * A tool result in a session.
   * @param errorText - the result text when it is an error.
   * @returns the outcome it settles, if any.
   */
  onToolResult(sessionId: string, callId: string, isError: boolean, errorText?: string): Outcome | undefined {
    const key = `${sessionId}|${callId}`
    const call = this.calls.get(key)
    this.calls.delete(key)
    if (call === undefined) return undefined
    const { name, reason } = call
    if (this.isSay(name)) {
      if (isError) return this.settle(sessionId, 'failed', errorText)
      const outcome = this.settle(sessionId, 'sent')
      if (outcome !== undefined) this.state.awaitingReply = [...this.state.awaitingReply.filter(i => i.channelKey !== outcome.intent.channelKey), outcome.intent]
      return outcome
    }
    if (name === 'stay_silent' && !isError) return this.settle(sessionId, 'declined', reason)
    return undefined
  }

  /** A conversation turn ended; an active intent with no say is `no-action`. */
  onTurnEnd(sessionId: string): Outcome | undefined {
    return this.settle(sessionId, 'no-action')
  }

  /** The owner wrote in a channel. */
  onOwnerMessage(channelKey: string): Outcome | undefined {
    const index = this.state.awaitingReply.findIndex(intent => intent.channelKey === channelKey)
    if (index < 0) return undefined
    const [intent] = this.state.awaitingReply.splice(index, 1)
    return { intent: intent!, kind: 'replied' }
  }

  private settle(sessionId: string, kind: OutcomeKind, detail?: string): Outcome | undefined {
    const index = this.state.active.findIndex(intent => intent.sessionId === sessionId)
    if (index < 0) return undefined
    const [intent] = this.state.active.splice(index, 1)
    for (const key of [...this.calls.keys()]) if (key.startsWith(`${sessionId}|`)) this.calls.delete(key)
    return { intent: intent!, kind, ...detail === undefined ? {} : { detail } }
  }
}
