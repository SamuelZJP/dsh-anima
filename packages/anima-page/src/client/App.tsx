/**
 * The Anima page: one panel with tabs. Every read is an owner view and every
 * change an owner action (the same functions as the `/anima` commands).
 * @module @anima/page/client/App
 */
import { useState } from 'react'
import { view } from './api.ts'
import { usePoll } from './hooks.ts'
import { lang, setLang, t, type Key } from './i18n.ts'
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
  { id: 'status', label: 'tab.status', Body: StatusTab },
  { id: 'persona', label: 'tab.persona', Body: PersonaTab },
  { id: 'memory', label: 'tab.memory', Body: MemoryTab },
  { id: 'inbox', label: 'tab.inbox', Body: InboxTab },
  { id: 'activity', label: 'tab.activity', Body: ActivityTab },
  { id: 'platforms', label: 'tab.platforms', Body: PlatformsTab },
  { id: 'settings', label: 'tab.settings', Body: SettingsTab },
] as const satisfies readonly { id: string; label: Key; Body: unknown }[]

type TabId = (typeof TABS)[number]['id']

const STORAGE_KEY = 'anima-page.tab'

function initialTab(): TabId {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (TABS.some(item => item.id === saved)) return saved as TabId
  } catch {
    // Storage may be unavailable; start on Status.
  }
  return 'status'
}

export function AnimaPage() {
  const [tab, setTab] = useState<TabId>(initialTab)
  // Copy is read from the i18n module at render; this state re-renders the page on a switch.
  const [language, setLanguage] = useState(lang)
  const switchLanguage = () => {
    const next = language === 'zh' ? 'en' : 'zh'
    setLang(next)
    setLanguage(next)
  }
  const head = usePoll(() => view<StatusView>('status'), 15000, [])
  const approvals = head.data?.approvals ?? 0
  const select = (id: TabId) => {
    setTab(id)
    try { window.localStorage.setItem(STORAGE_KEY, id) } catch { /* not persisted */ }
  }
  const Body = TABS.find(item => item.id === tab)!.Body
  return (
    <div className="anima-page" lang={language === 'zh' ? 'zh-CN' : 'en'}>
      <div className="anima-inner">
        <div className="anima-head">
          <h1>{head.data?.character.name ?? 'Anima'}</h1>
          <span className="anima-sub">{head.data === undefined ? '' : `${head.data.character.id} · ${head.data.clock.text} · ${t(head.data.sleep?.asleep === true ? 'head.asleep' : 'head.awake')}${head.data.paused ? ` · ${t('head.paused')}` : ''}`}</span>
          <button type="button" className="anima-btn small anima-lang" title={t('lang.switchTitle')} onClick={switchLanguage}>{t('lang.switch')}</button>
        </div>
        <div className="anima-tabs" role="tablist" aria-label="Anima">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="anima-tab" aria-selected={tab === item.id} onClick={() => select(item.id)}>
              {t(item.label)}{item.id === 'inbox' && approvals > 0 ? ` (${approvals})` : ''}
            </button>
          ))}
        </div>
        <div role="tabpanel"><Body /></div>
      </div>
    </div>
  )
}
