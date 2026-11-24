import { describe, expect, it } from 'vitest'
import { wakingSessionId, WakingSessions, type WakingState } from '../src/index.ts'
import { FakeHost, tempDir } from './helpers.ts'

function sessions() {
  const host = new FakeHost()
  const state: WakingState = { pending: [], past: [] }
  let saves = 0
  const waking = new WakingSessions(host, state, {
    characterId: 'anima', dataDir: tempDir(), model: { provider: 'p', model: 'm' },
    title: at => `Anima · ${at}`, save: () => { saves++ }, warn: () => {},
  })
  return { host, state, waking, saves: () => saves }
}

describe('her waking sessions', () => {
  it('names a waking from her character and the moment it was prepared', () => {
    expect(wakingSessionId('anima', 5)).toMatch(/^anima-w-[0-9a-f]{24}$/)
    expect(wakingSessionId('anima', 5)).toBe(wakingSessionId('anima', 5))
    expect(wakingSessionId('anima', 5)).not.toBe(wakingSessionId('anima', 6))
    expect(wakingSessionId('anima', 5)).not.toBe(wakingSessionId('mio', 5))
  })

  it('creates her first waking session once, on the waking preset and model, and titles it when opened', async () => {
    const { host, waking } = sessions()
    const first = await waking.ensureCurrent(100)
    expect(await waking.ensureCurrent(200)).toBe(first)
    expect(host.order).toEqual([wakingSessionId('anima', 100)])
    expect(first).toMatchObject({ preset: 'anima-waking', models: [{ provider: 'p', model: 'm' }], title: 'Anima · next waking' })
    expect(waking.describe(first.id)).toEqual({ kind: 'waking', current: true })
    expect(waking.describe('plain-dsh')).toBeUndefined()
    waking.markOpened(first, 150)
    expect(first.title).toBe('Anima · 150')
    expect(waking.opened).toBe(true)
  })

  it('at sleep prepares the next session, moves her alarms into it, and archives the ended one after its last turn', async () => {
    const { host, waking, state } = sessions()
    const first = await waking.ensureCurrent(100)
    host.alarms.set('s1', first.id)
    host.alarms.set('s2', 'someone-else')
    host.busy.add(first.id)
    const { ended, next, alarms } = await waking.sleep(500, id => host.busy.has(id))
    expect(ended).toBe(first.id)
    expect(next).toBe(wakingSessionId('anima', 500))
    expect(alarms).toBe(1)
    expect(host.alarms.get('s1')).toBe(next)
    expect(host.alarms.get('s2')).toBe('someone-else')
    // Its last turn still runs: it waits.
    expect(host.archived.has(first.id)).toBe(false)
    expect(state.pending).toEqual([first.id])
    expect(waking.describe(first.id)).toEqual({ kind: 'waking', current: false })
    expect(waking.describe(next)).toEqual({ kind: 'waking', current: true })
    expect(waking.opened).toBe(false)
    host.busy.delete(first.id)
    expect(await waking.archivePending(() => false)).toEqual([first.id])
    expect(host.archived.has(first.id)).toBe(true)
    expect(state).toMatchObject({ pending: [], past: [first.id], current: next })
    // An earlier waking still reads as hers.
    expect(waking.describe(first.id)).toEqual({ kind: 'waking', current: false })
  })

  it('archives at once when the ended session is idle, and keeps a refused one pending', async () => {
    const { host, waking, state } = sessions()
    const first = await waking.ensureCurrent(100)
    await waking.sleep(500, () => false)
    expect(host.archived.has(first.id)).toBe(true)
    const second = await waking.ensureCurrent(600)
    // DSH refuses (it still sees activity there): it stays pending.
    host.busy.add(second.id)
    await waking.sleep(900, () => false)
    expect(state.pending).toEqual([second.id])
    host.busy.delete(second.id)
    await waking.archivePending(() => false)
    expect(state.pending).toEqual([])
  })
})
