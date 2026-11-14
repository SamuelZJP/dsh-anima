/**
 * The vocabulary the outside uses to read and act on the persona
 * (docs/design/outside.md): view and action shapes, and the self-description a
 * platform adapter provides. The registry itself lives outside, in `anima-guard`.
 * @module @anima/core/owner
 */

import type { Subcommand } from './commands.ts'
import type { OwnerSource } from './records.ts'
import { AnimaError } from './types.ts'

/** Query parameters of a view; the page passes them from its URL. */
export type ViewParams = Readonly<Record<string, string | undefined>>

/** A read the owner can make. Returns JSON-safe data. */
export type OwnerView = (params: ViewParams) => unknown

/** A change the owner can make. Returns JSON-safe data. */
export type OwnerAction = (args: Readonly<Record<string, unknown>>, source: OwnerSource) => unknown

/** Health of one platform, for the Status and Platforms tabs. */
export interface PlatformView {
  /** `ok`, `warn` (degraded, e.g. risk control), `down` (disconnected), `off` (not logged in or not configured). */
  readonly health: 'ok' | 'warn' | 'down' | 'off'
  /** One line, e.g. `connected as 10001`. */
  readonly summary: string
  /** Further JSON-safe facts shown on the Platforms tab (e.g. the allowlist). */
  readonly details: Readonly<Record<string, unknown>>
}

/** A platform's owner surface, registered by its adapter. */
export interface PlatformProvider {
  /** Platform id, e.g. `qq`. */
  readonly platform: string
  /** Display name, e.g. `QQ`. */
  readonly title: string
  view(): PlatformView | Promise<PlatformView>
  /** Owner actions, registered outside as `<platform>.<name>`. */
  readonly actions?: Readonly<Record<string, OwnerAction>>
  /** Owner subcommands of `/anima` this platform offers (e.g. `bili login`). */
  readonly subcommands?: readonly Subcommand[]
}

/**
 * Read a required string argument.
 * @throws {AnimaError} `anima/bad-args`.
 */
export function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new AnimaError('anima/bad-args', `"${key}" must be a non-empty string.`)
  return value.trim()
}

/** Read an optional string argument; empty means absent. */
export function optionalStringArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new AnimaError('anima/bad-args', `"${key}" must be a string.`)
  return value.trim() === '' ? undefined : value.trim()
}
