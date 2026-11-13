/**
 * Spacing between her messages (DESIGN §6, Phase 9): before each message of
 * one say after the first, a typing time from its length. Adapters call it with
 * their own settings; it only times messages she already chose.
 * @module @anima/life/pacing
 */

/** Pacing settings, as an adapter's config holds them. */
export interface PacingConfig {
  /** Seconds before every message after the first. */
  readonly baseSeconds: number
  /** Seconds per character of that message. */
  readonly perCharSeconds: number
  /** Most seconds before one message. */
  readonly maxSeconds: number
}

/**
 * Typing time before a message, in ms: `base + perChar × length`, at most `max`.
 * Length counts characters (code points), so one Chinese character is one.
 */
export function typingMs(text: string, pacing: PacingConfig): number {
  const chars = [...text].length
  return Math.round(Math.max(0, Math.min(pacing.maxSeconds, pacing.baseSeconds + pacing.perCharSeconds * chars)) * 1000)
}

/**
 * Send messages in order with a typing wait before each after the first.
 * @param messages - the texts, in order.
 * @param pacing - settings.
 * @param send - sends one message (index, text); its errors stop the rest.
 * @param hooks.beforeWait - called before each wait with the message index and wait (e.g. to show typing).
 * @param hooks.wait - waits (tests pass a fake); `setTimeout` by default.
 */
export async function paceMessages<T>(
  messages: readonly string[],
  pacing: PacingConfig,
  send: (index: number, text: string) => Promise<T>,
  hooks: { beforeWait?: (index: number, ms: number) => void; wait?: (ms: number) => Promise<void> } = {},
): Promise<T[]> {
  const wait = hooks.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const results: T[] = []
  for (const [index, text] of messages.entries()) {
    if (index > 0) {
      const ms = typingMs(text, pacing)
      if (ms > 0) {
        hooks.beforeWait?.(index, ms)
        await wait(ms)
      }
    }
    results.push(await send(index, text))
  }
  return results
}
