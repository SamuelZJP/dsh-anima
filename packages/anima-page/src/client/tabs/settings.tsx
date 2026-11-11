/** Settings tab: Anima rows' config; core, life and memory are editable through DSH's config editor. */
import { useState } from 'react'
import { view } from '../api.ts'
import { parseConfigText, prettyJson } from '../format.ts'
import { usePoll } from '../hooks.ts'
import type { SettingsRow, SettingsView } from '../types.ts'
import { Pill, Problem, useAction } from '../ui.tsx'

function Row({ row, path, reload }: { row: SettingsRow; path: string; reload: () => void }) {
  const base = Object.keys(row.override as object).length > 0 ? row.override : row.inherited
  const [text, setText] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const save = useAction(reload)
  const editing = text !== undefined
  return (
    <div className="anima-card anima-section">
      <div className="anima-row">
        <b>{row.id}</b><span className="anima-muted">{row.name}</span>
        {row.disabled ? <Pill>disabled</Pill> : null}
        {row.editable ? <Pill tone="ok">editable</Pill> : <Pill>read-only</Pill>}
        {row.higherLayer ? <Pill tone="warn">overridden by a higher layer</Pill> : null}
      </div>
      {row.higherLayer ? <p className="anima-warn">A home patch or a --patch overlay changes this row. A save writes the profile patch, but that higher layer still wins while it is loaded.</p> : null}
      {!editing ? (
        <>
          <pre className="anima-pre">{prettyJson(row.effective)}</pre>
          {row.editable ? <div style={{ marginTop: 8 }}><button type="button" className="anima-btn" onClick={() => { setProblem(undefined); setText(prettyJson(base)) }}>Edit</button></div> : null}
        </>
      ) : (
        <>
          <p className="anima-muted">This JSON replaces the row's config in the profile patch ({path}). It is checked against the row's schema before anything is written; the row restarts after a save.</p>
          <textarea className="anima-textarea" value={text} onChange={e => setText(e.target.value)} aria-label={`${row.id} config`} />
          <Problem error={problem} />
          <div className="anima-row" style={{ marginTop: 8 }}>
            <button type="button" className="anima-btn primary" disabled={save.busy} onClick={() => {
              const parsed = parseConfigText(text)
              if ('error' in parsed) { setProblem(parsed.error); return }
              setProblem(undefined)
              void save.run('settings.save', { id: row.id, config: parsed.value }, () => `Saved ${row.id}; it restarts with the new config.`).then(v => { if (v !== undefined) setText(undefined) })
            }}>Save</button>
            <button type="button" className="anima-btn" onClick={() => setText(undefined)}>Cancel</button>
          </div>
        </>
      )}
      {save.outcome}
    </div>
  )
}

export function SettingsTab() {
  const settings = usePoll(async () => {
    try {
      return await view<SettingsView>('settings')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'anima/unknown-view') return undefined
      throw error
    }
  }, 0, [])
  if (settings.loading && settings.data === undefined) return <p className="anima-muted">Loading…</p>
  if (settings.data === undefined) return <><Problem error={settings.error} /><p className="anima-muted">DSH's config editor is not loaded in this profile, so settings are only editable in cordis.yml.</p></>
  return (
    <>
      <Problem error={settings.error} />
      {settings.data.rows.map(row => <Row key={row.id} row={row} path={settings.data!.path} reload={settings.reload} />)}
    </>
  )
}
