import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActivityLog, summarize } from '../src/index.ts'
import { callAs, invoke, provideSessions, registerEcho, setupGuarded, tempDataDir } from './helpers.ts'

const self = { kind: 'waking' as const, current: true }
const localChat = { kind: 'waking' as const, current: true }

describe('owner surface and activity log', () => {
  it('records gate decisions with codes, keeps her records, and summarizes the day', async () => {
    const ctx = await setupGuarded({ quotas: [{ effect: 'express', per: 'channel', limit: 1, windowMinutes: 10 }] })
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'demo_say', { platform: 'demo', effect: 'express', sessions: ['waking'] })
    await callAs(ctx, 'chat-1', 'demo_say')
    await callAs(ctx, 'chat-1', 'demo_say')
    // What the persona reports reaches the log through anima/record.
    ctx.anima.recordActivity({ type: 'wake', stimulus: 'message', session: 'waking', sessionId: 'chat-1' })
    const day = ctx.anima.dayKey()
    const gates = ctx.animaGuard.activity.read(day).filter(r => r.type === 'gate')
    expect(gates).toEqual([
      expect.objectContaining({ behavior: 'demo_say', decision: 'allowed', session: 'waking', sessionId: 'chat-1' }),
      expect.objectContaining({ behavior: 'demo_say', decision: 'refused', code: 'anima/over-quota' }),
    ])
    const summary = ctx.animaGuard.daySummary(day)
    expect(summary).toMatchObject({ calls: { allowed: 1, refused: 1 }, refusals: [{ code: 'anima/over-quota', count: 1 }], wakes: { total: 1, bySession: { waking: 1 } } })
    const view = await ctx.animaGuard.ownerView('activity', {}) as { day: string; days: string[]; records: unknown[] }
    expect(view.days).toEqual([day])
    expect(view.records).toHaveLength(3)
  })

  it('runs the same action for a command and the page, logging each source', async () => {
    const ctx = await setupGuarded()
    expect(await invoke(ctx, ' pause')).toMatchObject({ kind: 'success' })
    expect(ctx.animaGuard.paused).toBe(true)
    await ctx.animaGuard.ownerAction('resume', {}, 'page')
    expect(ctx.animaGuard.paused).toBe(false)
    await ctx.animaGuard.ownerAction('goal.add', { text: 'Call mum', due: '2026-11-11 09:00' }, 'page')
    await expect(ctx.animaGuard.ownerAction('goal.add', { text: '' }, 'page')).rejects.toThrow(/anima\/bad-args/)
    await expect(ctx.animaGuard.ownerAction('nope', {}, 'page')).rejects.toThrow(/anima\/unknown-action/)
    const owner = ctx.animaGuard.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'owner')
    expect(owner.map(r => [r.action, r.source, r.ok])).toEqual([
      ['pause', 'command', true], ['resume', 'page', true], ['goal.add', 'page', true], ['goal.add', 'page', false], ['nope', 'page', false],
    ])
    const goals = await ctx.animaGuard.ownerView('goals') as { goals: { text: string; owner: string }[] }
    expect(goals.goals).toEqual([expect.objectContaining({ text: 'Call mum', owner: 'owner' })])
    expect(await invoke(ctx, ' goal list')).toMatchObject({ text: expect.stringContaining('Call mum') })
  })

  it('serves structured status and platform views, with platform actions', async () => {
    const ctx = await setupGuarded()
    ctx.anima.addStatusPart('life', () => ({ nextHeartbeat: '2026-11-10 11:00' }))
    ctx.anima.providePlatform({
      platform: 'qq', title: 'QQ', view: () => ({ health: 'ok', summary: 'connected', details: { account: '1' } }),
      actions: { ping: () => ({ pong: true }) },
    })
    const status = await ctx.animaGuard.ownerView('status') as Record<string, unknown>
    expect(status).toMatchObject({ paused: false, clock: { day: '2026-11-10' }, budgets: { initiates: { used: 0, perDay: 3 } }, parts: { life: { nextHeartbeat: '2026-11-10 11:00' } } })
    expect(await ctx.animaGuard.ownerView('platforms')).toEqual([{ platform: 'qq', title: 'QQ', view: { health: 'ok', summary: 'connected', details: { account: '1' } } }])
    expect(await ctx.animaGuard.ownerAction('qq.ping', {}, 'page')).toEqual({ pong: true })
    expect(ctx.animaGuard.ownerNames().actions).toContain('qq.ping')
    await expect(ctx.animaGuard.ownerView('nope')).rejects.toThrow(/anima\/unknown-view/)
  })

  it('answers approvals from the page', async () => {
    const ctx = await setupGuarded()
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test line', send: async (text) => { sent.push(text) } })
    const pending = ctx.animaGuard.requestApproval('She wants to call x.')
    await Promise.resolve()
    const view = await ctx.animaGuard.ownerView('approvals') as { pending: { id: string }[] }
    expect(view.pending).toHaveLength(1)
    expect(await ctx.animaGuard.ownerAction('approve', { id: view.pending[0]!.id }, 'page')).toEqual({ answered: true })
    expect(await pending).toBe('approved')
  })

  it('lists and reverts her self-model through /anima selfmodel, logged as an owner command', async () => {
    const ctx = await setupGuarded()
    provideSessions(ctx, { 'self-1': self })
    await callAs(ctx, 'self-1', 'self_note', { section: 'opinions', text: 'Mornings are best.', reason: 'sunrise' })
    const list = await invoke(ctx, ' selfmodel')
    expect(list).toMatchObject({ kind: 'success' })
    expect((list as { text: string }).text).toMatch(/n1 \[opinions\] Mornings are best\.[\s\S]*d1: added n1/)
    expect(await invoke(ctx, ' selfmodel revert d1 not her')).toMatchObject({ kind: 'success', text: expect.stringMatching(/Reverted: d2: reverted d1/) })
    expect(ctx.anima.selfModel.entries()).toEqual([])
    const owner = ctx.animaGuard.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'owner')
    expect(owner).toEqual([expect.objectContaining({ action: 'selfmodel.revert', source: 'command', ok: true, args: { id: 'd1', reason: 'not her' } })])
  })

  it('consumes owner replies on the owner line, and only whole reply messages', async () => {
    const ctx = await setupGuarded()
    ctx.anima.provideOwnerLine({ name: 'test line', send: async () => {} })
    const pending = ctx.animaGuard.requestApproval('x')
    await Promise.resolve()
    expect(ctx.bail('anima/owner-message', 'hello there')).toBeUndefined()
    expect(ctx.bail('anima/owner-message', 'yes a1')).toBe('Allowed a1.')
    expect(await pending).toBe('approved')
    expect(ctx.bail('anima/owner-message', 'cancel o7')).toMatch(/No message o7/)
  })
})

describe('activity log file', () => {
  it('lists days, skips a torn line, and summarizes', () => {
    const dir = tempDataDir()
    const log = new ActivityLog(join(dir, 'activity'))
    expect(log.days()).toEqual([])
    log.append('2026-11-10', { type: 'gate', at: 1, real: 1, behavior: 'rest', decision: 'allowed' })
    log.append('2026-11-11', { type: 'gate', at: 2, real: 2, behavior: 'say', decision: 'refused', code: 'anima/quiet-hours' })
    expect(log.days()).toEqual(['2026-11-10', '2026-11-11'])
    expect(existsSync(join(dir, 'activity', '2026-11-10.jsonl'))).toBe(true)
    expect(log.read('../x')).toEqual([])
    const summary = summarize('2026-11-11', log.read('2026-11-11'), { tokens: { day: 10, night: 0 }, initiates: 0, nightWakes: 0 })
    expect(summary).toMatchObject({ calls: { refused: 1 }, refusals: [{ code: 'anima/quiet-hours', count: 1 }], tokens: { day: 10 } })
  })
})
