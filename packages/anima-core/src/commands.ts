/**
 * The shape of an `/anima <subcommand>`: platforms describe theirs, and the
 * guard (outside the persona) owns the command.
 * @module @anima/core/commands
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** One `/anima` subcommand. */
export interface Subcommand {
  /** Lowercase name, e.g. `status`. */
  readonly name: string
  /** One-line usage shown by `/anima help`, e.g. `chat <text> — message her as the owner`. */
  readonly usage: string
  /**
   * Run the subcommand. Never reaches the model.
   * @param args - text after the subcommand name, trimmed.
   * @param invocation - the DSH invocation (agent, signal).
   */
  readonly run: (args: string, invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
