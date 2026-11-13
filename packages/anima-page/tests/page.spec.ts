import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as animaCore from '@anima/core'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as page from '../src/index.ts'
import type { ConfigEditorLike, FetchRoute } from '../src/index.ts'
import { count, healthClass, parseConfigText, percent, rankedCounts, share } from '../src/client/format.ts'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-page-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Root context with core and the page, and a fake Connection that collects routes. */
async function setup(editor?: ConfigEditorLike) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const routes = new Map<string, FetchRoute>()
  ctx.provide('connection', { fetch: { register: (route: FetchRoute) => { routes.set(route.path, route); return async () => { routes.delete(route.path) } } } } as never)
  if (editor !== undefined) ctx.provide('configEditor', editor as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir: tempDir(), clock: { speed: 1, start: '2026-11-10T10:00' } })
  const fiber = await ctx.plugin(page)
  const get = async (query: string) => routes.get(page.VIEW_PATH)!.fetch(new Request(`http://h${page.VIEW_PATH}?${query}`))
  const post = async (body: unknown) => routes.get(page.ACTION_PATH)!.fetch(new Request(`http://h${page.ACTION_PATH}`, { method: 'POST', body: JSON.stringify(body) }))
  return { ctx, routes, fiber, get, post }
}

describe('page routes', () => {
  it('serves owner views and runs owner actions, logged with source page', async () => {
    const { ctx, routes, get, post } = await setup()
    expect([...routes.keys()].sort()).toEqual([page.ACTION_PATH, page.VIEW_PATH])
    const status = await get('name=status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ value: { paused: false, clock: { day: '2026-11-10' } } })
    expect(await (await post({ name: 'pause' })).json()).toEqual({ value: { paused: true } })
    expect(ctx.anima.paused).toBe(true)
    const owner = ctx.anima.activity.read('2026-11-10').filter(r => r.type === 'owner')
    expect(owner).toEqual([expect.objectContaining({ action: 'pause', source: 'page', ok: true })])
  })

  it('answers errors as JSON with the Anima code', async () => {
    const { get, post } = await setup()
    const unknown = await get('name=nope')
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: { code: 'anima/unknown-view' } })
    expect(await (await get('')).json()).toMatchObject({ error: { code: 'anima/bad-args' } })
    expect(await (await post({ name: 'selfmodel.revert', args: { id: 'd9' } })).json()).toMatchObject({ error: { code: 'anima/self-model-unknown' } })
    const bad = await (await setup()).routes.get(page.ACTION_PATH)!.fetch(new Request('http://h/x', { method: 'POST', body: 'not json' }))
    expect(await bad.json()).toMatchObject({ error: { code: 'anima/bad-args' } })
  })

  it('passes view parameters through', async () => {
    const { ctx, get } = await setup()
    ctx.anima.recordActivity({ type: 'wake', stimulus: 'heartbeat-triage', session: 'triage' })
    const value = (await (await get('name=activity&day=2026-11-10')).json() as { value: { day: string; records: unknown[] } }).value
    expect(value.day).toBe('2026-11-10')
    expect(value.records).toHaveLength(1)
  })

  it('removes its routes when unloaded', async () => {
    const { routes, fiber } = await setup()
    await fiber.dispose()
    expect(routes.size).toBe(0)
  })
})

describe('settings through the config editor', () => {
  function fakeEditor() {
    const entries = [
      { options: { id: 'anima-core', name: '@anima/core', config: { characterId: 'test', dataDir: '/x' } } },
      { options: { id: 'anima-memory', name: '@anima/memory', config: { inject: { tokenBudget: 800 } } } },
      { options: { id: 'anima-adapter-qq', name: '@anima/adapter-qq', config: { url: 'ws://q', accessToken: 'SECRET', allow: { users: [] } } } },
      { options: { id: 'anima-preset-self', name: '@deepseek-ai/dsh-agent-preset', config: {} } },
      { options: { id: 'schedule', name: '@deepseek-ai/dsh-schedule', config: {} } },
    ]
    const edits: { id: string; config: Record<string, unknown> }[] = []
    const editor: ConfigEditorLike = {
      documentPath: '/profile/cordis.patch.yml',
      entries: () => entries,
      configuration: () => entries.map(entry => ({
        entry,
        inherited: entry.options.id === 'anima-core' ? { characterId: 'anima' } : (entry.options.config as Record<string, unknown>),
        override: entry.options.id === 'anima-memory' ? { inject: { tokenBudget: 800 } } : {},
      })),
      edit: async (entry, change) => {
        const next = change({}, {})
        if (typeof next.inject !== 'object') throw new Error('expected object at inject')
        edits.push({ id: entry.options.id, config: next })
      },
    }
    return { editor, edits }
  }

  it('lists Anima rows with layers, hides secrets, flags higher layers', async () => {
    const { editor } = fakeEditor()
    const { get } = await setup(editor)
    const value = (await (await get('name=settings')).json() as { value: { available: boolean; rows: page.SettingsRow[] } }).value
    expect(value.available).toBe(true)
    expect(value.rows.map(r => r.id)).toEqual(['anima-adapter-qq', 'anima-core', 'anima-memory'])
    const [qq, core, memory] = value.rows
    expect(qq).toMatchObject({ editable: false, effective: { accessToken: '(hidden)', url: 'ws://q' }, higherLayer: false })
    expect(core).toMatchObject({ editable: true, higherLayer: true })
    expect(memory).toMatchObject({ editable: true, higherLayer: false })
  })

  it('saves an editable row, refuses read-only rows and invalid config', async () => {
    const { editor, edits } = fakeEditor()
    const { ctx, post } = await setup(editor)
    expect(await (await post({ name: 'settings.save', args: { id: 'anima-memory', config: { inject: { tokenBudget: 900 } } } })).json()).toEqual({ value: { saved: 'anima-memory', path: '/profile/cordis.patch.yml' } })
    expect(edits).toEqual([{ id: 'anima-memory', config: { inject: { tokenBudget: 900 } } }])
    expect(await (await post({ name: 'settings.save', args: { id: 'anima-adapter-qq', config: {} } })).json()).toMatchObject({ error: { code: 'anima/settings-read-only' } })
    expect(await (await post({ name: 'settings.save', args: { id: 'anima-memory', config: { inject: 3 } } })).json()).toMatchObject({ error: { code: 'anima/settings-invalid' } })
    expect(await (await post({ name: 'settings.save', args: { id: 'anima-memory', config: [] } })).json()).toMatchObject({ error: { code: 'anima/bad-args' } })
    expect(ctx.anima.activity.read('2026-11-10').filter(r => r.type === 'owner').map(r => r.type === 'owner' && r.ok)).toEqual([true, false, false, false])
  })

  it('has no settings view without the config editor', async () => {
    const { get } = await setup()
    expect(await (await get('name=settings')).json()).toMatchObject({ error: { code: 'anima/unknown-view' } })
  })
})

describe('client bundle', () => {
  it('loads in DSH factory form and registers the sidebar entry and page', () => {
    const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    let loaded: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
    runInNewContext(code, { window: { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry } } } })
    expect(loaded?.id).toBe('@anima/page')
    const requested: string[] = []
    const exports = loaded!.factory((id) => {
      requested.push(id)
      return id === 'react/jsx-runtime' ? { jsx: () => null, jsxs: () => null, Fragment: 'f' } : { useState: () => [], useEffect: () => {}, useCallback: (f: unknown) => f, useRef: () => ({}) }
    })
    expect(new Set(requested)).toEqual(new Set(['react', 'react/jsx-runtime']))
    expect(exports.inject).toEqual(['slots'])
    const registered: Record<string, unknown>[] = []
    const ctx = {
      effect: (execute: () => () => void) => { execute() },
      slots: {
        inject: (_key: string, callback: () => void) => { callback(); return () => {} },
        register: (options: Record<string, unknown>) => { registered.push(options); return () => {} },
      },
    }
    ;(exports.apply as (c: typeof ctx) => void)(ctx)
    expect(registered).toEqual([
      { name: 'main', key: 'anima' },
      { name: 'sidebar.panellist', id: 'anima', order: 30, label: 'Anima' },
    ])
  })
})

describe('page formatting helpers', () => {
  it('formats numbers and parses settings text', () => {
    expect(percent(0.426)).toBe('43%')
    expect(percent(2)).toBe('100%')
    expect(count(12345.4)).toBe('12,345')
    expect(share(150, 100)).toBe(1)
    expect(share(5, 0)).toBe(0)
    expect(healthClass('down')).toBe('bad')
    expect(rankedCounts({ a: 1, b: 3, c: 1 })).toEqual([['b', 3], ['a', 1], ['c', 1]])
    expect(parseConfigText('{"a":1}')).toEqual({ value: { a: 1 } })
    expect(parseConfigText('[1]')).toEqual({ error: 'The config must be a JSON object.' })
    expect('error' in parseConfigText('{')).toBe(true)
  })
})
