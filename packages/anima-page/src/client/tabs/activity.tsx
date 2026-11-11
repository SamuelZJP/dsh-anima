/** Activity tab: gate decisions, wakes, tokens and owner actions per her day. The formal test's monitoring view. */
import { useState } from 'react'
import { view } from '../api.ts'
import { clockTime, count, rankedCounts, stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import type { ActivityRecord, ActivityView } from '../types.ts'
import { Card, Pill, Problem } from '../ui.tsx'

type Filter = 'all' | 'refused' | 'gate' | 'wake' | 'owner'

function describe(r: ActivityRecord): { what: string; detail: string; tone?: string | undefined } {
  switch (r.type) {
    case 'gate': return {
      what: r.behavior,
      detail: `${r.session ?? 'no session'}${r.code === undefined ? '' : ` · ${r.code}`}${r.hint === undefined ? '' : `: ${r.hint}`}`,
      tone: r.decision === 'allowed' || r.decision === 'approved' ? 'ok' : 'bad',
    }
    case 'wake': return { what: r.stimulus, detail: `${r.session}${r.channel === undefined ? '' : ` · ${r.channel}`}` }
    default: return { what: r.action, detail: `${r.source} · ${JSON.stringify(r.args).slice(0, 160)}${r.ok ? '' : ` · failed: ${r.error ?? ''}`}`, tone: r.ok ? undefined : 'bad' }
  }
}

export function ActivityTab() {
  const [day, setDay] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState<Filter>('all')
  const activity = usePoll(() => view<ActivityView>('activity', { day }), 10000, [day])
  const a = activity.data
  if (a === undefined) return <Problem error={activity.error} />
  const s = a.summary
  const records = a.records.filter(r => filter === 'all' || (filter === 'refused' ? r.type === 'gate' && (r.decision === 'refused' || r.decision === 'denied') : r.type === filter)).slice().reverse()
  const pick = (d: string) => setDay(d)
  return (
    <>
      <Problem error={activity.error} />
      <div className="anima-row">
        <label>Her day <select className="anima-select" value={a.day} onChange={e => pick(e.target.value)} aria-label="Day">
          {[...new Set([...a.days, a.day])].sort().reverse().map(d => <option key={d} value={d}>{d}</option>)}
        </select></label>
        <span className="anima-muted">Times are her clock; the log has {a.records.length} records for this day.</span>
      </div>
      <div className="anima-grid">
        <Card title="Behavior calls">
          <div className="anima-big">{count(s.calls.allowed + s.calls.approved)} <span className="anima-muted" style={{ fontSize: 13 }}>allowed</span></div>
          <div>{s.calls.refused} refused · {s.calls.approved} approved · {s.calls.denied} denied</div>
        </Card>
        <Card title="Wakes">
          <div className="anima-big">{count(s.wakes.total)}</div>
          <div className="anima-muted">{rankedCounts(s.wakes.bySession).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}</div>
        </Card>
        <Card title="Billable tokens">
          <div className="anima-big">{count(s.tokens.day + s.tokens.night)}</div>
          <div className="anima-muted">day {count(s.tokens.day)} · night {count(s.tokens.night)}</div>
        </Card>
        <Card title="Initiated · night wakes · owner">
          <div className="anima-big">{s.initiates} · {s.nightWakes} · {s.ownerActions}</div>
          <div className="anima-muted">conversations she started · night wake-ups · owner actions</div>
        </Card>
      </div>
      <div className="anima-grid">
        <Card title="Refusals by code">
          {s.refusals.length === 0 ? <span className="anima-muted">none</span> : <table className="anima-table"><tbody>{s.refusals.map(r => <tr key={r.code}><td>{r.code}</td><td>{r.count}</td></tr>)}</tbody></table>}
        </Card>
        <Card title="Wakes by stimulus">
          {rankedCounts(s.wakes.byStimulus).length === 0 ? <span className="anima-muted">none</span> : <table className="anima-table"><tbody>{rankedCounts(s.wakes.byStimulus).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>}
        </Card>
        <Card title="Behaviors used">
          {s.behaviors.length === 0 ? <span className="anima-muted">none</span> : <table className="anima-table"><tbody>{s.behaviors.slice(0, 12).map(b => <tr key={b.behavior}><td>{b.behavior}</td><td>{b.count}</td></tr>)}</tbody></table>}
        </Card>
      </div>
      <div className="anima-section">
        <h2>Log</h2>
        <div className="anima-row" role="radiogroup" aria-label="Filter">
          {(['all', 'refused', 'gate', 'wake', 'owner'] as Filter[]).map(f => (
            <button key={f} type="button" className={`anima-btn small${filter === f ? ' primary' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        {records.length === 0 ? <p className="anima-muted">Nothing recorded.</p> : (
          <table className="anima-table">
            <thead><tr><th>Time</th><th>Type</th><th>What</th><th>Details</th></tr></thead>
            <tbody>{records.slice(0, 500).map((r, i) => {
              const d = describe(r)
              const decision = r.type === 'gate' ? r.decision : undefined
              return (
                <tr key={`${r.real}-${i}`} className={decision ?? ''}>
                  <td title={`real ${stamp(r.real)}`}>{clockTime(r.at)}</td>
                  <td><Pill tone={d.tone}>{r.type}{decision === undefined ? '' : ` ${decision}`}</Pill></td>
                  <td>{d.what}</td>
                  <td>{d.detail}</td>
                </tr>
              )
            })}</tbody>
          </table>
        )}
        {records.length > 500 ? <p className="anima-muted">Showing the newest 500 of {records.length}.</p> : null}
      </div>
    </>
  )
}
