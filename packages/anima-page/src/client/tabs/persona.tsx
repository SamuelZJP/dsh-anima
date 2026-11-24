/** Persona tab: the constitution (owner-edited) and her self-model with its diffs. */
import { useEffect, useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import type { SelfDiff, SelfModelView } from '../types.ts'
import { Confirm, Pill, Problem, useAction } from '../ui.tsx'

function DiffText({ diff }: { diff: SelfDiff }) {
  return (
    <span>
      {diff.before === undefined ? null : <span className="anima-diff-before">{diff.before}</span>}
      {diff.before !== undefined && diff.after !== undefined ? ' → ' : ' '}
      {diff.after === undefined ? <span className="anima-muted">(removed)</span> : <span>{diff.after}</span>}
    </span>
  )
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

  return (
    <>
      <div className="anima-section">
        <h2>Self-model</h2>
        <p className="anima-muted">What she has learned about herself with <code>self_note</code>. Her waking sessions and sleep's consolidation see all of it.</p>
        <Problem error={model.error} />
        {model.data === undefined ? null : model.data.entries.length === 0 ? <p className="anima-muted">No notes yet.</p> : (
          <table className="anima-table">
            <thead><tr><th>Note</th><th>Section</th><th>Text</th><th>Since</th></tr></thead>
            <tbody>{model.data.entries.map(e => <tr key={e.id}><td>{e.id}</td><td>{e.section}</td><td>{e.text}</td><td>{stamp(e.since)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>Changes</h2>
        {revert.outcome}
        {model.data === undefined || model.data.diffs.length === 0 ? <p className="anima-muted">No changes yet.</p> : (
          <table className="anima-table">
            <thead><tr><th>Change</th><th>When (her clock)</th><th>By</th><th>Note</th><th>Text</th><th>Reason</th><th /></tr></thead>
            <tbody>{model.data.diffs.map(d => (
              <tr key={d.id}>
                <td>{d.id} <Pill>{d.op}{d.revertOf === undefined ? '' : ` ${d.revertOf}`}</Pill></td>
                <td>{stamp(d.at)}</td>
                <td>{d.by}</td>
                <td>{d.entryId} <span className="anima-muted">{d.section}</span></td>
                <td><DiffText diff={d} /></td>
                <td>{d.reason}</td>
                <td>{d.op === 'revert' || reverted.has(d.id) ? (reverted.has(d.id) ? <span className="anima-muted">reverted</span> : null) : (
                  <Confirm label="Revert" question={`Revert ${d.id}? Reason (logged):`} reason="reverted by the owner" busy={revert.busy}
                    onConfirm={reason => void revert.run<SelfDiff>('selfmodel.revert', { id: d.id, reason }, v => `Reverted ${d.id} as ${v.id}.`)} />
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>Constitution</h2>
        <p className="anima-muted">Only you edit this. Saving keeps the previous text as <code>constitution.md.bak</code>; running sessions get the new text on their next request. {constitution.data?.path}</p>
        <Problem error={constitution.error} />
        <textarea className="anima-textarea" style={{ minHeight: 320 }} value={draft ?? ''} onChange={e => setDraft(e.target.value)} aria-label="Constitution" />
        <div className="anima-row" style={{ marginTop: 8 }}>
          <button type="button" className="anima-btn primary" disabled={!dirty || save.busy} onClick={() => void save.run<{ chars: number }>('constitution.save', { text: draft }, v => `Saved (${v.chars} characters).`)}>Save constitution</button>
          <button type="button" className="anima-btn" disabled={!dirty} onClick={() => setDraft(constitution.data?.text)}>Discard changes</button>
        </div>
        {save.outcome}
      </div>
    </>
  )
}
