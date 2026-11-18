/** Status tab: her clock, state, budgets, heartbeat and platform health. */
import { view } from '../api.ts'
import { count, healthClass, share, stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import type { PlatformEntry, StatusView } from '../types.ts'
import { Bar, Card, Pill, Problem, useAction } from '../ui.tsx'

export function StatusTab() {
  const status = usePoll(() => view<StatusView>('status'), 5000, [])
  const platforms = usePoll(() => view<PlatformEntry[]>('platforms'), 5000, [])
  const act = useAction(status.reload)
  const s = status.data
  if (s === undefined) return <><Problem error={status.error} />{status.loading ? <p className="anima-muted">Loading…</p> : null}</>
  const life = s.parts.life
  const tokens = s.budgets.tokens
  const mode = s.clock.mode
  const used = mode === 'day' ? tokens.day : tokens.night
  const budget = mode === 'day' ? tokens.dayBudget : tokens.nightBudget
  const tone = (v: number) => v >= 1 ? 'bad' as const : v >= 0.8 ? 'warn' as const : undefined
  return (
    <>
      <Problem error={status.error} />
      <div className="anima-row">
        {s.paused ? <Pill tone="bad">paused</Pill> : <Pill tone="ok">running</Pill>}
        <button type="button" className="anima-btn" disabled={act.busy} onClick={() => void act.run(s.paused ? 'resume' : 'pause', {}, () => s.paused ? 'Resumed.' : 'Paused: nothing reaches her and every behavior is refused; her heart keeps beating.')}>
          {s.paused ? 'Resume' : 'Pause'}
        </button>
        {s.sleep === undefined ? null : s.sleep.asleep
          ? <Pill tone="warn">asleep since {stamp(s.sleep.since ?? 0)}{s.sleep.by === 'latest' ? ' (latest bedtime)' : ''}</Pill>
          : <Pill tone="ok">awake{s.sleep.wokenAt !== undefined && s.sleep.wokenUntil !== undefined && s.clock.now < s.sleep.wokenUntil ? ` (woken by you, until ${stamp(s.sleep.wokenUntil)})` : ''}</Pill>}
        {s.sleep?.asleep === true
          ? <button type="button" className="anima-btn" disabled={act.busy} onClick={() => void act.run('wake', {}, () => 'She is awake now; her Self sees the inbox.')}>Wake her</button>
          : null}
        <span className="anima-muted">Updates every 5 s.</span>
      </div>
      {act.outcome}
      <div className="anima-grid">
        <Card title="Her clock">
          <div className="anima-big">{s.clock.text}</div>
          <div className="anima-muted">{s.clock.speed === 1 ? 'real time' : `${s.clock.speed}× speed`} · day {s.clock.day}</div>
          <div className="anima-row" style={{ marginTop: 6 }}><Pill>{s.clock.phase}</Pill><Pill>{mode}</Pill></div>
        </Card>
        <Card title="Heartbeat">
          <dl className="anima-kv">
            <dt>Next</dt><dd>{life?.nextHeartbeat ?? '—'}{life?.selfActing === true ? ' (Self is acting)' : ''}</dd>
            <dt>Last</dt><dd>{life?.lastHeartbeat ?? '—'}</dd>
            <dt>Total</dt><dd>{life === undefined ? '—' : `${life.counts.heartbeats} beats, ${life.counts.acts} acted, ${life.counts.rests} rests`}</dd>
          </dl>
        </Card>
        <Card title="Energy and mood">
          <div className="anima-row"><span style={{ width: 60 }}>energy</span><Bar value={s.energy} /><span>{s.energy.toFixed(2)}</span></div>
          <dl className="anima-kv">
            <dt>valence</dt><dd>{s.mood.valence.toFixed(2)} <span className="anima-muted">(−1 bad … 1 good)</span></dd>
            <dt>arousal</dt><dd>{s.mood.arousal.toFixed(2)} <span className="anima-muted">(0 calm … 1 excited)</span></dd>
          </dl>
        </Card>
        <Card title={`Budget (${mode})`}>
          <div className="anima-row"><Bar value={share(used, budget)} tone={tone(share(used, budget))} /></div>
          <div>{count(used)} of {count(budget)} billable tokens</div>
          <div className="anima-muted">day {count(tokens.day)} · night {count(tokens.night)}</div>
          <div style={{ marginTop: 6 }}>Conversations started {s.budgets.initiates.used} of {s.budgets.initiates.perDay}</div>
        </Card>
      </div>
      <div className="anima-section">
        <h2>Sleep and inbox</h2>
        {s.sleep === undefined ? null : <p>Bedtime window {stamp(s.sleep.earliest).slice(-5)}–{stamp(s.sleep.latest).slice(-5)}; she chooses inside it, and sleeps anyway at the latest.</p>}
        {(life?.inbox ?? []).length === 0 ? <p className="anima-muted">Her inbox is empty.</p> : (
          <table className="anima-table">
            <thead><tr><th>Chat</th><th>Messages</th><th>First</th><th>Last</th></tr></thead>
            <tbody>{life!.inbox!.map(entry => <tr key={entry.key}><td>{entry.display}</td><td>{entry.count}</td><td>{stamp(entry.first)}</td><td>{stamp(entry.last)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>Needs</h2>
        {s.needs.slice().sort((a, b) => b.value - a.value).map(need => (
          <div key={need.name} className="anima-row" title={need.description}>
            <span style={{ width: 90 }}>{need.name}</span><Bar value={need.value} tone={tone(need.value)} /><span style={{ width: 40 }}>{need.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="anima-section">
        <h2>Platforms</h2>
        <Problem error={platforms.error} />
        {(platforms.data ?? []).length === 0 ? <p className="anima-muted">No platform adapters are loaded besides the local channel.</p> : null}
        {(platforms.data ?? []).map(p => (
          <div key={p.platform} className="anima-row"><Pill tone={healthClass(p.view.health)}>{p.title}: {p.view.health}</Pill><span>{p.view.summary}</span></div>
        ))}
      </div>
      <div className="anima-section">
        <h2>Open items</h2>
        <p>{s.goals} open goals · {s.approvals} pending approvals · {life?.outboxHeld ?? 0} held messages · {s.selfModel.notes} self-model notes · owner line: {s.ownerLine ?? 'none'}</p>
      </div>
      <div className="anima-section">
        <h2>Quotas</h2>
        <pre className="anima-pre">{s.quotas.join('\n')}</pre>
      </div>
    </>
  )
}
