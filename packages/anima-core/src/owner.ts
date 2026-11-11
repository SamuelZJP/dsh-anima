/**
 * Owner surface (DESIGN §12): named views (reads) and actions (writes) that
 * both the `/anima` commands and the Anima page call, so the two never
 * disagree. Each plugin registers its own; the page imports nothing else.
 * @module @anima/core/owner
 */

import type { OwnerSource } from './activity.ts'
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
  /** Owner actions, registered as `<platform>.<name>`. */
  readonly actions?: Readonly<Record<string, OwnerAction>>
}

const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

/** Named views and actions; effects add and remove entries. */
export class OwnerRegistry {
  private readonly views = new Map<string, OwnerView>()
  private readonly actions = new Map<string, OwnerAction>()

  private static add<T>(table: Map<string, T>, kind: string, name: string, value: T): () => void {
    if (!NAME.test(name)) throw new TypeError(`owner ${kind} name "${name}" must look like "memory" or "memory.forget"`)
    if (table.has(name)) throw new Error(`owner ${kind} "${name}" is already registered`)
    table.set(name, value)
    return () => {
      if (table.get(name) === value) table.delete(name)
    }
  }

  /** Add a view; a duplicate name throws. */
  addView(name: string, view: OwnerView): () => void {
    return OwnerRegistry.add(this.views, 'view', name, view)
  }

  /** Add an action; a duplicate name throws. */
  addAction(name: string, action: OwnerAction): () => void {
    return OwnerRegistry.add(this.actions, 'action', name, action)
  }

  /** Registered view and action names. */
  names(): { views: string[]; actions: string[] } {
    return { views: [...this.views.keys()].sort(), actions: [...this.actions.keys()].sort() }
  }

  /**
   * Read a view.
   * @throws {AnimaError} `anima/unknown-view`.
   */
  async view(name: string, params: ViewParams = {}): Promise<unknown> {
    const view = this.views.get(name)
    if (view === undefined) throw new AnimaError('anima/unknown-view', `no owner view "${name}". Views: ${this.names().views.join(', ')}.`)
    return await view(params)
  }

  /**
   * Run an action (without logging; the service logs).
   * @throws {AnimaError} `anima/unknown-action`.
   */
  async run(name: string, args: Readonly<Record<string, unknown>>, source: OwnerSource): Promise<unknown> {
    const action = this.actions.get(name)
    if (action === undefined) throw new AnimaError('anima/unknown-action', `no owner action "${name}". Actions: ${this.names().actions.join(', ')}.`)
    return await action(args, source)
  }
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
