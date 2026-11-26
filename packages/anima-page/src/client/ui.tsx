/**
 * Small shared pieces of the Anima page.
 * @module @anima/page/client/ui
 */
import { useState, type ReactNode } from 'react'
import { action } from './api.ts'
import { percent } from './format.ts'
import { t } from './i18n.ts'

export function Bar({ value, tone }: { value: number; tone?: 'warn' | 'bad' | undefined }) {
  return <div className={`anima-bar${tone === undefined ? '' : ` ${tone}`}`}><span style={{ width: percent(value, 1) }} /></div>
}

export function Pill({ children, tone }: { children: ReactNode; tone?: string | undefined }) {
  return <span className={`anima-pill${tone === undefined ? '' : ` ${tone}`}`}>{children}</span>
}

/**
 * A button that asks inline before it acts, optionally for a reason. The page
 * never uses window.prompt/confirm: embedded browsers (desktop panes) may
 * dismiss native dialogs without showing them.
 */
export function Confirm({ label, question, reason, danger, busy, onConfirm }: {
  label: string
  question: string
  /** Ask for a reason, prefilled with this text; omit to ask yes/no only. */
  reason?: string | undefined
  danger?: boolean | undefined
  busy?: boolean | undefined
  onConfirm: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(reason ?? '')
  if (!open) return <button type="button" className={`anima-btn small${danger === true ? ' danger' : ''}`} disabled={busy} onClick={() => { setText(reason ?? ''); setOpen(true) }}>{label}</button>
  return (
    <div className="anima-confirm" role="group" aria-label={question}>
      <div>{question}</div>
      {reason === undefined ? null : <input className="anima-input" style={{ minWidth: 0, width: '100%' }} value={text} onChange={e => setText(e.target.value)} aria-label={t('common.reason')} />}
      <div className="anima-row" style={{ marginTop: 4, marginBottom: 0 }}>
        <button type="button" className={`anima-btn small ${danger === true ? 'danger' : 'primary'}`} disabled={busy} onClick={() => { setOpen(false); onConfirm(text) }}>{label}</button>
        <button type="button" className="anima-btn small" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return <div className="anima-card"><h3>{title}</h3>{children}</div>
}

export function Problem({ error }: { error: string | undefined }) {
  return error === undefined ? null : <div className="anima-error" role="alert">{error}</div>
}

/** Running one owner action from a button, with its outcome shown next to it. */
export function useAction(after?: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)
  const run = async <T,>(name: string, args: Record<string, unknown> = {}, success?: (value: T) => string): Promise<T | undefined> => {
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    try {
      const value = await action<T>(name, args)
      if (success !== undefined) setDone(success(value))
      after?.()
      return value
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    } finally {
      setBusy(false)
    }
  }
  const outcome = <>{error === undefined ? null : <div className="anima-error" role="alert">{error}</div>}{done === undefined ? null : <div className="anima-note" role="status">{done}</div>}</>
  return { busy, run, outcome }
}
