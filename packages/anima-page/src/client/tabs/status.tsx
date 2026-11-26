/** Status tab: her clock, state, budgets, heartbeat and platform health. */
import { view } from '../api.ts'
import { count, healthClass, share, stamp } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
import type { PlatformEntry, StatusView } from '../types.ts'
import { Bar, Card, Pill, Problem, useAction } from '../ui.tsx'

export function StatusTab() {
  const status = usePoll(() => view<StatusView>('status'), 5000, [])
  const platforms = usePoll(() => view<PlatformEntry[]>('platforms'), 5000, [])
  const act = useAction(status.reload)
  const s = status.data
  if (s === undefined) return <><Problem error={status.error} />{status.loading ? <p className="anima-muted">{t('common.loading')}</p> : null}</>
  const life = s.parts.life
  const tokens = s.budgets.tokens
  const mode = s.sleep?.asleep === true ? 'night' : 'day'
  const used = mode === 'day' ? tokens.day : tokens.night
  const budget = mode === 'day' ? tokens.dayBudget : tokens.nightBudget
  const tone = (v: number) => v >= 1 ? 'bad' as const : v >= 0.8 ? 'warn' as const : undefined
  return (
    <>
      <Problem error={status.error} />
      <div className="anima-row">
        {s.paused ? <Pill tone="bad">{t('status.paused')}</Pill> : <Pill tone="ok">{t('status.running')}</Pill>}
        <button type="button" className="anima-btn" disabled={act.busy} onClick={() => void act.run(s.paused ? 'resume' : 'pause', {}, () => s.paused ? t('status.resumed') : t('status.pausedNote'))}>
          {s.paused ? t('status.resume') : t('status.pause')}
        </button>
        {s.sleep === undefined ? null : s.sleep.asleep
          ? <Pill tone="warn">{t('status.asleepSince', { since: stamp(s.sleep.since), why: s.sleep.by === 'overwhelmed' ? t('status.tookHer') : t('status.wentToBed') })}</Pill>
          : <Pill tone="ok">{t('status.awakeSince', { since: stamp(s.sleep.since), by: s.sleep.by })}</Pill>}
        {s.sleep?.asleep === true
          ? <button type="button" className="anima-btn" disabled={act.busy} onClick={() => void act.run('wake', {}, () => t('status.woke'))}>{t('status.wake')}</button>
          : null}
        <span className="anima-muted">{t('status.updates')}</span>
      </div>
      {act.outcome}
      <div className="anima-grid">
        <Card title={t('status.clock')}>
          <div className="anima-big">{s.clock.text}</div>
          <div className="anima-muted">{s.clock.speed === 1 ? t('status.realTime') : t('status.speed', { speed: s.clock.speed })} · {t('status.day', { day: s.clock.day })}</div>
          <div className="anima-row" style={{ marginTop: 6 }}><Pill>{t(s.sleep?.asleep === true ? 'head.asleep' : 'head.awake')}</Pill></div>
        </Card>
        <Card title={t('status.heartbeat')}>
          <dl className="anima-kv">
            <dt>{t('status.next')}</dt><dd>{life?.nextHeartbeat ?? '—'}</dd>
            <dt>{t('status.last')}</dt><dd>{life?.lastHeartbeat ?? '—'}</dd>
            <dt>{t('status.total')}</dt><dd>{life === undefined ? '—' : t('status.totalValue', { beats: life.counts.heartbeats, wakings: life.counts.wakings, sleeps: life.counts.sleeps })}</dd>
            <dt>{t('status.wakingSession')}</dt><dd>{life?.sessions.waking ?? '—'}{life !== undefined && !life.sessions.opened ? t('status.prepared') : ''}</dd>
          </dl>
        </Card>
        <Card title={t('status.energyMood')}>
          <div className="anima-row"><span style={{ width: 60 }}>{t('status.energy')}</span><Bar value={s.energy} /><span>{s.energy.toFixed(2)}</span></div>
          <dl className="anima-kv">
            <dt>{t('status.valence')}</dt><dd>{s.mood.valence.toFixed(2)} <span className="anima-muted">{t('status.valenceHint')}</span></dd>
            <dt>{t('status.arousal')}</dt><dd>{s.mood.arousal.toFixed(2)} <span className="anima-muted">{t('status.arousalHint')}</span></dd>
          </dl>
        </Card>
        <Card title={t('status.budget', { mode: t(mode === 'day' ? 'status.modeDay' : 'status.modeNight') })}>
          <div className="anima-row"><Bar value={share(used, budget)} tone={tone(share(used, budget))} /></div>
          <div>{t('status.tokensOf', { used: count(used), budget: count(budget) })}</div>
          <div className="anima-muted">{t('status.dayNight', { day: count(tokens.day), night: count(tokens.night) })}</div>
          <div style={{ marginTop: 6 }}>{t('status.initiates', { used: s.budgets.initiates.used, perDay: s.budgets.initiates.perDay })}</div>
        </Card>
      </div>
      <div className="anima-section">
        <h2>{t('status.sleepInbox')}</h2>
        {s.sleep === undefined ? null : (
          <div className="anima-row"><span style={{ width: 110 }}>{t('status.pressure')}</span><Bar value={s.sleep.pressure} /><span>{s.sleep.pressure.toFixed(2)}</span></div>
        )}
        <p className="anima-muted">{t('status.sleepNote')}</p>
        {(life?.inbox ?? []).length === 0 ? <p className="anima-muted">{t('status.inboxEmpty')}</p> : (
          <table className="anima-table">
            <thead><tr><th>{t('status.chat')}</th><th>{t('status.messages')}</th><th>{t('status.first')}</th><th>{t('status.latest')}</th></tr></thead>
            <tbody>{life!.inbox!.map(entry => <tr key={entry.key}><td>{entry.display}</td><td>{entry.count}</td><td>{stamp(entry.first)}</td><td>{stamp(entry.last)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="anima-section">
        <h2>{t('status.needs')}</h2>
        {s.needs.slice().sort((a, b) => b.value - a.value).map(need => (
          <div key={need.name} className="anima-row" title={need.description}>
            <span style={{ width: 90 }}>{need.name}</span><Bar value={need.value} tone={tone(need.value)} /><span style={{ width: 40 }}>{need.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="anima-section">
        <h2>{t('status.platforms')}</h2>
        <Problem error={platforms.error} />
        {(platforms.data ?? []).length === 0 ? <p className="anima-muted">{t('status.noPlatforms')}</p> : null}
        {(platforms.data ?? []).map(p => (
          <div key={p.platform} className="anima-row"><Pill tone={healthClass(p.view.health)}>{p.title}: {word(p.view.health)}</Pill><span>{p.view.summary}</span></div>
        ))}
      </div>
      <div className="anima-section">
        <h2>{t('status.openItems')}</h2>
        <p>{t('status.openItemsValue', { goals: s.goals, approvals: s.approvals, held: life?.outboxHeld ?? 0, notes: s.selfModel.notes, owner: s.ownerLine ?? t('common.none') })}</p>
      </div>
      <div className="anima-section">
        <h2>{t('status.quotas')}</h2>
        <pre className="anima-pre">{s.quotas.join('\n')}</pre>
      </div>
    </>
  )
}
