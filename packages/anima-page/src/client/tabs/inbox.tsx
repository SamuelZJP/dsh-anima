/** Goals, approvals and outbox: what waits on the owner. */
import { useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
import type { ApprovalsView, Goal, OutboxView } from '../types.ts'
import { Confirm, Pill, Problem, useAction } from '../ui.tsx'

export function InboxTab() {
  const approvals = usePoll(() => view<ApprovalsView>('approvals'), 3000, [])
  const outbox = usePoll(() => view<OutboxView>('outbox'), 3000, [])
  const goals = usePoll(() => view<{ goals: Goal[] }>('goals'), 10000, [])
  const answer = useAction(approvals.reload)
  const cancel = useAction(outbox.reload)
  const goal = useAction(goals.reload)
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const list = (goals.data?.goals ?? []).filter(g => showClosed || g.status === 'open')

  return (
    <>
      <div className="anima-section">
        <h2>{t('inbox.approvals')}</h2>
        <p className="anima-muted">{t('inbox.ownerLine', { line: approvals.data?.ownerLine ?? t('inbox.noOwnerLine') })}</p>
        <Problem error={approvals.error} />
        {answer.outcome}
        {(approvals.data?.pending ?? []).length === 0 ? <p className="anima-muted">{t('inbox.nothingWaits')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('common.id')}</th><th>{t('inbox.request')}</th><th /></tr></thead>
            <tbody>{approvals.data!.pending.map(p => (
              <tr key={p.id}><td>{p.id}</td><td>{p.summary}</td><td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="anima-btn small primary" disabled={answer.busy} onClick={() => void answer.run<{ answered: boolean }>('approve', { id: p.id }, v => v.answered ? t('inbox.approved', { id: p.id }) : t('inbox.alreadyAnswered', { id: p.id }))}>{t('inbox.approve')}</button>{' '}
                <button type="button" className="anima-btn small danger" disabled={answer.busy} onClick={() => void answer.run<{ answered: boolean }>('deny', { id: p.id }, v => v.answered ? t('inbox.denied', { id: p.id }) : t('inbox.alreadyAnswered', { id: p.id }))}>{t('inbox.deny')}</button>
              </td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>{t('inbox.outbox')}</h2>
        <p className="anima-muted">{t('inbox.outboxNote', { s: outbox.data?.delaySeconds ?? '?' })}</p>
        <Problem error={outbox.error} />
        {cancel.outcome}
        {(outbox.data?.held ?? []).length === 0 ? <p className="anima-muted">{t('inbox.nothingHeld')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('common.id')}</th><th>{t('inbox.to')}</th><th>{t('inbox.message')}</th><th>{t('inbox.sendsIn')}</th><th /></tr></thead>
            <tbody>{outbox.data!.held.map(m => (
              <tr key={m.id}><td>{m.id}</td><td>{m.display}<div className="anima-muted">{t('inbox.speaksFirst')}</div></td><td>{m.text}</td>
                <td>{t('inbox.seconds', { n: Math.max(0, Math.round((m.sendsAt - Date.now()) / 1000)) })}</td>
                <td><button type="button" className="anima-btn small danger" disabled={cancel.busy} onClick={() => { void cancel.run<{ cancelled: boolean }>('outbox.cancel', { id: m.id }, v => v.cancelled ? t('inbox.cancelled', { id: m.id }) : t('inbox.alreadySent', { id: m.id })) }}>{t('common.cancel')}</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>{t('inbox.goals')}</h2>
        <Problem error={goals.error} />
        <form className="anima-row" onSubmit={(e) => {
          e.preventDefault()
          if (text.trim() === '') return
          void goal.run<Goal>('goal.add', { text, ...due.trim() === '' ? {} : { due } }, g => t('inbox.added', { id: g.id })).then(g => { if (g !== undefined) { setText(''); setDue('') } })
        }}>
          <input className="anima-input" style={{ flex: 1 }} placeholder={t('inbox.goalPlaceholder')} value={text} onChange={e => setText(e.target.value)} aria-label={t('inbox.newGoal')} />
          <input className="anima-input" style={{ minWidth: 160 }} placeholder={t('inbox.duePlaceholder')} value={due} onChange={e => setDue(e.target.value)} aria-label={t('inbox.due')} />
          <button type="submit" className="anima-btn" disabled={goal.busy}>{t('inbox.addGoal')}</button>
          <label><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} /> {t('inbox.showClosed')}</label>
        </form>
        {goal.outcome}
        {list.length === 0 ? <p className="anima-muted">{t('inbox.noGoals')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('common.id')}</th><th>{t('inbox.goal')}</th><th>{t('inbox.owner')}</th><th>{t('inbox.status')}</th><th>{t('inbox.due')}</th><th>{t('inbox.latestNote')}</th><th /></tr></thead>
            <tbody>{list.map(g => (
              <tr key={g.id}><td>{g.id}</td><td>{g.text}</td><td>{word(g.owner)}</td><td><Pill tone={g.status === 'open' ? 'ok' : undefined}>{word(g.status)}</Pill></td>
                <td>{g.due === undefined ? '—' : stamp(g.due)}</td><td>{g.notes.at(-1)?.text ?? ''}</td>
                <td>{g.status !== 'open' ? null : <Confirm label={t('inbox.close')} question={t('inbox.closeQuestion', { id: g.id })} reason="" busy={goal.busy}
                  onConfirm={reason => void goal.run<Goal>('goal.close', { id: g.id, reason }, v => t('inbox.closed', { id: v.id }))} />}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  )
}
