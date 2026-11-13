/**
 * Group triage (DESIGN §5): group messages that do not address her are
 * buffered per group for a short window; each window becomes one batch that a
 * cheap model sorts into ignore, remember only, or wake. This module keeps the
 * buffers, batches and timers; the life service delivers and decides.
 * @module @anima/life/group-triage
 */

import { channelKey } from '@anima/core'
import type { PublishedChannel, Stimulus } from './stimulus.ts'

/** A channel message stimulus. */
export type MessageStimulus = Extract<Stimulus, { type: 'message' }>

/** What becomes of a batch. */
export type Decision = 'wake' | 'remember' | 'ignore'

/** One batch of buffered group messages. */
export interface Batch {
  /** Id shown to her, `b<n>`. */
  readonly id: string
  readonly channel: PublishedChannel
  readonly channelKey: string
  readonly messages: readonly MessageStimulus[]
  /** How it was settled, once it is. */
  decision?: Decision
  /** Who settled it: her, or a fallback. */
  by?: 'her' | 'timeout' | 'turn-end' | 'skipped'
  /** Her reason, when she gave one (`group_wake`); the wake states it (DESIGN §5). */
  reason?: string
}

/** Hooks the triage calls. */
export interface TriageHooks {
  /** Next batch number (persisted by the caller). */
  nextId(): number
  /**
   * Hand a closed batch to the classifier. Returns false when classification
   * is not possible now (night, paused, over budget); the batch is then remembered.
   */
  classify(batch: Batch): Promise<boolean>
  /** Apply a decision. */
  settle(batch: Batch): void
}

/** Triage tuning (life config `groupTriage`). */
export interface TriageOptions {
  /** Real time a group's buffer stays open. */
  readonly windowMs: number
  /** A buffer this full closes at once. */
  readonly maxBatch: number
  /** Real time a delivered batch may stay undecided before it is remembered. */
  readonly timeoutMs: number
}

/** Settled batches kept for lookups and status. */
const HISTORY = 50

/** Buffers and batches of group triage. */
export class GroupTriage {
  private readonly buffers = new Map<string, { channel: PublishedChannel; messages: MessageStimulus[]; timer: ReturnType<typeof setTimeout> }>()
  private readonly batches = new Map<string, Batch & { timer?: ReturnType<typeof setTimeout> }>()
  /** Counters for status and evidence. */
  readonly counts = { batches: 0, wake: 0, remember: 0, ignore: 0, fallback: 0 }

  constructor(private readonly options: TriageOptions, private readonly hooks: TriageHooks, private readonly onError: (error: unknown) => void = () => {}) {}

  /** Buffer an unaddressed group message. */
  add(message: MessageStimulus): void {
    const key = channelKey(message.channel)
    let buffer = this.buffers.get(key)
    if (buffer === undefined) {
      buffer = { channel: message.channel, messages: [], timer: setTimeout(() => this.close(key), this.options.windowMs) }
      this.buffers.set(key, buffer)
    }
    buffer.messages.push(message)
    if (buffer.messages.length >= this.options.maxBatch) this.close(key)
  }

  /**
   * Take a group's open buffer without classifying it, e.g. because a message
   * addressing her arrived and the buffered ones become its context.
   */
  take(key: string): MessageStimulus[] {
    const buffer = this.buffers.get(key)
    if (buffer === undefined) return []
    clearTimeout(buffer.timer)
    this.buffers.delete(key)
    return buffer.messages
  }

  /** Close a group's buffer into a batch and classify it. */
  close(key: string): void {
    const messages = this.take(key)
    if (messages.length === 0) return
    const batch: Batch & { timer?: ReturnType<typeof setTimeout> } = { id: `b${this.hooks.nextId()}`, channel: messages[0]!.channel, channelKey: key, messages }
    this.batches.set(batch.id, batch)
    this.counts.batches += 1
    this.trim()
    void this.hooks.classify(batch).then((ok) => {
      if (!ok) return this.decide(batch.id, 'remember', 'skipped')
      if (batch.decision === undefined) batch.timer = setTimeout(() => this.decide(batch.id, 'remember', 'timeout'), this.options.timeoutMs)
      return undefined
    }).catch((error: unknown) => {
      this.onError(error)
      this.decide(batch.id, 'remember', 'skipped')
    })
  }

  /** A batch by id. */
  batch(id: string): Batch | undefined {
    return this.batches.get(id.toLowerCase())
  }

  /**
   * Settle a batch.
   * @returns the batch, or undefined when it is unknown or already settled.
   */
  decide(id: string, decision: Decision, by: NonNullable<Batch['by']> = 'her', reason?: string): Batch | undefined {
    const batch = this.batches.get(id.toLowerCase())
    if (batch === undefined || batch.decision !== undefined) return undefined
    clearTimeout(batch.timer)
    batch.decision = decision
    batch.by = by
    if (reason !== undefined) batch.reason = reason
    this.counts[decision] += 1
    if (by !== 'her') this.counts.fallback += 1
    try {
      this.hooks.settle(batch)
    } catch (error: unknown) {
      this.onError(error)
    }
    return batch
  }

  /** Open buffers, for status. */
  open(): { channelKey: string; messages: number }[] {
    return [...this.buffers].map(([key, buffer]) => ({ channelKey: key, messages: buffer.messages.length }))
  }

  /** Batches not settled yet. */
  undecided(): Batch[] {
    return [...this.batches.values()].filter(batch => batch.decision === undefined)
  }

  /** Stop every timer; open buffers and undecided batches are remembered. */
  dispose(): void {
    for (const key of [...this.buffers.keys()]) {
      const messages = this.take(key)
      if (messages.length > 0) {
        const batch: Batch = { id: `b${this.hooks.nextId()}`, channel: messages[0]!.channel, channelKey: key, messages }
        this.batches.set(batch.id, batch)
        this.decide(batch.id, 'remember', 'skipped')
      }
    }
    for (const batch of this.undecided()) this.decide(batch.id, 'remember', 'skipped')
  }

  private trim(): void {
    for (const [id, batch] of this.batches) {
      if (this.batches.size <= HISTORY) break
      if (batch.decision !== undefined) this.batches.delete(id)
    }
  }
}

/**
 * Batch text for the group-triage session.
 * @param batch - the batch.
 * @param lines - each message's rendered line.
 * @param lastSpoke - when she last spoke there, formatted, if ever.
 */
export function batchText(batch: Batch, lines: readonly string[], lastSpoke: string | undefined): string {
  const { channel } = batch
  return [
    `${channel.platform} ${channel.kind} ${JSON.stringify(channel.display)}, ${batch.messages.length} message${batch.messages.length === 1 ? '' : 's'} nobody addressed to you:`,
    ...lines,
    lastSpoke === undefined ? 'You have not spoken there recently.' : `You last spoke there at ${lastSpoke}.`,
    `Decide with group_wake("${batch.id}", reason) or group_pass("${batch.id}", remember, reason?).`,
  ].join('\n')
}
