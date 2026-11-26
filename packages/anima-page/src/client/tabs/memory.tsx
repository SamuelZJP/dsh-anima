/** Memory tab: browse and search by source and status (active, archive), forget one. */
import { useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
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
        <input className="anima-input" placeholder={t('memory.search')} value={query} onChange={e => setQuery(e.target.value)} aria-label={t('memory.searchLabel')} />
        <select className="anima-select" value={source} onChange={e => { setOffset(0); setSource(e.target.value) }} aria-label={t('memory.source')}>
          <option value="">{t('memory.allSources')}</option>
          {prefixes.map(p => <option key={p} value={p}>{p}*</option>)}
          {sources.map(s => <option key={s.source} value={s.source}>{s.source === 'self' ? t('memory.herOwn') : s.source} ({s.count})</option>)}
        </select>
        <select className="anima-select" value={status} onChange={e => { setOffset(0); setStatus(e.target.value) }} aria-label={t('memory.status')}>
          <option value="active">{word('active')}</option>
          <option value="archived">{word('archived')}</option>
          <option value="superseded">{word('superseded')}</option>
          <option value="all">{t('memory.all')}</option>
        </select>
        <button type="submit" className="anima-btn">{t('memory.searchBtn')}</button>
        {data === undefined ? null : <span className="anima-muted">{t('memory.counts', { active: data.counts.active ?? 0, archived: data.counts.archived ?? 0, superseded: data.counts.superseded ?? 0, pending: data.pending })}</span>}
      </form>
      <Problem error={memory.error} />
      {forget.outcome}
      {data === undefined ? null : data.memories.length === 0 ? <p className="anima-muted">{t('memory.noMatch')}</p> : (
        <table className="anima-table">
          <thead><tr><th>{t('common.id')}</th><th>{t('memory.kind')}</th><th>{t('memory.source')}</th><th>{t('memory.strength')}</th><th>{t('memory.text')}</th><th>{t('memory.created')}</th><th /></tr></thead>
          <tbody>{data.memories.map(m => (
            <tr key={m.id}>
              <td>{m.id}{m.status === 'active' ? null : <> <Pill>{word(m.status)}{m.replacedBy === undefined ? '' : ` ${t('memory.by', { id: m.replacedBy })}`}</Pill></>}</td>
              <td>{m.kind}</td>
              <td>{m.channelKey ?? t('memory.herOwn')}{m.fromName === undefined && m.fromPerson === undefined ? null : <div className="anima-muted">{t('memory.from', { name: m.fromName ?? m.fromPerson ?? '' })}</div>}{m.personId === undefined ? null : <div className="anima-muted">{t('memory.about', { person: m.personId })}</div>}</td>
              <td>{m.strength.toFixed(2)}{m.recalls > 0 ? <div className="anima-muted">{t('memory.recalls', { n: m.recalls })}</div> : null}</td>
              <td>{m.text}</td>
              <td>{stamp(m.createdAt)}</td>
              <td><Confirm label={t('memory.forget')} danger question={t('memory.forgetQuestion', { id: m.id })} busy={forget.busy}
                onConfirm={() => void forget.run<{ forgotten: boolean }>('memory.forget', { id: m.id }, v => v.forgotten ? t('memory.forgot', { id: m.id }) : t('memory.gone', { id: m.id }))} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {data === undefined || data.total <= PAGE ? null : (
        <div className="anima-row" style={{ marginTop: 8 }}>
          <button type="button" className="anima-btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('memory.newer')}</button>
          <span>{t('memory.range', { from: offset + 1, to: Math.min(offset + PAGE, data.total), total: data.total })}</span>
          <button type="button" className="anima-btn small" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t('memory.older')}</button>
        </div>
      )}
    </>
  )
}
