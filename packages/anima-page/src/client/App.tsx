/**
 * The Anima page: one panel with tabs. Every read is an owner view and every
 * change an owner action (the same functions as the `/anima` commands).
 * @module @anima/page/client/App
 */
import { useState } from 'react'
import { view } from './api.ts'
import { usePoll } from './hooks.ts'
import { ActivityTab } from './tabs/activity.tsx'
import { InboxTab } from './tabs/inbox.tsx'
import { MemoryTab } from './tabs/memory.tsx'
import { PersonaTab } from './tabs/persona.tsx'
import { PlatformsTab } from './tabs/platforms.tsx'
import { SettingsTab } from './tabs/settings.tsx'
import { StatusTab } from './tabs/status.tsx'
import type { StatusView } from './types.ts'

/** Tabs, in order. */
export const TABS = [
  { id: 'status', label: 'Status', Body: StatusTab },
  { id: 'persona', label: 'Persona', Body: PersonaTab },
  { id: 'memory', label: 'Memory', Body: MemoryTab },
  { id: 'inbox', label: 'Goals · Approvals · Outbox', Body: InboxTab },
  { id: 'activity', label: 'Activity', Body: ActivityTab },
  { id: 'platforms', label: 'Platforms', Body: PlatformsTab },
  { id: 'settings', label: 'Settings', Body: SettingsTab },
] as const

type TabId = (typeof TABS)[number]['id']

const STORAGE_KEY = 'anima-page.tab'

function initialTab(): TabId {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (TABS.some(t => t.id === saved)) return saved as TabId
  } catch {
    // Storage may be unavailable; start on Status.
  }
  return 'status'
}

export function AnimaPage() {
  const [tab, setTab] = useState<TabId>(initialTab)
  const head = usePoll(() => view<StatusView>('status'), 15000, [])
  const approvals = head.data?.approvals ?? 0
  const select = (id: TabId) => {
    setTab(id)
    try { window.localStorage.setItem(STORAGE_KEY, id) } catch { /* not persisted */ }
  }
  const Body = TABS.find(t => t.id === tab)!.Body
  return (
    <div className="anima-page">
      <div className="anima-inner">
        <div className="anima-head">
          <h1>{head.data?.character.name ?? 'Anima'}</h1>
          <span className="anima-sub">{head.data === undefined ? '' : `${head.data.character.id} · ${head.data.clock.text} · ${head.data.clock.phase}${head.data.paused ? ' · paused' : ''}`}</span>
        </div>
        <div className="anima-tabs" role="tablist" aria-label="Anima">
          {TABS.map(t => (
            <button key={t.id} type="button" role="tab" className="anima-tab" aria-selected={tab === t.id} onClick={() => select(t.id)}>
              {t.label}{t.id === 'inbox' && approvals > 0 ? ` (${approvals})` : ''}
            </button>
          ))}
        </div>
        <div role="tabpanel"><Body /></div>
      </div>
    </div>
  )
}
