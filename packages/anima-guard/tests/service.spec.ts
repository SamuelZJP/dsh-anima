import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as animaCore from '@anima/core'
import { resolveGuardConfig } from '../src/index.ts'
import { callAs, invoke, provideSessions, registerEcho, setupGuarded, setupGuardedFiber, textOf } from './helpers.ts'

const localChat = {
  kind: 'conversation' as const,
  channel: { platform: 'local', account: 'owner', kind: 'private', id: 'owner' },
  channelKey: 'local:owner:private:owner',
}
const say = { platform: 'local', effect: 'express' as const, sessions: ['conversation' as const] }
const self = { kind: 'self' as const }
const T = new Date('2026-11-10T10:00').getTime()

describe('guard gate on tools/pre-execute', () => {
  it('allows a fitting call, then refuses over quota as an owner rule', async () => {
    const ctx = await setupGuarded({ quotas: [{ effect: 'express', per: 'channel', limit: 2, windowMinutes: 10 }] })
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    const third = await callAs(ctx, 'chat-1', 'local_say')
    expect(third.isError).toBe(true)
    expect(textOf(third)).toMatch(/^Error: anima\/over-quota: （外面拦住了你，不是你自己的身体）主人定的限制：一个聊天里每 10 分钟最多说 2 次/)
  })

  it('refuses everything while paused and recovers on resume', async () => {
    const ctx = await setupGuarded()
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    await invoke(ctx, 'pause')
    expect(textOf(await callAs(ctx, 'chat-1', 'local_say'))).toMatch(/^Error: anima\/paused: /)
    await invoke(ctx, ' resume ')
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
  })

  it('leaves non-Anima tools alone', async () => {
    const ctx = await setupGuarded()
    await invoke(ctx, 'pause')
    expect((await callAs(ctx, 'plain', animaCore.PING_TOOL)).isError).toBe(false)
  })

  it('leaves what her body refuses to her body', async () => {
    const ctx = await setupGuarded({ quotas: [{ per: 'global', limit: 1, windowMinutes: 60 }] })
    provideSessions(ctx, { self })
    registerEcho(ctx, 'local_say', say)
    // A say in Self is the body's refusal, not the guard's, and it counts nothing.
    expect(textOf(await callAs(ctx, 'self', 'local_say'))).toMatch(/^Error: anima\/wrong-session: /)
    registerEcho(ctx, 'goals_x', { effect: 'internal', sessions: ['self'] })
    expect((await callAs(ctx, 'self', 'goals_x')).isError).toBe(false)
  })

  it('is gone when the guard unloads: no pause, no quota', async () => {
    const { ctx, fiber } = await setupGuardedFiber({ quotas: [{ effect: 'express', per: 'channel', limit: 1, windowMinutes: 10 }] })
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    await invoke(ctx, 'pause')
    await fiber.dispose()
    expect(ctx.get('animaGuard')).toBeUndefined()
    for (let i = 0; i < 3; i++) expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
  })
})

describe('/anima subcommands', () => {
  it('lists help and refuses unknown names', async () => {
    const ctx = await setupGuarded()
    expect((await invoke(ctx, '')).text).toContain('/anima status')
    expect(await invoke(ctx, 'bogus')).toMatchObject({ kind: 'error' })
  })

  it('reports status with plugin-provided lines', async () => {
    const ctx = await setupGuarded()
    ctx.anima.addStatus(() => ['Self session: x'])
    const status = (await invoke(ctx, 'status')).text ?? ''
    expect(status).toContain('Paused: no')
    expect(status).toContain('Self session: x')
    expect(status).toContain('express: 30 per hour per channel')
  })

  it('offers a platform\'s subcommands while it describes itself', async () => {
    const ctx = await setupGuarded()
    const fiber = await ctx.plugin({ name: 'owner', inject: ['anima'], apply: (child: Context) => {
      child.anima.providePlatform({ platform: 'local', title: 'Local', view: () => ({ health: 'ok', summary: '', details: {} }), subcommands: [{ name: 'chat', usage: 'chat', run: () => ({ kind: 'success', text: 'hi' }) }] })
    } })
    expect((await invoke(ctx, 'chat x')).text).toBe('hi')
    await fiber.dispose()
    expect(await invoke(ctx, 'chat x')).toMatchObject({ kind: 'error' })
  })

  it('turns a throwing subcommand into an error result', async () => {
    const ctx = await setupGuarded()
    ctx.animaGuard.addSubcommand({ name: 'boom', usage: 'boom', run: () => { throw new Error('nope') } })
    expect(await invoke(ctx, 'boom')).toEqual({ kind: 'error', text: 'nope' })
  })
})

describe('config', () => {
  it('fails loud on invalid config', () => {
    expect(() => resolveGuardConfig({ quotas: [{ per: 'global', limit: 1.5, windowMinutes: 1 }] })).toThrow(/anima\/config-invalid/)
  })

  it('has no default approval rule (the privacy reason for one is gone)', () => {
    expect(resolveGuardConfig({}).approve).toEqual([])
  })
})

describe('budgets and conversations she starts', () => {
  it('counts billable tokens of Anima sessions and refuses work past the budget', async () => {
    const ctx = await setupGuarded({ budget: { day: 1000, night: 20_000 } })
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { 'chat-1': localChat, self })
    registerEcho(ctx, 'local_say', say)
    const usage = (sessionId: string, inputTokens: number) => ctx.emit('session/event' as never, { id: sessionId } as never, { type: 'assistant/message', data: { usage: { inputTokens, outputTokens: 0, cacheReadTokens: 50_000 } } } as never)
    usage('plain', 5000)
    expect(ctx.animaGuard.todayCounts().tokens.day).toBe(0)
    usage('chat-1', 600)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    usage('self', 400)
    expect(ctx.animaGuard.todayCounts().tokens.day).toBe(1000)
    expect(textOf(await callAs(ctx, 'chat-1', 'local_say'))).toMatch(/^Error: anima\/over-budget: /)
    // Code-started turns are held too, until her next waking.
    expect(ctx.anima.admit({ kind: 'turn', purpose: 'heartbeat' })).toMatchObject({ code: 'anima/over-budget', untilWake: true })
  })

  it('counts conversations she starts and refuses past the daily limit', async () => {
    const ctx = await setupGuarded({ initiate: { perDay: 1, quietHours: [], consent: { owner: true, channels: ['local:owner:private:owner'] } } })
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { self })
    ctx.anima.provideChannels(key => key === 'local:owner:private:owner' ? { isOwner: true } : undefined, () => ['local:owner:private:owner'])
    registerEcho(ctx, 'open_conversation', { effect: 'initiate', sessions: ['self'], target: args => args.text as string })
    expect((await callAs(ctx, 'self', 'open_conversation', { text: 'local:owner:private:owner' })).isError).toBe(false)
    expect(ctx.animaGuard.todayCounts().initiates).toBe(1)
    expect(textOf(await callAs(ctx, 'self', 'open_conversation', { text: 'local:owner:private:owner' }))).toMatch(/^Error: anima\/over-quota: （外面拦住了你，不是你自己的身体）主人定的限制：每天最多主动找人聊 1 次/)
  })

  it('answers consent for her report through anima/admit', async () => {
    const ctx = await setupGuarded()
    ctx.anima.provideChannels(key => key === 'local:owner:private:owner' ? { isOwner: true } : { isOwner: false })
    expect(ctx.anima.admit({ kind: 'initiate', channelKey: 'local:owner:private:owner' })).toBeUndefined()
    expect(ctx.anima.admit({ kind: 'initiate', channelKey: 'local:owner:private:friend' })).toMatchObject({ code: 'anima/no-consent' })
  })

  it('runs the owner goal command; she may close an owner goal without a reason', async () => {
    const ctx = await setupGuarded()
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { self })
    expect((await invoke(ctx, 'goal add ask about the exam due 2026-11-10 21:00')).text).toMatch(/^Added g1 \[owner\] ask about the exam \(due 2026-11-10 21:00\)/)
    expect(textOf(await callAs(ctx, 'self', 'goals_add', { text: 'tidy my notes' }))).toBe('g2 [yours] tidy my notes')
    expect(textOf(await callAs(ctx, 'self', 'goals_close', { id: 'g1', status: 'done' }))).toContain('done')
    expect((await invoke(ctx, 'goal list')).text).toContain('g2 [yours] tidy my notes')
    expect(await invoke(ctx, 'goal close')).toMatchObject({ kind: 'error' })
  })

  it('shows clock, state and budgets in status', async () => {
    const ctx = await setupGuarded()
    ctx.anima.setClock(() => T)
    const status = (await invoke(ctx, 'status')).text ?? ''
    expect(status).toContain('Clock: 2026-11-10 10:00 (real time); phase day, mode day')
    expect(status).toContain('conversations you may still start today: 3 of 3')
    expect(status).toContain('needs, highest first:')
  })
})
