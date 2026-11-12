/**
 * The outbox (DESIGN §10): a message she starts on her own (her answer to an
 * intent from Self) waits a short delay before it goes out, and the owner can
 * cancel it in that time. When its platform is offline at the end of the
 * delay, it keeps waiting until the platform is back, or expires.
 * Platform-independent; every say tool asks it first.
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
  /** Real epoch ms when it is sent (when its platform is online). */
  readonly sendsAt: number
  /** Real epoch ms when it started waiting for its platform to come back, if it is. */
  readonly offlineSince?: number | undefined
}

/** How a hold ended. */
export type HoldResult = 'send' | 'cancelled' | 'expired'

/** Options of {@link Outbox.hold}. */
export interface HoldOptions {
  /** Called once it is waiting (e.g. to notify the owner). */
  readonly onHeld?: ((held: HeldMessage) => void) | undefined
  /** Whether its platform is online now; online when omitted. */
  readonly online?: (() => boolean) | undefined
}

interface Entry {
  message: HeldMessage
  settle(result: HoldResult): void
  /** The delay is over and it waits for its platform. */
  waiting: boolean
}

/** The platform of a channel key (`platform:account:kind:id`). */
export function platformOf(channelKey: string): string {
  return channelKey.split(':', 1)[0] ?? ''
}

/** Messages waiting to go out. */
export class Outbox {
  private readonly held = new Map<string, Entry>()
  /** Counters for status and evidence. */
  readonly counts = { held: 0, sent: 0, cancelled: 0, expired: 0 }

  /**
   * @param nextId - next id number (persisted by the caller).
   * @param delayMs - real time a message waits.
   * @param offlineHoldMs - real time a message may wait for its platform after the delay, before it expires.
   */
  constructor(private readonly nextId: () => number, private readonly delayMs: number, private readonly offlineHoldMs = 30 * 60_000) {}

  /**
   * Hold a message for the delay, and past it while its platform is offline.
   * @returns `send`, `cancelled` when the owner cancelled it, or `expired` when its platform stayed offline.
   */
  hold(message: Omit<HeldMessage, 'id' | 'sendsAt' | 'offlineSince'>, options: HoldOptions = {}): Promise<HoldResult> {
    const online = options.online ?? (() => true)
    if (this.delayMs <= 0 && online()) return Promise.resolve('send')
    const id = `o${this.nextId()}`
    this.counts.held += 1
    return new Promise<HoldResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const entry: Entry = {
        message: { ...message, id, sendsAt: Date.now() + this.delayMs },
        waiting: false,
        settle: (result: HoldResult) => {
          if (!this.held.has(id)) return
          this.held.delete(id)
          clearTimeout(timer)
          this.counts[result === 'send' ? 'sent' : result] += 1
          resolve(result)
        },
      }
      const delayOver = () => {
        if (online()) return entry.settle('send')
        entry.waiting = true
        entry.message = { ...entry.message, offlineSince: Date.now() }
        timer = setTimeout(() => entry.settle('expired'), this.offlineHoldMs)
      }
      this.held.set(id, entry)
      if (this.delayMs <= 0) delayOver()
      else timer = setTimeout(delayOver, this.delayMs)
      options.onHeld?.(entry.message)
    })
  }

  /**
   * A platform came back online: messages waiting for it go out now.
   * @returns how many were released.
   */
  release(platform: string): number {
    let released = 0
    for (const entry of [...this.held.values()]) {
      if (!entry.waiting || platformOf(entry.message.channelKey) !== platform) continue
      entry.settle('send')
      released += 1
    }
    return released
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
    return [...this.held.values()].map(entry => entry.message)
  }

  /** Cancel everything (on unload). */
  cancelAll(): void {
    for (const id of [...this.held.keys()]) this.cancel(id)
  }
}
