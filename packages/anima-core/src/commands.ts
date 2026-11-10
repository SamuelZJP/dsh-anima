/**
 * The `/anima <subcommand> [args]` owner command. DSH command names cannot
 * contain spaces, so one command parses its own subcommand (DSH-INTEGRATION §8).
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

/**
 * Split `rawInput` into subcommand and arguments.
 * @param rawInput - text after `/anima`.
 * @returns lowercase subcommand (empty for none) and trimmed arguments.
 */
export function parseSubcommand(rawInput: string): { name: string; args: string } {
  const trimmed = rawInput.trim()
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
  if (match === null) return { name: '', args: '' }
  return { name: match[1]!.toLowerCase(), args: match[2]!.trim() }
}

/** Subcommand table; effects add and remove entries. */
export class SubcommandTable {
  private readonly table = new Map<string, Subcommand>()

  /** Add a subcommand; a duplicate name throws. */
  add(sub: Subcommand): () => void {
    if (!/^[a-z][a-z0-9_-]*$/.test(sub.name)) throw new TypeError(`anima subcommand name "${sub.name}" must match ^[a-z][a-z0-9_-]*$`)
    if (this.table.has(sub.name)) throw new Error(`anima subcommand "${sub.name}" is already registered`)
    this.table.set(sub.name, sub)
    return () => {
      if (this.table.get(sub.name) === sub) this.table.delete(sub.name)
    }
  }

  /** Whether a subcommand exists. */
  has(name: string): boolean {
    return this.table.has(name)
  }

  /** Help text listing every subcommand. */
  help(): string {
    const lines = [...this.table.values()].sort((a, b) => a.name.localeCompare(b.name)).map(sub => `/anima ${sub.usage}`)
    return ['Anima owner commands:', ...lines].join('\n')
  }

  /**
   * Dispatch one invocation.
   * @param invocation - the DSH invocation.
   * @returns the subcommand's result, help for none, or an error for an unknown name.
   */
  async dispatch(invocation: CommandInvocation): Promise<CommandResult> {
    const { name, args } = parseSubcommand(invocation.rawInput)
    if (name === '' || name === 'help') return { kind: 'success', text: this.help() }
    const sub = this.table.get(name)
    if (sub === undefined) return { kind: 'error', text: `Unknown subcommand "${name}".\n${this.help()}` }
    try {
      return await sub.run(args, invocation)
    } catch (error: unknown) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }
}
