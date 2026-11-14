/**
 * Owner surface (docs/design/outside.md): named views (reads) and actions
 * (writes) that both the `/anima` commands and the Anima page call, so the
 * two never disagree.
 * @module @anima/guard/owner
 */

import { AnimaError, type OwnerAction, type OwnerView, type ViewParams } from '@anima/core'
import type { OwnerSource } from './activity.ts'

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
