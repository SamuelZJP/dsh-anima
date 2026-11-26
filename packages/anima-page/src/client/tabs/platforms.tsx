/** Platforms tab: each adapter's connection and allowlist; Bilibili QR login on the page. */
import { view } from '../api.ts'
import { clockTime, healthClass } from '../format.ts'
import { usePoll } from '../hooks.ts'
import { t, word } from '../i18n.ts'
import type { PlatformEntry } from '../types.ts'
import { Confirm, Pill, Problem, useAction } from '../ui.tsx'

function Details({ details }: { details: Record<string, unknown> }) {
  const rows = Object.entries(details).filter(([key]) => key !== 'pendingQr')
  return (
    <dl className="anima-kv">
      {rows.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value !== null && typeof value === 'object' ? <pre className="anima-pre">{JSON.stringify(value, null, 2)}</pre> : String(value ?? '—')}</dd>
        </div>
      ))}
    </dl>
  )
}

function BiliLogin({ entry, reload }: { entry: PlatformEntry; reload: () => void }) {
  const act = useAction(reload)
  const qr = entry.view.details.pendingQr as { svg: string; expiresAt: number } | null | undefined
  return (
    <div style={{ marginTop: 10 }}>
      {qr === null || qr === undefined ? (
        <div className="anima-row">
          <button type="button" className="anima-btn primary" disabled={act.busy} onClick={() => void act.run('bili.login', {}, () => t('platforms.scanDone'))}>{t('platforms.login')}</button>
          {entry.view.details.loggedIn === true ? <Confirm label={t('platforms.logout')} danger question={t('platforms.logoutQuestion')} busy={act.busy}
            onConfirm={() => void act.run<{ removed: boolean }>('bili.logout', {}, v => v.removed ? t('platforms.loggedOut') : t('platforms.notLoggedIn'))} /> : null}
        </div>
      ) : (
        <div>
          <p>{t('platforms.scan', { at: clockTime(qr.expiresAt) })}</p>
          {/* The SVG comes from the adapter's own QR encoder (no scripts). */}
          <div className="anima-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
        </div>
      )}
      {act.outcome}
    </div>
  )
}

export function PlatformsTab() {
  const platforms = usePoll(() => view<PlatformEntry[]>('platforms'), 3000, [])
  return (
    <>
      <Problem error={platforms.error} />
      <p className="anima-muted">{t('platforms.note')}</p>
      {(platforms.data ?? []).length === 0 ? <p className="anima-muted">{t('platforms.none')}</p> : null}
      {(platforms.data ?? []).map(entry => (
        <div key={entry.platform} className="anima-card anima-section">
          <div className="anima-row"><b>{entry.title}</b><Pill tone={healthClass(entry.view.health)}>{word(entry.view.health)}</Pill><span>{entry.view.summary}</span></div>
          <Details details={entry.view.details} />
          {entry.platform === 'bili' ? <BiliLogin entry={entry} reload={platforms.reload} /> : null}
        </div>
      ))}
    </>
  )
}
