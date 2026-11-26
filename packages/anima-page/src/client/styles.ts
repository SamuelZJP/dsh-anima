/**
 * The page's stylesheet, injected once as `<style data-plugin="@anima/page">`
 * and removed when the plugin unloads. Colors use DSH's `--dsw-alias-*` theme
 * tokens (docs/web-styling.md), so light and dark themes both work.
 * @module @anima/page/client/styles
 */

const CSS = `
.anima-page { height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 13px; }
.anima-page * { box-sizing: border-box; }
.anima-inner { max-width: 1100px; margin: 0 auto; padding: 20px 28px 48px; }
.anima-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; }
.anima-head h1 { font-size: 20px; font-weight: 600; margin: 0; }
.anima-sub { color: var(--dsw-alias-label-secondary); }
.anima-lang { margin-left: auto; }
.anima-tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 16px; }
.anima-tab { appearance: none; border: 0; background: none; color: var(--dsw-alias-label-secondary); padding: 8px 12px; font: inherit; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.anima-tab:hover { color: var(--dsw-alias-label-primary); }
.anima-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.anima-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px; }
.anima-card { background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px 14px; }
.anima-card h3 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.anima-section { margin-bottom: 20px; }
.anima-section > h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.anima-big { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.anima-muted { color: var(--dsw-alias-label-tertiary); }
.anima-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.anima-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; flex: 1; min-width: 80px; }
.anima-bar > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.anima-bar.warn > span { background: var(--dsw-alias-state-warn-primary); }
.anima-bar.bad > span { background: var(--dsw-alias-state-error-primary); }
.anima-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; }
.anima-kv > dt { color: var(--dsw-alias-label-secondary); }
.anima-kv > dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.anima-table { width: 100%; border-collapse: collapse; }
.anima-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary); padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.anima-table td { padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); vertical-align: top; overflow-wrap: anywhere; }
.anima-table tr.refused td, .anima-table tr.denied td { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); }
.anima-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.anima-pill.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent); color: var(--dsw-alias-state-success-primary); }
.anima-pill.warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent); color: var(--dsw-alias-state-warn-primary); }
.anima-pill.bad { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); color: var(--dsw-alias-state-error-primary); }
.anima-btn { appearance: none; font: inherit; padding: 5px 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.anima-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.anima-btn:disabled { opacity: .5; cursor: default; }
.anima-btn.primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted, #fff); border-color: transparent; }
.anima-btn.danger { color: var(--dsw-alias-state-error-primary); }
.anima-btn.small { padding: 2px 8px; font-size: 12px; }
.anima-input, .anima-select, .anima-textarea { font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 5px 8px; }
.anima-input { min-width: 220px; }
.anima-textarea { width: 100%; min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; resize: vertical; }
.anima-error { color: var(--dsw-alias-state-error-primary); margin: 6px 0; }
.anima-note { color: var(--dsw-alias-state-success-primary); margin: 6px 0; }
.anima-warn { color: var(--dsw-alias-state-warn-primary); margin: 6px 0; }
.anima-pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 0; }
.anima-diff-before { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.anima-confirm { display: flex; flex-direction: column; gap: 4px; min-width: 180px; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.anima-qr { background: #fff; padding: 12px; border-radius: 8px; display: inline-block; }
.anima-qr svg { width: 220px; height: 220px; display: block; }
`

/**
 * Inject the stylesheet.
 * @param id - plugin id stamped on the tag.
 * @returns a disposer removing it.
 */
export function injectStyles(id: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = id
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}
