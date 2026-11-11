/**
 * The few DSH browser-side services the page uses, typed locally so the page
 * needs no DSH client packages at build time. Shapes follow
 * `dsh-client-ui-slots` and `dsh-client-ui-sidebar` at dsh-v0.2.2-rc.1
 * (docs/DSH-INTEGRATION.md §8e). React itself is the host's (platform table).
 */
import type { ComponentType } from 'react'

/** Props DSH passes to a `sidebar.panellist` icon. */
export interface PanelIconProps {
  readonly size: number
  readonly active?: boolean
}

/** The part of `ctx.slots` the page uses. */
export interface Slots {
  inject(key: string, callback: () => (() => void) | void): () => void
  register(options: { name: 'main'; key: string }, component: ComponentType<object>): () => void
  register(options: { name: 'sidebar.panellist'; id: string; order?: number; label: string | (() => string) }, component: ComponentType<PanelIconProps>): () => void
}

/** The browser Cordis context, as far as the page uses it. */
export interface ClientContext {
  readonly slots: Slots
  effect(execute: () => () => void, label?: string): void
}
