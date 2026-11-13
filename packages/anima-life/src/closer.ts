/**
 * Turn closing (DESIGN §6, Turn shape): a conversation turn that a waking
 * arrival opened must close by an action (a say, or `end_turn`), never by
 * plain text. A pure state machine fed with session events; at DSH's
 * `agent/turn-stopping` it says whether to steer a reminder into the same
 * turn or, once the reminders are used up, to record a lost reply. It never
 * forwards anything.
 * @module @anima/life/closer
 */

/** What to do when a turn is about to stop. */
export type StopAction =
  /** Steer reminder number `count` into this turn. */
  | { readonly kind: 'remind'; readonly count: number; readonly text: string }
  /** The turn ends unclosed after the reminders: a lost reply. */
  | { readonly kind: 'lost'; readonly text: string }

interface TurnState {
  /** A waking arrival joined the turn and no closing action followed it. */
  open: boolean
  /** Reminders steered into this turn. */
  reminders: number
  /** Her last plain text since the turn opened. */
  text: string
  /** Pending calls that would close the turn when they succeed. */
  closing: Set<string>
}

/** Tracks whether each conversation turn closed by an action. */
export class TurnCloser {
  private readonly turns = new Map<string, TurnState>()

  /** @param reminders - reminders per turn before a lost reply (`conversation.closeReminders`). */
  constructor(private readonly reminders: number) {}

  private of(sessionId: string): TurnState {
    let turn = this.turns.get(sessionId)
    if (turn === undefined) {
      turn = { open: false, reminders: 0, text: '', closing: new Set() }
      this.turns.set(sessionId, turn)
    }
    return turn
  }

  /** A waking arrival joined the session's turn: it needs a closing action again. */
  onWake(sessionId: string): void {
    const turn = this.of(sessionId)
    turn.open = true
    turn.text = ''
  }

  /** Her plain text in a step (it reached nobody). */
  onText(sessionId: string, text: string): void {
    const turn = this.turns.get(sessionId)
    if (turn?.open === true && text.trim() !== '') turn.text = text.trim()
  }

  /**
   * A tool call.
   * @param closes - whether it closes the turn if it succeeds.
   */
  onToolCall(sessionId: string, callId: string, closes: boolean): void {
    if (closes) this.of(sessionId).closing.add(callId)
  }

  /** A tool result; a successful closing call closes the turn. */
  onToolResult(sessionId: string, callId: string, isError: boolean): void {
    const turn = this.turns.get(sessionId)
    if (turn === undefined || !turn.closing.delete(callId)) return
    if (!isError) {
      turn.open = false
      turn.text = ''
    }
  }

  /**
   * The turn is about to stop (DSH `agent/turn-stopping`).
   * @returns what to do, or undefined when it closed by an action or needs none.
   */
  onStopping(sessionId: string): StopAction | undefined {
    const turn = this.turns.get(sessionId)
    if (turn?.open !== true) return undefined
    if (turn.reminders < this.reminders) {
      turn.reminders += 1
      return { kind: 'remind', count: turn.reminders, text: turn.text }
    }
    const text = turn.text
    turn.open = false
    turn.text = ''
    return { kind: 'lost', text }
  }

  /** The turn ended; the next one starts fresh. */
  onTurnEnd(sessionId: string): void {
    this.turns.delete(sessionId)
  }

  /** Her last plain text in the session's open turn ('' when none). */
  lastText(sessionId: string): string {
    return this.turns.get(sessionId)?.text ?? ''
  }

  /** Whether the session's turn still needs a closing action. */
  isOpen(sessionId: string): boolean {
    return this.turns.get(sessionId)?.open === true
  }
}

/**
 * Text of a close reminder, in Chinese like the primer (DESIGN §9).
 * @param say - this chat's say tool, e.g. `qq_say`.
 * @param text - her last plain text in the turn, quoted when there is one.
 * @param count - reminder number in this turn.
 * @param of - reminders allowed per turn.
 */
export function reminderText(say: string, text: string, count: number, of: number): string {
  const quoted = text === '' ? '' : `你刚才写的「${text.length > 120 ? `${text.slice(0, 120)}…` : text}」只是文字，这里没有任何人看得到。`
  return [
    `[提醒 ${count}/${of}] 这一轮还没有用行动结束。${quoted}`,
    `要让这里的人看到，调用 ${say}；不说话，就调用 end_turn。`,
  ].join('\n')
}
