/**
 * The outbox (DESIGN §10): a message she starts on her own (her answer to an
 * intent from Self) waits a short delay before it goes out, and the owner can
 * cancel it in that time. Platform-independent; every say tool asks it first.
 * @module @anima/life/outbox
 */

/** A message waiting in the outbox. */
export interface HeldMessage {
  /** Id shown to the owner, `o<n>`. */
  readonly id: string
  readonly sessionId: string
  readonly channelKey: string
  readonly display: string
  readonly text: string
  /** Intent it answers. */
  readonly intentId: string
  /** Real epoch ms when it is sent. */
  readonly sendsAt: number
}

/** How a hold ended. */
export type HoldResult = 'send' | 'cancelled'

/** Messages waiting to go out. */
export class Outbox {
  private readonly held = new Map<string, HeldMessage & { settle(result: HoldResult): void }>()
  /** Counters for status and evidence. */
  readonly counts = { held: 0, sent: 0, cancelled: 0 }

  /**
   * @param nextId - next id number (persisted by the caller).
   * @param delayMs - real time a message waits.
   */
  constructor(private readonly nextId: () => number, private readonly delayMs: number) {}

  /**
   * Hold a message for the delay.
   * @param onHeld - called once it is waiting (e.g. to notify the owner).
   * @returns `send`, or `cancelled` when the owner cancelled it.
   */
  hold(message: Omit<HeldMessage, 'id' | 'sendsAt'>, onHeld?: (held: HeldMessage) => void): Promise<HoldResult> {
    if (this.delayMs <= 0) return Promise.resolve('send')
    const id = `o${this.nextId()}`
    this.counts.held += 1
    return new Promise<HoldResult>((resolve) => {
      const timer = setTimeout(() => entry.settle('send'), this.delayMs)
      const entry = {
        ...message, id, sendsAt: Date.now() + this.delayMs,
        settle: (result: HoldResult) => {
          if (!this.held.has(id)) return
          this.held.delete(id)
          clearTimeout(timer)
          this.counts[result === 'send' ? 'sent' : 'cancelled'] += 1
          resolve(result)
        },
      }
      this.held.set(id, entry)
      onHeld?.(entry)
    })
  }

  /**
   * Cancel a held message.
   * @returns false when no message has this id (already sent or cancelled).
   */
  cancel(id: string): boolean {
    const entry = this.held.get(id.toLowerCase())
    if (entry === undefined) return false
    entry.settle('cancelled')
    return true
  }

  /** Held messages, oldest first. */
  list(): HeldMessage[] {
    return [...this.held.values()].map(({ settle: _settle, ...message }) => message)
  }

  /** Cancel everything (on unload). */
  cancelAll(): void {
    for (const id of [...this.held.keys()]) this.cancel(id)
  }
}
