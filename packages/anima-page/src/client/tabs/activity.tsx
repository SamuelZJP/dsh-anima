/** Activity tab: gate decisions, wakes, tokens and owner actions per her day. */
import { useState } from 'react'
import { view } from '../api.ts'
import { clockTime, count, rankedCounts, stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
import type { ActivityRecord, ActivityView } from '../types.ts'
import { Card, Pill, Problem } from '../ui.tsx'

type Filter = 'all' | 'refused' | 'gate' | 'wake' | 'owner' | 'platform'


function describe(r: ActivityRecord): { what: string; detail: string; tone?: string | undefined } {
  switch (r.type) {
    case 'gate': return {
      what: r.behavior,
      detail: `${r.session ?? t('activity.noSession')}${r.code === undefined ? '' : ` · ${r.code}`}${r.hint === undefined ? '' : `: ${r.hint}`}`,
      tone: r.decision === 'allowed' || r.decision === 'approved' ? 'ok' : 'bad',
    }
    case 'wake': return { what: r.stimulus, detail: `${r.session}${r.channel === undefined ? '' : ` · ${r.channel}`}` }
    case 'platform': return { what: t(r.online ? 'activity.online' : 'activity.offline', { platform: r.platform }), detail: r.reason ?? '', tone: r.online ? 'ok' : 'bad' }
    default: return { what: r.action, detail: `${r.source} · ${JSON.stringify(r.args).slice(0, 160)}${r.ok ? '' : ` · ${t('activity.failed', { error: r.error ?? '' })}`}`, tone: r.ok ? undefined : 'bad' }
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
  const none = <span className="anima-muted">{t('common.none')}</span>
  return (
    <>
      <Problem error={activity.error} />
      <div className="anima-row">
        <label>{t('activity.herDay')} <select className="anima-select" value={a.day} onChange={e => pick(e.target.value)} aria-label={t('activity.day')}>
          {[...new Set([...a.days, a.day])].sort().reverse().map(d => <option key={d} value={d}>{d}</option>)}
        </select></label>
        <span className="anima-muted">{t('activity.note', { n: a.records.length })}</span>
      </div>
      <div className="anima-grid">
        <Card title={t('activity.calls')}>
          <div className="anima-big">{count(s.calls.allowed + s.calls.approved)} <span className="anima-muted" style={{ fontSize: 13 }}>{t('activity.allowed')}</span></div>
          <div>{t('activity.callsLine', { refused: s.calls.refused, approved: s.calls.approved, denied: s.calls.denied })}</div>
        </Card>
        <Card title={t('activity.wakes')}>
          <div className="anima-big">{count(s.wakes.total)}</div>
          <div className="anima-muted">{rankedCounts(s.wakes.bySession).map(([k, v]) => `${k} ${v}`).join(' · ') || t('common.none')}</div>
        </Card>
        <Card title={t('activity.tokens')}>
          <div className="anima-big">{count(s.tokens.day + s.tokens.night)}</div>
          <div className="anima-muted">{t('status.dayNight', { day: count(s.tokens.day), night: count(s.tokens.night) })}</div>
        </Card>
        <Card title={t('activity.initiatedOwner')}>
          <div className="anima-big">{s.initiates} · {s.ownerActions}</div>
          <div className="anima-muted">{t('activity.initiatedOwnerNote')}</div>
        </Card>
      </div>
      <div className="anima-grid">
        <Card title={t('activity.refusals')}>
          {s.refusals.length === 0 ? none : <table className="anima-table"><tbody>{s.refusals.map(r => <tr key={r.code}><td>{r.code}</td><td>{r.count}</td></tr>)}</tbody></table>}
        </Card>
        <Card title={t('activity.byStimulus')}>
          {rankedCounts(s.wakes.byStimulus).length === 0 ? none : <table className="anima-table"><tbody>{rankedCounts(s.wakes.byStimulus).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>}
        </Card>
        <Card title={t('activity.behaviors')}>
          {s.behaviors.length === 0 ? none : <table className="anima-table"><tbody>{s.behaviors.slice(0, 12).map(b => <tr key={b.behavior}><td>{b.behavior}</td><td>{b.count}</td></tr>)}</tbody></table>}
        </Card>
      </div>
      <div className="anima-section">
        <h2>{t('activity.log')}</h2>
        <div className="anima-row" role="radiogroup" aria-label={t('activity.filter')}>
          {(['all', 'refused', 'gate', 'wake', 'owner', 'platform'] as Filter[]).map(f => (
            <button key={f} type="button" className={`anima-btn small${filter === f ? ' primary' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{word(f)}</button>
          ))}
        </div>
        {records.length === 0 ? <p className="anima-muted">{t('activity.nothing')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('activity.time')}</th><th>{t('activity.type')}</th><th>{t('activity.what')}</th><th>{t('activity.details')}</th></tr></thead>
            <tbody>{records.slice(0, 500).map((r, i) => {
              const d = describe(r)
              const decision = r.type === 'gate' ? r.decision : undefined
              return (
                <tr key={`${r.real}-${i}`} className={decision ?? ''}>
                  <td title={t('activity.real', { at: stamp(r.real) })}>{clockTime(r.at)}</td>
                  <td><Pill tone={d.tone}>{word(r.type)}{decision === undefined ? '' : ` ${word(decision)}`}</Pill></td>
                  <td>{d.what}</td>
                  <td>{d.detail}</td>
                </tr>
              )
            })}</tbody>
          </table>
        )}
        {records.length > 500 ? <p className="anima-muted">{t('activity.newest', { n: records.length })}</p> : null}
      </div>
    </>
  )
}
