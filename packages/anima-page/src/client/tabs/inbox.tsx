/** Goals, approvals and outbox: what waits on the owner. */
import { useState } from 'react'
import { view } from '../api.ts'
import { stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
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
        <h2>Approvals</h2>
        <p className="anima-muted">Owner line: {approvals.data?.ownerLine ?? 'none — approval-class behaviors are refused'}.</p>
        <Problem error={approvals.error} />
        {answer.outcome}
        {(approvals.data?.pending ?? []).length === 0 ? <p className="anima-muted">Nothing waits for your answer.</p> : (
          <table className="anima-table">
            <thead><tr><th>Id</th><th>Request</th><th /></tr></thead>
            <tbody>{approvals.data!.pending.map(p => (
              <tr key={p.id}><td>{p.id}</td><td>{p.summary}</td><td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="anima-btn small primary" disabled={answer.busy} onClick={() => void answer.run<{ answered: boolean }>('approve', { id: p.id }, v => v.answered ? `Allowed ${p.id}.` : `${p.id} was already answered or timed out.`)}>Approve</button>{' '}
                <button type="button" className="anima-btn small danger" disabled={answer.busy} onClick={() => void answer.run<{ answered: boolean }>('deny', { id: p.id }, v => v.answered ? `Denied ${p.id}.` : `${p.id} was already answered or timed out.`)}>Deny</button>
              </td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>Outbox</h2>
        <p className="anima-muted">Messages she started on her own wait {outbox.data?.delaySeconds ?? '?'} s before they go out.</p>
        <Problem error={outbox.error} />
        {cancel.outcome}
        {(outbox.data?.held ?? []).length === 0 ? <p className="anima-muted">Nothing is held.</p> : (
          <table className="anima-table">
            <thead><tr><th>Id</th><th>To</th><th>Message</th><th>Sends in</th><th /></tr></thead>
            <tbody>{outbox.data!.held.map(m => (
              <tr key={m.id}><td>{m.id}</td><td>{m.display}<div className="anima-muted">intent {m.intentId}</div></td><td>{m.text}</td>
                <td>{Math.max(0, Math.round((m.sendsAt - Date.now()) / 1000))} s</td>
                <td><button type="button" className="anima-btn small danger" disabled={cancel.busy} onClick={() => { void cancel.run<{ cancelled: boolean }>('outbox.cancel', { id: m.id }, v => v.cancelled ? `Cancelled ${m.id}; it will not be sent.` : `${m.id} already went out.`) }}>Cancel</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>Goals</h2>
        <Problem error={goals.error} />
        <form className="anima-row" onSubmit={(e) => {
          e.preventDefault()
          if (text.trim() === '') return
          void goal.run<Goal>('goal.add', { text, ...due.trim() === '' ? {} : { due } }, g => `Added ${g.id}.`).then(g => { if (g !== undefined) { setText(''); setDue('') } })
        }}>
          <input className="anima-input" style={{ flex: 1 }} placeholder="A goal for her (owner goal)" value={text} onChange={e => setText(e.target.value)} aria-label="New goal" />
          <input className="anima-input" style={{ minWidth: 160 }} placeholder="due: YYYY-MM-DD HH:mm" value={due} onChange={e => setDue(e.target.value)} aria-label="Due" />
          <button type="submit" className="anima-btn" disabled={goal.busy}>Add goal</button>
          <label><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} /> show closed</label>
        </form>
        {goal.outcome}
        {list.length === 0 ? <p className="anima-muted">No goals.</p> : (
          <table className="anima-table">
            <thead><tr><th>Id</th><th>Goal</th><th>Owner</th><th>Status</th><th>Due</th><th>Latest note</th><th /></tr></thead>
            <tbody>{list.map(g => (
              <tr key={g.id}><td>{g.id}</td><td>{g.text}</td><td>{g.owner}</td><td><Pill tone={g.status === 'open' ? 'ok' : undefined}>{g.status}</Pill></td>
                <td>{g.due === undefined ? '—' : stamp(g.due)}</td><td>{g.notes.at(-1)?.text ?? ''}</td>
                <td>{g.status !== 'open' ? null : <Confirm label="Close" question={`Close ${g.id} as done? Reason (optional):`} reason="" busy={goal.busy}
                  onConfirm={reason => void goal.run<Goal>('goal.close', { id: g.id, reason }, v => `Closed ${v.id}.`)} />}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  )
}
