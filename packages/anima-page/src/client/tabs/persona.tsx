/** Persona tab: the constitution (owner-edited) and her self-model with its diffs. */
import { useEffect, useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
import type { SelfDiff, SelfModelView } from '../types.ts'
import { Confirm, Pill, Problem, useAction } from '../ui.tsx'

function DiffText({ diff }: { diff: SelfDiff }) {
  return (
    <span>
      {diff.before === undefined ? null : <span className="anima-diff-before">{diff.before}</span>}
      {diff.before !== undefined && diff.after !== undefined ? ' → ' : ' '}
      {diff.after === undefined ? <span className="anima-muted">{t('persona.removed')}</span> : <span>{diff.after}</span>}
    </span>
  )
}

/** Split a translated line around one `{name}` placeholder to put an element there. */
function around(text: string, name: string): [string, string] {
  const at = text.indexOf(`{${name}}`)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + name.length + 2)]
}

export function PersonaTab() {
  const model = usePoll(() => view<SelfModelView>('selfmodel'), 10000, [])
  const constitution = usePoll(() => view<{ text: string; path: string }>('constitution'), 0, [])
  const [draft, setDraft] = useState<string | undefined>(undefined)
  useEffect(() => { if (constitution.data !== undefined && draft === undefined) setDraft(constitution.data.text) }, [constitution.data, draft])
  const save = useAction(constitution.reload)
  const revert = useAction(model.reload)
  const dirty = draft !== undefined && constitution.data !== undefined && draft !== constitution.data.text
  const reverted = new Set((model.data?.diffs ?? []).filter(d => d.op === 'revert').map(d => d.revertOf))
  const [noteBefore, noteAfter] = around(t('persona.selfModelNote'), 'tool')
  const [bakBefore, bakAfter] = around(t('persona.constitutionNote'), 'bak')

  return (
    <>
      <div className="anima-section">
        <h2>{t('persona.selfModel')}</h2>
        <p className="anima-muted">{noteBefore}<code>self_note</code>{noteAfter}</p>
        <Problem error={model.error} />
        {model.data === undefined ? null : model.data.entries.length === 0 ? <p className="anima-muted">{t('persona.noNotes')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('persona.note')}</th><th>{t('persona.section')}</th><th>{t('persona.text')}</th><th>{t('persona.since')}</th></tr></thead>
            <tbody>{model.data.entries.map(e => <tr key={e.id}><td>{e.id}</td><td>{e.section}</td><td>{e.text}</td><td>{stamp(e.since)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>{t('persona.changes')}</h2>
        {revert.outcome}
        {model.data === undefined || model.data.diffs.length === 0 ? <p className="anima-muted">{t('persona.noChanges')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('persona.change')}</th><th>{t('persona.when')}</th><th>{t('persona.by')}</th><th>{t('persona.note')}</th><th>{t('persona.text')}</th><th>{t('persona.reason')}</th><th /></tr></thead>
            <tbody>{model.data.diffs.map(d => (
              <tr key={d.id}>
                <td>{d.id} <Pill>{word(d.op)}{d.revertOf === undefined ? '' : ` ${d.revertOf}`}</Pill></td>
                <td>{stamp(d.at)}</td>
                <td>{word(d.by)}</td>
                <td>{d.entryId} <span className="anima-muted">{d.section}</span></td>
                <td><DiffText diff={d} /></td>
                <td>{d.reason}</td>
                <td>{d.op === 'revert' || reverted.has(d.id) ? (reverted.has(d.id) ? <span className="anima-muted">{t('persona.reverted')}</span> : null) : (
                  <Confirm label={t('persona.revert')} question={t('persona.revertQuestion', { id: d.id })} reason={t('persona.revertDefault')} busy={revert.busy}
                    onConfirm={reason => void revert.run<SelfDiff>('selfmodel.revert', { id: d.id, reason }, v => t('persona.revertedAs', { id: d.id, as: v.id }))} />
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>{t('persona.constitution')}</h2>
        <p className="anima-muted">{bakBefore}<code>constitution.md.bak</code>{bakAfter} {constitution.data?.path}</p>
        <Problem error={constitution.error} />
        <textarea className="anima-textarea" style={{ minHeight: 320 }} value={draft ?? ''} onChange={e => setDraft(e.target.value)} aria-label={t('persona.constitution')} />
        <div className="anima-row" style={{ marginTop: 8 }}>
          <button type="button" className="anima-btn primary" disabled={!dirty || save.busy} onClick={() => void save.run<{ chars: number }>('constitution.save', { text: draft }, v => t('persona.saved', { chars: v.chars }))}>{t('persona.save')}</button>
          <button type="button" className="anima-btn" disabled={!dirty} onClick={() => setDraft(constitution.data?.text)}>{t('persona.discard')}</button>
        </div>
        {save.outcome}
      </div>
    </>
  )
}
