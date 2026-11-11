/**
 * Browser half of `@anima/page`: the Anima sidebar entry and page in DSH's
 * web UI (DESIGN §12, DSH-INTEGRATION §8e).
 * @module @anima/page/client
 */
import { AnimaPage } from './App.tsx'
import type { ClientContext, PanelIconProps } from './dsh.ts'
import { injectStyles } from './styles.ts'

/** Panel id: the sidebar entry and the main panel key. */
export const PANEL_ID = 'anima'

/** Browser services used. */
export const inject = ['slots']

function AnimaIcon({ size }: PanelIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 13.5c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" />
      <circle cx="9.3" cy="10" r=".6" fill="currentColor" />
      <circle cx="14.7" cy="10" r=".6" fill="currentColor" />
    </svg>
  )
}

/**
 * Register the stylesheet, the sidebar entry and the page.
 * @param ctx - browser context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles('@anima/page'), 'anima-page: styles')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, AnimaPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: 'Anima' }, AnimaIcon))
}
