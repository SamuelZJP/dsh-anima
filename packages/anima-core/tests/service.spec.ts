import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as animaCore from '../src/index.ts'
import { personaText, SESSION_RULES } from '../src/persona.ts'
import { callAs, fakeAgent, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const localChat = {
  kind: 'conversation' as const,
  channel: { platform: 'local', account: 'owner', kind: 'private', id: 'owner' },
  channelKey: 'local:owner:private:owner',
}
const say = { platform: 'local', effect: 'express' as const, sessions: ['conversation' as const] }

function invoke(ctx: Context, rawInput: string) {
  const invocation = { rawInput, agent: fakeAgent('any'), attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
  return ctx.anima.dispatchCommand(invocation)
}

describe('policy gate on tools/pre-execute', () => {
  it('allows a fitting call, then refuses over quota with code and hint', async () => {
    const ctx = await setupCore({ quotas: [{ effect: 'express', per: 'channel', limit: 2, windowMinutes: 10 }] })
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    const third = await callAs(ctx, 'chat-1', 'local_say')
    expect(third.isError).toBe(true)
    expect(textOf(third)).toMatch(/^Error: anima\/over-quota: limit of 2 per 10 min in this channel reached for local_say/)
  })

  it('hides behaviors outside Anima sessions', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    for (const [sessionId, visible] of [['plain', false], ['chat-1', true]] as const) {
      const agent = fakeAgent(sessionId)
      const resolved = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal: new AbortController().signal })
      expect(resolved.view(agent).has('local_say')).toBe(visible)
      resolved.dispose()
    }
  })

  it('refuses everything while paused and recovers on resume', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    await invoke(ctx, 'pause')
    const refused = await callAs(ctx, 'chat-1', 'local_say')
    expect(textOf(refused)).toMatch(/^Error: anima\/paused: /)
    await invoke(ctx, ' resume ')
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
  })

  it('leaves non-Anima tools alone', async () => {
    const ctx = await setupCore()
    await invoke(ctx, 'pause')
    expect((await callAs(ctx, 'plain', animaCore.PING_TOOL)).isError).toBe(false)
  })
})

describe('behavior registry', () => {
  it('rejects names without the platform prefix', async () => {
    const ctx = await setupCore()
    expect(() => registerEcho(ctx, 'say', say)).toThrow(/anima\/behavior-name/)
  })

  it('removes the tool and its metadata when the owner plugin unloads', async () => {
    const ctx = await setupCore()
    const fiber = await ctx.plugin({ name: 'owner', inject: ['anima'], apply: (child: Context) => registerEcho(child, 'local_say', say) })
    expect(ctx.tools.get('local_say')).toBeDefined()
    expect(ctx.anima.behavior('local_say')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('local_say')).toBeUndefined()
    expect(ctx.anima.behavior('local_say')).toBeUndefined()
  })
})

describe('/anima subcommands', () => {
  it('lists help and refuses unknown names', async () => {
    const ctx = await setupCore()
    expect((await invoke(ctx, '')).text).toContain('/anima status')
    expect(await invoke(ctx, 'bogus')).toMatchObject({ kind: 'error' })
  })

  it('reports status with plugin-provided lines', async () => {
    const ctx = await setupCore()
    ctx.anima.addStatus(() => ['Self session: x'])
    const status = (await invoke(ctx, 'status')).text ?? ''
    expect(status).toContain('Paused: no')
    expect(status).toContain('Self session: x')
    expect(status).toContain('express: 30 per hour per channel')
  })

  it('drops a subcommand with its plugin', async () => {
    const ctx = await setupCore()
    const fiber = await ctx.plugin({ name: 'owner', inject: ['anima'], apply: (child: Context) => {
      child.anima.addSubcommand({ name: 'chat', usage: 'chat', run: () => ({ kind: 'success', text: 'hi' }) })
    } })
    expect((await invoke(ctx, 'chat x')).text).toBe('hi')
    await fiber.dispose()
    expect(ctx.anima.hasSubcommand('chat')).toBe(false)
  })

  it('turns a throwing subcommand into an error result', async () => {
    const ctx = await setupCore()
    ctx.anima.addSubcommand({ name: 'boom', usage: 'boom', run: () => { throw new Error('nope') } })
    expect(await invoke(ctx, 'boom')).toEqual({ kind: 'error', text: 'nope' })
  })
})

describe('config and constitution', () => {
  it('fails loud on invalid config', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    expect(() => animaCore.resolveConfig({ characterId: 'Bad Id' })).toThrow(/anima\/config-invalid/)
    expect(() => animaCore.resolveConfig({ quotas: [{ per: 'global', limit: 1.5, windowMinutes: 1 }] })).toThrow(/anima\/config-invalid/)
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
    expect(text.startsWith('You are Rin.\n\n## How this conversation works')).toBe(true)
    expect(text).toContain('private thought')
    expect(personaText('X', 'self')).toContain(SESSION_RULES.self)
  })
})

describe('Phase 2 core service', () => {
  const self = { kind: 'self' as const }
  const T = new Date('2026-11-10T10:00').getTime()

  it('counts billable tokens of Anima sessions and refuses work past the budget', async () => {
    const ctx = await setupCore({ modes: { day: { tokenBudget: 1000 } } } as never)
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { 'chat-1': localChat, self })
    registerEcho(ctx, 'local_say', say)
    const usage = (sessionId: string, inputTokens: number) => ctx.emit('session/event' as never, { id: sessionId } as never, { type: 'assistant/message', data: { usage: { inputTokens, outputTokens: 0, cacheReadTokens: 50_000 } } } as never)
    usage('plain', 5000)
    expect(ctx.anima.todayLedger().tokens.day).toBe(0)
    usage('chat-1', 600)
    expect((await callAs(ctx, 'chat-1', 'local_say')).isError).toBe(false)
    usage('self', 400)
    expect(ctx.anima.todayLedger().tokens.day).toBe(1000)
    expect(textOf(await callAs(ctx, 'chat-1', 'local_say'))).toMatch(/^Error: anima\/over-budget: /)
  })

  it('counts initiates and refuses past the daily limit', async () => {
    const ctx = await setupCore({ initiate: { perDay: 1, consent: { channels: ['local:owner:private:owner'] } } } as never)
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { self })
    ctx.anima.provideChannels(key => key === 'local:owner:private:owner' ? { isOwner: true } : undefined, () => ['local:owner:private:owner'])
    registerEcho(ctx, 'open_conversation', { effect: 'initiate', sessions: ['self'], target: args => args.text as string })
    expect((await callAs(ctx, 'self', 'open_conversation', { text: 'local:owner:private:owner' })).isError).toBe(false)
    expect(ctx.anima.todayLedger().initiates).toBe(1)
    expect(textOf(await callAs(ctx, 'self', 'open_conversation', { text: 'local:owner:private:owner' }))).toMatch(/^Error: anima\/over-quota: you already started 1 of 1/)
  })

  it('asks the channel resolver for owner consent', async () => {
    const ctx = await setupCore()
    ctx.anima.provideChannels(key => key === 'local:owner:private:owner' ? { isOwner: true } : { isOwner: false })
    expect(ctx.anima.mayInitiate('local:owner:private:owner')).toBe(true)
    expect(ctx.anima.mayInitiate('local:owner:private:friend')).toBe(false)
  })

  it('applies satisfied needs when a behavior succeeds and persists state', async () => {
    const dataDir = tempDataDir()
    const ctx = await setupCore({ dataDir })
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', say)
    const before = ctx.anima.selfState().needs.connect!
    await callAs(ctx, 'chat-1', 'local_say')
    expect(ctx.anima.selfState().needs.connect).toBeCloseTo(Math.max(0, before - 0.3))
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).self.needs.connect).toBeCloseTo(Math.max(0, before - 0.3))
  })

  it('refuses schedule targets other than this_session', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { self })
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    ctx.tools.register(defineTool({
      name: 'schedule_create', description: 'fake', parameters: { target: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { return { ok: true } },
    }))
    expect(textOf(await callAs(ctx, 'self', 'schedule_create', { target: 'new' }))).toMatch(/^Error: anima\/not-allowed: /)
    expect((await callAs(ctx, 'self', 'schedule_create', { target: 'this_session' })).isError).toBe(false)
  })

  it('runs her goal tools and the owner goal command', async () => {
    const ctx = await setupCore()
    ctx.anima.setClock(() => T)
    provideSessions(ctx, { self })
    expect((await invoke(ctx, 'goal add ask about the exam due 2026-11-10 21:00')).text).toMatch(/^Added g1 \[owner\] ask about the exam \(due 2026-11-10 21:00\)/)
    expect(textOf(await callAs(ctx, 'self', 'goals_add', { text: 'tidy my notes' }))).toBe('g2 [yours] tidy my notes')
    expect(textOf(await callAs(ctx, 'self', 'goals_close', { id: 'g1', status: 'done' }))).toMatch(/anima\/reason-required/)
    expect(textOf(await callAs(ctx, 'self', 'goals_close', { id: 'g1', status: 'done', reason: 'asked' }))).toContain('done: asked')
    expect((await invoke(ctx, 'goal list')).text).toContain('g2 [yours] tidy my notes')
    expect(await invoke(ctx, 'goal close')).toMatchObject({ kind: 'error' })
  })

  it('shows clock, state and budgets in status', async () => {
    const ctx = await setupCore()
    ctx.anima.setClock(() => T)
    const status = (await invoke(ctx, 'status')).text ?? ''
    expect(status).toContain('Clock: 2026-11-10 10:00 (real time); phase day, mode day')
    expect(status).toContain('conversations you may still start today: 3 of 3')
    expect(status).toContain('needs, highest first:')
  })
})
