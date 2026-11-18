import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as animaCore from '../src/index.ts'
import { personaText } from '../src/persona.ts'
import { HER_WORLD, SESSION_RULES } from '../src/primer.ts'
import { callAs, fakeAgent, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const localChat = {
  kind: 'conversation' as const,
  channel: { platform: 'demo', account: 'owner', kind: 'private', id: 'owner' },
  channelKey: 'demo:owner:private:owner',
}
const say = { platform: 'demo', effect: 'express' as const, sessions: ['conversation' as const] }
const self = { kind: 'self' as const }
const T = new Date('2026-11-10T10:00').getTime()

describe('body check on tools/pre-execute', () => {
  it('hides behaviors outside Anima sessions', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'demo_say', say)
    for (const [sessionId, visible] of [['plain', false], ['chat-1', true]] as const) {
      const agent = fakeAgent(sessionId)
      const resolved = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal: new AbortController().signal })
      expect(resolved.view(agent).has('demo_say')).toBe(visible)
      resolved.dispose()
    }
  })

  it('has no limits of its own: without anything outside, she can say as much as she likes', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'demo_say', say)
    for (let i = 0; i < 40; i++) expect((await callAs(ctx, 'chat-1', 'demo_say')).isError).toBe(false)
  })

  it('admits everything when nothing outside listens', async () => {
    const ctx = await setupCore()
    expect(ctx.anima.admit({ kind: 'reach' })).toBeUndefined()
    expect(ctx.anima.admit({ kind: 'turn', purpose: 'heartbeat' })).toBeUndefined()
    expect(ctx.anima.admit({ kind: 'wake', name: 'group_attention', channelKey: 'x' })).toBeUndefined()
  })

  it('emits her records for whoever keeps a log outside', async () => {
    const ctx = await setupCore()
    const seen: unknown[] = []
    ctx.on('anima/record', record => { seen.push(record) })
    provideSessions(ctx, { self })
    registerEcho(ctx, 'demo_say', say)
    await callAs(ctx, 'self', 'demo_say')
    expect(seen).toEqual([expect.objectContaining({ type: 'gate', behavior: 'demo_say', decision: 'refused', code: 'anima/wrong-session', day: '2026-11-10' })])
  })
})

describe('behavior registry', () => {
  it('rejects names without the platform prefix', async () => {
    const ctx = await setupCore()
    expect(() => registerEcho(ctx, 'say', say)).toThrow(/anima\/behavior-name/)
  })

  it('removes the tool and its metadata when the owner plugin unloads', async () => {
    const ctx = await setupCore()
    const fiber = await ctx.plugin({ name: 'owner', inject: ['anima'], apply: (child: Context) => registerEcho(child, 'demo_say', say) })
    expect(ctx.tools.get('demo_say')).toBeDefined()
    expect(ctx.anima.behavior('demo_say')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('demo_say')).toBeUndefined()
    expect(ctx.anima.behavior('demo_say')).toBeUndefined()
  })
})

describe('config and constitution', () => {
  it('fails loud on invalid config, and on safety keys that moved outside', () => {
    expect(() => animaCore.resolveConfig({ characterId: 'Bad Id' })).toThrow(/anima\/config-invalid/)
    expect(() => animaCore.resolveConfig({ quotas: [] } as never)).toThrow(/anima\/config-moved: quotas moved to the anima-guard row/)
    expect(() => animaCore.resolveConfig({ modes: { day: { tokenBudget: 5 } } } as never)).toThrow(/anima\/config-moved: modes\.\*\.tokenBudget/)
  })

  it('writes the default constitution once and keeps owner edits', async () => {
    const dataDir = tempDataDir()
    const ctx = await setupCore({ dataDir, name: 'Mio' })
    const path = join(dataDir, 'constitution.md')
    expect(existsSync(path)).toBe(true)
    expect(ctx.anima.constitution()).toContain('You are Mio')
    writeFileSync(path, 'You are Rin.\n')
    const again = await setupCore({ dataDir })
    expect(again.anima.constitution()).toBe('You are Rin.\n')
    expect(readFileSync(path, 'utf8')).toBe('You are Rin.\n')
  })

  it('builds the persona from constitution and session rules', () => {
    const text = personaText('You are Rin.\n', 'conversation')
    expect(text.startsWith(`You are Rin.\n\n${HER_WORLD}\n\n## 此处\n`)).toBe(true)
    expect(text).toContain('你写下的普通文字不会到达任何人')
    expect(text.trimEnd().endsWith(SESSION_RULES.conversation)).toBe(true)
    expect(personaText('X', 'self')).toContain(SESSION_RULES.self)
  })
})

describe('core service', () => {
  it('applies satisfied needs when a behavior succeeds and persists state', async () => {
    const dataDir = tempDataDir()
    const ctx = await setupCore({ dataDir })
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { 'chat-1': { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '2' }, channelKey: 'qq:1:private:2' } })
    registerEcho(ctx, 'qq_say', { ...say, platform: 'qq' })
    const before = ctx.anima.selfState().needs.connect!
    await callAs(ctx, 'chat-1', 'qq_say')
    expect(ctx.anima.selfState().needs.connect).toBeCloseTo(Math.max(0, before - 0.3))
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).self.needs.connect).toBeCloseTo(Math.max(0, before - 0.3))
  })

  it('sets her alarms in the session she calls from, timed on her clock', async () => {
    const ctx = await setupCore({ clock: { speed: 60, start: '2026-11-10T10:00' } })
    provideSessions(ctx, { self, 'other-self': self })
    const tasks: { id: string; title: string; prompt: string; status: string; target: { kind: string; sessionId: string }; after: number }[] = []
    ctx.provide('schedule')
    ctx.set('schedule', {
      create: async (request: { title: string; prompt: string; timing: { after_seconds: number }; target: { kind: string; sessionId: string } }) => {
        const task = { id: `s${tasks.length + 1}`, title: request.title, prompt: request.prompt, status: 'active', target: request.target, after: request.timing.after_seconds }
        tasks.push(task)
        return task
      },
      list: async () => ({ items: tasks }),
      edit: async (request: { id: string }) => { tasks.find(task => task.id === request.id)!.status = 'ended'; return { deleted: true } },
    })
    const set = await callAs(ctx, 'self', 'alarm_set', { at: '11:00', note: 'call mum' })
    expect(set.isError).toBe(false)
    // One hour on her clock at 60x speed is one real minute.
    expect(tasks[0]).toMatchObject({ target: { kind: 'session', sessionId: 'self' }, prompt: 'call mum', after: 60 })
    expect(textOf(await callAs(ctx, 'self', 'alarm_list'))).toMatch(/^s1: 2026-11-10 11:00 — call mum$/)
    expect(textOf(await callAs(ctx, 'other-self', 'alarm_list'))).toBe('没有闹钟。')
    expect(textOf(await callAs(ctx, 'other-self', 'alarm_cancel', { id: 's1' }))).toMatch(/anima\/unknown-alarm/)
    expect((await callAs(ctx, 'self', 'alarm_cancel', { id: 's1' })).isError).toBe(false)
    expect(tasks[0]!.status).toBe('ended')
  })

  it('runs her goal tools; she may close a goal the owner set without a reason', async () => {
    const ctx = await setupCore()
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { self })
    ctx.anima.goals.add({ text: 'ask about the exam', owner: 'owner', now: T })
    expect(textOf(await callAs(ctx, 'self', 'goals_add', { text: 'tidy my notes' }))).toBe('g2 [yours] tidy my notes')
    expect(textOf(await callAs(ctx, 'self', 'goals_close', { id: 'g1', status: 'done' }))).toContain('done')
  })

  it('lists her body in status lines', async () => {
    const ctx = await setupCore()
    ctx.anima.setClock(() => T)
    const lines = ctx.anima.statusLines().join('\n')
    expect(lines).toContain('Clock: 2026-11-10 10:00 (real time); phase day, mode day')
    expect(lines).toContain('needs, highest first:')
  })
})
