/** Settings tab: Anima rows' config; core, life and memory are editable through DSH's config editor. */
import { useState } from 'react'
import { view } from '../api.ts'
import { parseConfigText, prettyJson } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t } from '../i18n.ts'
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
        {row.disabled ? <Pill>{t('settings.disabled')}</Pill> : null}
        {row.editable ? <Pill tone="ok">{t('settings.editable')}</Pill> : <Pill>{t('settings.readOnly')}</Pill>}
        {row.higherLayer ? <Pill tone="warn">{t('settings.higher')}</Pill> : null}
      </div>
      {row.higherLayer ? <p className="anima-warn">{t('settings.higherNote')}</p> : null}
      {!editing ? (
        <>
          <pre className="anima-pre">{prettyJson(row.effective)}</pre>
          {row.editable ? <div style={{ marginTop: 8 }}><button type="button" className="anima-btn" onClick={() => { setProblem(undefined); setText(prettyJson(base)) }}>{t('settings.edit')}</button></div> : null}
        </>
      ) : (
        <>
          <p className="anima-muted">{t('settings.editNote', { path })}</p>
          <textarea className="anima-textarea" value={text} onChange={e => setText(e.target.value)} aria-label={t('settings.configLabel', { id: row.id })} />
          <Problem error={problem} />
          <div className="anima-row" style={{ marginTop: 8 }}>
            <button type="button" className="anima-btn primary" disabled={save.busy} onClick={() => {
              const parsed = parseConfigText(text)
              if ('error' in parsed) { setProblem(parsed.error); return }
              setProblem(undefined)
              void save.run('settings.save', { id: row.id, config: parsed.value }, () => t('settings.saved', { id: row.id })).then(v => { if (v !== undefined) setText(undefined) })
            }}>{t('settings.save')}</button>
            <button type="button" className="anima-btn" onClick={() => setText(undefined)}>{t('common.cancel')}</button>
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
  if (settings.loading && settings.data === undefined) return <p className="anima-muted">{t('common.loading')}</p>
  if (settings.data === undefined) return <><Problem error={settings.error} /><p className="anima-muted">{t('settings.noEditor')}</p></>
  return (
    <>
      <Problem error={settings.error} />
      {settings.data.rows.map(row => <Row key={row.id} row={row} path={settings.data!.path} reload={settings.reload} />)}
    </>
  )
}
