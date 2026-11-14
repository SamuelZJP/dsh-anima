/**
 * Settings tab (DESIGN §12): Anima rows' config, read and written through
 * DSH's config editor (`@deepseek-ai/dsh-config-editor`). A save validates
 * against the row's schema, writes the active profile's patch, and restarts
 * that row. A higher layer (home patch, `--patch` overlay) still wins.
 * @module @anima/page/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import { AnimaError, stringArg } from '@anima/core'
import type {} from '@anima/guard'

/** The part of a Loader entry the Settings tab reads. */
export interface EntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly config?: unknown; readonly disabled?: boolean | undefined }
}

/** The part of DSH's `ctx.configEditor` the Settings tab uses. */
export interface ConfigEditorLike {
  readonly documentPath: string
  entries(): EntryLike[]
  configuration(): Array<{ entry: EntryLike; inherited: Record<string, unknown>; override: Record<string, unknown> }>
  edit(entry: EntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH's config editor (optional). */
    configEditor: ConfigEditorLike
  }
}

/** Rows the owner may edit from the page. Adapter rows hold secrets and stay read-only. */
export const editableRows: readonly string[] = ['anima-core', 'anima-life', 'anima-memory', 'anima-guard']

/** One Anima row as the Settings tab shows it. */
export interface SettingsRow {
  readonly id: string
  readonly name: string
  readonly editable: boolean
  readonly disabled: boolean
  /** The row's config as it runs now (all layers). */
  readonly effective: unknown
  /** What bundle layers give it. */
  readonly inherited: unknown
  /** What the profile patch sets (replaces `inherited` when present). */
  readonly override: unknown
  /** A layer above the profile patch (home patch or `--patch` overlay) changes the result. */
  readonly higherLayer: boolean
}

const SECRET = /token|cookie|secret|password|sessdata/i

/**
 * Replace secret-looking values with `"(hidden)"`.
 * @param value - JSON-like config.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET.test(key) && inner !== undefined && inner !== null && inner !== '' ? '(hidden)' : redact(inner)]))
  }
  return value
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
    : inner) ?? 'null'
}

/**
 * Anima rows with their layers.
 * @param editor - DSH's config editor.
 */
export function settingsRows(editor: ConfigEditorLike): SettingsRow[] {
  return editor.configuration()
    .filter(({ entry }) => entry.options.id.startsWith('anima-') && !entry.options.id.startsWith('anima-preset'))
    .map(({ entry, inherited, override }) => {
      const effective = entry.options.config ?? {}
      const expected = Object.keys(override).length > 0 ? override : inherited
      const editable = editableRows.includes(entry.options.id)
      const show = (value: unknown) => editable ? value : redact(value)
      return {
        id: entry.options.id,
        name: entry.options.name,
        editable,
        disabled: entry.options.disabled === true,
        effective: show(effective),
        inherited: show(inherited),
        override: show(override),
        higherLayer: canonical(effective) !== canonical(expected),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Register the `settings` view and `settings.save` action while DSH's config
 * editor is present; without it the view says Settings are unavailable.
 * @param ctx - root context with `animaGuard`.
 */
export function registerSettings(ctx: Context): void {
  ctx.inject(['configEditor'], (ctx) => {
    const editor = ctx.configEditor
    ctx.animaGuard.addOwnerView('settings', () => ({ available: true, path: editor.documentPath, rows: settingsRows(editor) }))
    ctx.animaGuard.addOwnerAction('settings.save', async (args) => {
      const id = stringArg(args, 'id')
      if (!editableRows.includes(id)) throw new AnimaError('anima/settings-read-only', `${id} is read-only on the page; edit it in cordis.yml.`)
      const config = args.config
      if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new AnimaError('anima/bad-args', '"config" must be a JSON object.')
      const entry = editor.entries().find(e => e.options.id === id)
      if (entry === undefined) throw new AnimaError('anima/settings-unknown', `no profile row "${id}".`)
      try {
        await editor.edit(entry, () => structuredClone(config as Record<string, unknown>))
      } catch (error: unknown) {
        throw new AnimaError('anima/settings-invalid', `${error instanceof Error ? error.message : String(error)}. Nothing was saved.`)
      }
      return { saved: id, path: editor.documentPath }
    })
  })
}
