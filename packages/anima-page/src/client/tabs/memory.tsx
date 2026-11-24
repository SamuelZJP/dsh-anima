/** Memory tab: browse and search by source and status (active, archive), forget one. */
import { useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import type { MemoryView } from '../types.ts'
import { Confirm, Pill, Problem, useAction } from '../ui.tsx'

const PAGE = 50

export function MemoryTab() {
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('active')
  const [offset, setOffset] = useState(0)
  const memory = usePoll(() => view<MemoryView>('memory', { query: applied, source, status, limit: PAGE, offset }), 0, [applied, source, status, offset])
  const forget = useAction(memory.reload)
  const data = memory.data
  const sources = data?.sources ?? []
  const prefixes = [...new Set(sources.filter(s => s.source !== 'self').map(s => `${s.source.split(':')[0]}:`))]
  return (
    <>
      <form className="anima-row" onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(query.trim()) }}>
        <input className="anima-input" placeholder="Search text, source or person" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search memories" />
        <select className="anima-select" value={source} onChange={e => { setOffset(0); setSource(e.target.value) }} aria-label="Source">
          <option value="">all sources</option>
          {prefixes.map(p => <option key={p} value={p}>{p}*</option>)}
          {sources.map(s => <option key={s.source} value={s.source}>{s.source === 'self' ? 'her own' : s.source} ({s.count})</option>)}
        </select>
        <select className="anima-select" value={status} onChange={e => { setOffset(0); setStatus(e.target.value) }} aria-label="Status">
          <option value="active">active</option>
          <option value="archived">archive</option>
          <option value="superseded">superseded</option>
          <option value="all">all</option>
        </select>
        <button type="submit" className="anima-btn">Search</button>
        {data === undefined ? null : <span className="anima-muted">active {data.counts.active ?? 0} · archived {data.counts.archived ?? 0} · superseded {data.counts.superseded ?? 0} · ended wakings not yet consolidated {data.pending}</span>}
      </form>
      <Problem error={memory.error} />
      {forget.outcome}
      {data === undefined ? null : data.memories.length === 0 ? <p className="anima-muted">No memories match.</p> : (
        <table className="anima-table">
          <thead><tr><th>Id</th><th>Kind</th><th>Source</th><th>Strength</th><th>Text</th><th>Created (her clock)</th><th /></tr></thead>
          <tbody>{data.memories.map(m => (
            <tr key={m.id}>
              <td>{m.id}{m.status === 'active' ? null : <> <Pill>{m.status}{m.replacedBy === undefined ? '' : ` by ${m.replacedBy}`}</Pill></>}</td>
              <td>{m.kind}</td>
              <td>{m.channelKey ?? 'her own'}{m.fromName === undefined && m.fromPerson === undefined ? null : <div className="anima-muted">from {m.fromName ?? m.fromPerson}</div>}{m.personId === undefined ? null : <div className="anima-muted">about {m.personId}</div>}</td>
              <td>{m.strength.toFixed(2)}{m.recalls > 0 ? <div className="anima-muted">{m.recalls} recalls</div> : null}</td>
              <td>{m.text}</td>
              <td>{stamp(m.createdAt)}</td>
              <td><Confirm label="Forget" danger question={`Forget ${m.id} for good? This cannot be undone.`} busy={forget.busy}
                onConfirm={() => void forget.run<{ forgotten: boolean }>('memory.forget', { id: m.id }, v => v.forgotten ? `Forgot ${m.id}.` : `${m.id} was already gone.`)} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {data === undefined || data.total <= PAGE ? null : (
        <div className="anima-row" style={{ marginTop: 8 }}>
          <button type="button" className="anima-btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <button type="button" className="anima-btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      )}
    </>
  )
}
