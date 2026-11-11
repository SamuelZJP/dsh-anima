/**
 * Polling hook: reads an owner view now and every `intervalMs` while the
 * document is visible. Live data on the page comes only from polling (DSH
 * offers no push channel for plugin routes; DSH-INTEGRATION §8e).
 * @module @anima/page/client/hooks
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Result of {@link usePoll}. */
export interface Polled<T> {
  readonly data: T | undefined
  readonly error: string | undefined
  readonly loading: boolean
  /** Read again now. */
  readonly reload: () => void
}

/**
 * Poll a loader.
 * @param load - reads the data.
 * @param intervalMs - poll interval; 0 reads only once (and on reload).
 * @param deps - re-read when these change.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, deps: readonly unknown[]): Polled<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const read = useCallback(() => {
    const mine = ++generation.current
    loadRef.current().then(
      (value) => { if (mine === generation.current) { setData(value); setError(undefined); setLoading(false) } },
      (cause: unknown) => { if (mine === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) } },
    )
  }, [])

  useEffect(() => {
    setLoading(true)
    read()
    if (intervalMs <= 0) return () => { generation.current++ }
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read() }, intervalMs)
    return () => { clearInterval(timer); generation.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read, intervalMs, ...deps])

  return { data, error, loading, reload: read }
}
