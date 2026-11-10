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
