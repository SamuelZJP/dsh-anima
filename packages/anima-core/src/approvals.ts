/**
 * Owner approvals (DESIGN §10): a request goes to the owner over an owner line
 * (e.g. the owner's QQ private chat) with an id; the owner answers with a plain
 * `yes <id>` or `no <id>`; no answer in time means denied. Platform-independent:
 * an adapter supplies the line and forwards the owner's replies.
 * @module @anima/core/approvals
 */

/** How an approval request ended. */
export type ApprovalAnswer = 'approved' | 'denied' | 'timeout' | 'unavailable'

/** Where approval requests (and other owner notices) are sent; provided by an adapter. */
export interface OwnerLine {
  /** Human-readable name, e.g. `QQ private chat with the owner`. */
  readonly name: string
  /** Send one plain-text message to the owner. */
  send(text: string): Promise<void>
}

/** One owner reply command: `yes a3`, `no a3`, `cancel o2`. */
export interface OwnerReply {
  readonly verb: 'yes' | 'no' | 'cancel'
  /** Request id, e.g. `a3` or `o2` (lowercase). */
  readonly id: string
}

const VERBS: Record<string, OwnerReply['verb']> = {
  yes: 'yes', y: 'yes', ok: 'yes', allow: 'yes', approve: 'yes', '是': 'yes', '好': 'yes', '同意': 'yes', '允许': 'yes',
  no: 'no', n: 'no', deny: 'no', '否': 'no', '不': 'no', '拒绝': 'no',
  cancel: 'cancel', '取消': 'cancel',
}

/**
 * Parse an owner reply command. Only the whole message counts, so ordinary
 * chat that happens to contain "yes" is never taken as an answer.
 * @param text - the owner's message text.
 * @returns the reply, or undefined when the message is not a reply command.
 */
export function parseOwnerReply(text: string): OwnerReply | undefined {
  const match = /^\s*(\S+?)\s*([a-z]\d+)\s*[.!。！]?\s*$/i.exec(text)
  if (match === null) return undefined
  const verb = VERBS[match[1]!.toLowerCase()]
  return verb === undefined ? undefined : { verb, id: match[2]!.toLowerCase() }
}

/** A pending request, for status. */
export interface PendingApproval {
  readonly id: string
  readonly summary: string
  /** Real epoch ms when it times out. */
  readonly expiresAt: number
}

interface Entry extends PendingApproval {
  settle(answer: ApprovalAnswer): void
}

/** Pending approval requests and their timers. */
export class ApprovalBroker {
  private readonly pending = new Map<string, Entry>()

  /**
   * @param nextId - returns the next id number (persisted by the caller).
   * @param defaultTimeoutMs - real time before an unanswered request is denied.
   */
  constructor(private readonly nextId: () => number, private readonly defaultTimeoutMs: number) {}

  /**
   * Ask the owner and wait for the answer.
   * @param line - the owner line; `unavailable` without one.
   * @param summary - what she wants to do, one line.
   * @param options.timeoutMs - overrides the default timeout.
   * @param options.signal - aborting denies the request.
   * @param options.onAsked - called with the id once the request was sent.
   */
  async request(line: OwnerLine | undefined, summary: string, options: { timeoutMs?: number; signal?: AbortSignal; onAsked?: (id: string) => void } = {}): Promise<ApprovalAnswer> {
    if (line === undefined) return 'unavailable'
    const id = `a${this.nextId()}`
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    const answer = new Promise<ApprovalAnswer>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => entry.settle('denied')
      const entry: Entry = {
        id, summary, expiresAt: Date.now() + timeoutMs,
        settle: (value) => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
      }
      this.pending.set(id, entry)
      timer = setTimeout(() => entry.settle('timeout'), timeoutMs)
      if (options.signal?.aborted === true) entry.settle('denied')
      else options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await line.send(`[Anima approval ${id}] ${summary}\nReply "yes ${id}" to allow or "no ${id}" to deny. No answer within ${minutes} min counts as no.`)
      options.onAsked?.(id)
    } catch {
      this.answer(id, false)
      return 'unavailable'
    }
    return answer
  }

  /**
   * Answer a pending request.
   * @returns false when no request has this id (already answered or timed out).
   */
  answer(id: string, approve: boolean): boolean {
    const entry = this.pending.get(id.toLowerCase())
    if (entry === undefined) return false
    entry.settle(approve ? 'approved' : 'denied')
    return true
  }

  /** Pending requests, oldest first. */
  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ id, summary, expiresAt }) => ({ id, summary, expiresAt }))
  }

  /** Deny everything pending (on unload). */
  denyAll(): void {
    for (const entry of [...this.pending.values()]) entry.settle('denied')
  }
}
