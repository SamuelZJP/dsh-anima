/**
 * The situation report (DESIGN §7): built by code from numbers and events,
 * shown to her on every heartbeat. It states facts; it never suggests a topic.
 * @module @anima/life/report
 */

/** A reachable channel line. */
export interface ChannelLine {
  readonly key: string
  readonly display: string
  readonly mayInitiate: boolean
  /** Last message there (either direction), epoch ms; undefined when never. */
  readonly lastContact?: number | undefined
}

/** Report inputs, all already formatted where they come from core. */
export interface ReportInput {
  readonly time: string
  readonly phase: string
  readonly mode: string
  /** Self-state lines (energy, mood, needs). */
  readonly state: readonly string[]
  /** Open goal lines, due soonest first. */
  readonly goals: readonly string[]
  /** Events since the last heartbeat. */
  readonly events: readonly string[]
  /** Budget lines. */
  readonly budgets: readonly string[]
  readonly channels: readonly ChannelLine[]
  /** Now, for "last contact … ago". */
  readonly now: number
  /** Extra lines (e.g. the test-clock note). */
  readonly notes?: readonly string[]
}

/**
 * Format a span as e.g. `3 h 10 min`.
 * @param ms - span.
 */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days`
}

/**
 * Build the report text.
 * @param input - report inputs.
 * @returns multi-line text.
 */
export function buildReport(input: ReportInput): string {
  const lines = [
    `Time ${input.time}; phase ${input.phase}${input.mode === 'night' ? ' (night: you are asleep)' : ''}.`,
    ...input.state,
    `Open goals: ${input.goals.length === 0 ? 'none' : ''}`,
    ...input.goals.map(goal => `  ${goal}`),
    `Since your last heartbeat: ${input.events.length === 0 ? 'nothing new' : ''}`,
    ...input.events.map(event => `  ${event}`),
    'Budgets:',
    ...input.budgets.map(line => `  ${line}`),
    `Channels you can reach: ${input.channels.length === 0 ? 'none' : ''}`,
    ...input.channels.map(channel => {
      const contact = channel.lastContact === undefined ? 'no contact yet' : `last message ${formatSpan(input.now - channel.lastContact)} ago`
      return `  ${channel.display} — channel "${channel.key}"; ${channel.mayInitiate ? 'you may start a conversation' : 'you may only reply'}; ${contact}`
    }),
    ...input.notes ?? [],
  ]
  return lines.join('\n')
}
