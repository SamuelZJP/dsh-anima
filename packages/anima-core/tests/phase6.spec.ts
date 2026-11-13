import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as animaCore from '../src/index.ts'
import { ActivityLog, SelfModelStore, summarize, emptyDay } from '../src/index.ts'
import * as persona from '../src/persona.ts'
import { callAs, fakeAgent, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const limits = { maxEntries: 3, maxEntryChars: 40, digestChars: 60 }
const self = { kind: 'self' as const }
const localChat = {
  kind: 'conversation' as const,
  channel: { platform: 'local', account: 'owner', kind: 'private', id: 'owner' },
  channelKey: 'local:owner:private:owner',
}

function store(dir = tempDataDir()) {
  return new SelfModelStore(join(dir, 'self-model.json'), join(dir, 'self-model-log.jsonl'), limits)
}

function invoke(ctx: Context, rawInput: string) {
  const invocation = { rawInput, agent: fakeAgent('any'), attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
  return ctx.anima.dispatchCommand(invocation)
}

describe('self-model store', () => {
  it('adds, changes and removes notes, logging each as a diff', () => {
    const dir = tempDataDir()
    const s = store(dir)
    const add = s.note({ section: 'tastes', text: 'I like rainy days.', reason: 'it rained', at: 1, real: 1 })
    expect(add).toMatchObject({ id: 'd1', op: 'add', entryId: 'n1', by: 'her', after: 'I like rainy days.' })
    const change = s.note({ section: 'tastes', text: 'I love rainy days.', replaces: 'n1', reason: 'more than I thought', at: 2, real: 2 })
    expect(change).toMatchObject({ id: 'd2', op: 'change', before: 'I like rainy days.', after: 'I love rainy days.' })
    const remove = s.note({ section: 'tastes', replaces: 'n1', reason: 'not true', at: 3, real: 3 })
    expect(remove).toMatchObject({ id: 'd3', op: 'remove', before: 'I love rainy days.' })
    expect(s.entries()).toEqual([])
    // A fresh store reads the same files.
    expect(store(dir).diffs().map(d => d.id)).toEqual(['d1', 'd2', 'd3'])
    expect(readFileSync(join(dir, 'self-model-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('refuses long text, a full model and unknown ids', () => {
    const s = store()
    expect(() => s.note({ section: 'other', text: 'x'.repeat(41), reason: 'r', at: 1, real: 1 })).toThrow(/anima\/self-model-text/)
    for (let i = 0; i < 3; i++) s.note({ section: 'other', text: `note ${i}`, reason: 'r', at: i, real: i })
    expect(() => s.note({ section: 'other', text: 'one more', reason: 'r', at: 9, real: 9 })).toThrow(/anima\/self-model-full/)
    expect(() => s.note({ section: 'other', replaces: 'n99', reason: 'r', at: 9, real: 9 })).toThrow(/anima\/self-model-unknown/)
  })

  it('reverts an add, a change and a remove, and refuses a stale revert', () => {
    const s = store()
    s.note({ section: 'habits', text: 'I hum when I read.', reason: 'noticed', at: 1, real: 1 }) // d1 add n1
    s.note({ section: 'habits', text: 'I hum when I write.', replaces: 'n1', reason: 'actually', at: 2, real: 2 }) // d2 change
    expect(() => s.revert('d1', 'no', 3, 3)).toThrow(/anima\/self-model-conflict.*d2/)
    expect(s.revert('d2', 'too soon', 3, 3)).toMatchObject({ op: 'revert', by: 'owner', revertOf: 'd2', after: 'I hum when I read.' })
    expect(s.entries()[0]!.text).toBe('I hum when I read.')
    s.note({ section: 'habits', replaces: 'n1', reason: 'gone', at: 4, real: 4 }) // d4 remove
    expect(s.revert('d4', 'keep it', 5, 5)).toMatchObject({ after: 'I hum when I read.' })
    expect(s.entries().map(e => e.id)).toEqual(['n1'])
    s.note({ section: 'opinions', text: 'Cats are wise.', reason: 'a cat', at: 6, real: 6 }) // d6 add n2
    s.revert('d6', 'not hers', 7, 7)
    expect(s.entries().map(e => e.id)).toEqual(['n1'])
    expect(() => s.revert('d42', 'x', 8, 8)).toThrow(/anima\/self-model-unknown/)
  })

  it('gives Self every note with ids and conversations a short digest', () => {
    const s = store()
    expect(s.digest(false)).toBe('')
    expect(s.digest(true)).toMatch(/No notes yet/)
    s.note({ section: 'tastes', text: 'Old taste note here', reason: 'r', at: 1, real: 1 })
    s.note({ section: 'tastes', text: 'Newer taste note', reason: 'r', at: 2, real: 2 })
    s.note({ section: 'opinions', text: 'Long opinion that will not fit', reason: 'r', at: 3, real: 3 })
    const full = s.digest(true)
    expect(full).toContain('[n1] Old taste note here')
    expect(full).toContain('[n3] Long opinion')
    expect(full).toMatch(/constitution above always wins/)
    const short = s.digest(false)
    expect(short).not.toContain('[n')
    // Newest first, cut at digestChars (60): the newer taste fits, then the budget runs out.
    expect(short).toContain('Newer taste note')
    expect(short).not.toContain('Long opinion')
  })
})

describe('self_note behavior and its daily cap', () => {
  it('changes the self-model and is refused over the default 3 per day', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'self-1': self })
    for (let i = 1; i <= 3; i++) {
      const result = await callAs(ctx, 'self-1', 'self_note', { section: 'tastes', text: `taste ${i}`, reason: 'noticed' })
      expect(result.isError).toBe(false)
      expect(textOf(result)).toMatch(new RegExp(`d${i}: added n${i}`))
    }
    const fourth = await callAs(ctx, 'self-1', 'self_note', { section: 'tastes', text: 'taste 4', reason: 'noticed' })
    expect(fourth.isError).toBe(true)
    expect(textOf(fourth)).toMatch(/^Error: anima\/over-quota: .*self_note/)
    expect(ctx.anima.selfModel.entries()).toHaveLength(3)
    expect(ctx.anima.selfModel.diffs()[0]).toMatchObject({ sessionId: 'self-1', by: 'her' })
  })

  it('is offered in Self, conversations and consolidation only', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'self-1': self, 'chat-1': localChat, 'triage-1': { kind: 'triage' }, 'cons-1': { kind: 'consolidation' } })
    expect((await callAs(ctx, 'chat-1', 'self_note', { section: 'other', text: 'x', reason: 'y' })).isError).toBe(false)
    expect((await callAs(ctx, 'cons-1', 'self_note', { section: 'habits', text: 'Quiet mornings.', reason: 'from the day' })).isError).toBe(false)
    expect(textOf(await callAs(ctx, 'triage-1', 'self_note', { section: 'other', text: 'x', reason: 'y' }))).toMatch(/Error/)
  })

  it('unregisters self_note when the plugin is disposed', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const fiber = await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir: tempDataDir() })
    expect(ctx.tools.get('self_note')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('self_note')).toBeUndefined()
  })

  it('states her self-model in one report line', async () => {
    const ctx = await setupCore()
    expect(ctx.anima.selfModelReportLine()).toMatch(/^Your self-model: no notes yet\. self_note keeps/)
    ctx.anima.selfModel.note({ section: 'habits', text: 'Quiet mornings.', reason: 'r', at: ctx.anima.clock.now(), real: 1 })
    expect(ctx.anima.selfModelReportLine()).toMatch(/^Your self-model: 1 note, last changed 2026-11-10 10:00\./)
  })

  it('lists and reverts through /anima selfmodel, logged as an owner command', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'self-1': self })
    await callAs(ctx, 'self-1', 'self_note', { section: 'opinions', text: 'Mornings are best.', reason: 'sunrise' })
    const list = await invoke(ctx, ' selfmodel')
    expect(list).toMatchObject({ kind: 'success' })
    expect((list as { text: string }).text).toMatch(/n1 \[opinions\] Mornings are best\.[\s\S]*d1: added n1/)
    expect(await invoke(ctx, ' selfmodel revert d1 not her')).toMatchObject({ kind: 'success', text: expect.stringMatching(/Reverted: d2: reverted d1/) })
    expect(ctx.anima.selfModel.entries()).toEqual([])
    const owner = ctx.anima.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'owner')
    expect(owner).toEqual([expect.objectContaining({ action: 'selfmodel.revert', source: 'command', ok: true, args: { id: 'd1', reason: 'not her' } })])
  })
})

async function agentScope(ctx: Context, id: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: id as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt', 'anima'] }))
  return { scope, key }
}

describe('persona: self-model digest and live constitution', () => {
  async function setup() {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir: tempDataDir() })
    return ctx
  }
  // Prompt assembly needs a tool executor this test composition does not load,
  // so the test reads what persona registers (sections and context providers).
  function capture() {
    const contexts: { name: string; text: unknown }[] = []
    const sections: { name: string; text: string }[] = []
    const ctxSpy = vi.spyOn(SystemPrompt.prototype, 'context').mockImplementation(function (this: unknown, c) {
      contexts.push(c as { name: string; text: unknown })
      return () => {}
    })
    const secSpy = vi.spyOn(SystemPrompt.prototype, 'section').mockImplementation(function (this: unknown, sec) {
      const { text } = sec as { name: string; text: string | ((context: object) => string) }
      sections.push({ ...sec as { name: string }, text: typeof text === 'function' ? text({}) : text })
      return () => {}
    })
    onTestFinished(() => { ctxSpy.mockRestore(); secSpy.mockRestore() })
    return { contexts, sections }
  }
  const digestOf = (captured: { contexts: { name: string; text: unknown }[] }, index: number) => {
    const entry = captured.contexts.filter(c => c.name === persona.SELF_MODEL_CONTEXT)[index]
    return entry === undefined ? undefined : (entry.text as (c: object) => string)({})
  }

  it('shows Self the full self-model and a conversation the short digest, live', async () => {
    const ctx = await setup()
    const captured = capture()
    await (await agentScope(ctx, 'anima-self-z')).scope.ctx.plugin(persona, { kind: 'self' })
    await (await agentScope(ctx, 'anima-c-z')).scope.ctx.plugin(persona, { kind: 'conversation' })
    await (await agentScope(ctx, 'anima-t-z')).scope.ctx.plugin(persona, { kind: 'triage' })
    await (await agentScope(ctx, 'anima-m-z')).scope.ctx.plugin(persona, { kind: 'consolidation' })
    // Self, conversation and consolidation register a digest; triage does not.
    expect(captured.contexts.filter(c => c.name === persona.SELF_MODEL_CONTEXT)).toHaveLength(3)
    expect(digestOf(captured, 2)).toMatch(/No notes yet/)
    expect(digestOf(captured, 0)).toMatch(/No notes yet/)
    expect(digestOf(captured, 1)).toBe('')
    ctx.anima.selfModel.note({ section: 'tastes', text: 'Green tea over coffee.', reason: 'r', at: 1, real: 1 })
    expect(digestOf(captured, 0)).toContain('[n1] Green tea over coffee.')
    expect(digestOf(captured, 1)).toContain('- Green tea over coffee.')
  })

  it('applies a saved constitution to running sessions and keeps a backup', async () => {
    const ctx = await setup()
    const captured = capture()
    await (await agentScope(ctx, 'anima-self-k')).scope.ctx.plugin(persona, { kind: 'self' })
    const prefixes = () => captured.sections.filter(sec => sec.text.length > 0).map(sec => sec.text)
    expect(prefixes().at(-1)).toContain('You are Anima')
    const before = ctx.anima.constitution()
    expect(ctx.anima.saveConstitution('# Mira\nYou are Mira, who loves the sea.')).toEqual({ chars: 40 })
    expect(prefixes().at(-1)).toContain('You are Mira, who loves the sea.')
    expect(readFileSync(join(ctx.anima.config.dataDir, 'constitution.md.bak'), 'utf8')).toBe(before)
    expect(() => ctx.anima.saveConstitution('  \n')).toThrow(/anima\/constitution-empty/)
    expect(ctx.anima.constitution()).toContain('Mira')
  })
})

describe('owner surface and activity log', () => {
  it('records gate decisions with codes, and summarizes the day', async () => {
    const ctx = await setupCore({ quotas: [{ effect: 'express', per: 'channel', limit: 1, windowMinutes: 10 }] })
    provideSessions(ctx, { 'chat-1': localChat })
    registerEcho(ctx, 'local_say', { platform: 'local', effect: 'express', sessions: ['conversation'] })
    await callAs(ctx, 'chat-1', 'local_say')
    await callAs(ctx, 'chat-1', 'local_say')
    ctx.anima.recordActivity({ type: 'wake', stimulus: 'message', session: 'conversation', sessionId: 'chat-1' })
    const day = ctx.anima.dayKey()
    const gates = ctx.anima.activity.read(day).filter(r => r.type === 'gate')
    expect(gates).toEqual([
      expect.objectContaining({ behavior: 'local_say', decision: 'allowed', session: 'conversation', sessionId: 'chat-1' }),
      expect.objectContaining({ behavior: 'local_say', decision: 'refused', code: 'anima/over-quota' }),
    ])
    const summary = ctx.anima.daySummary(day)
    expect(summary).toMatchObject({ calls: { allowed: 1, refused: 1 }, refusals: [{ code: 'anima/over-quota', count: 1 }], wakes: { total: 1, bySession: { conversation: 1 } } })
    const view = await ctx.anima.ownerView('activity', {}) as { day: string; days: string[]; records: unknown[] }
    expect(view.days).toEqual([day])
    expect(view.records).toHaveLength(3)
  })

  it('runs the same action for a command and the page, logging each source', async () => {
    const ctx = await setupCore()
    expect(await invoke(ctx, ' pause')).toMatchObject({ kind: 'success' })
    expect(ctx.anima.paused).toBe(true)
    await ctx.anima.ownerAction('resume', {}, 'page')
    expect(ctx.anima.paused).toBe(false)
    await ctx.anima.ownerAction('goal.add', { text: 'Call mum', due: '2026-11-11 09:00' }, 'page')
    await expect(ctx.anima.ownerAction('goal.add', { text: '' }, 'page')).rejects.toThrow(/anima\/bad-args/)
    await expect(ctx.anima.ownerAction('nope', {}, 'page')).rejects.toThrow(/anima\/unknown-action/)
    const owner = ctx.anima.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'owner')
    expect(owner.map(r => [r.action, r.source, r.ok])).toEqual([
      ['pause', 'command', true], ['resume', 'page', true], ['goal.add', 'page', true], ['goal.add', 'page', false], ['nope', 'page', false],
    ])
    const goals = await ctx.anima.ownerView('goals') as { goals: { text: string; owner: string }[] }
    expect(goals.goals).toEqual([expect.objectContaining({ text: 'Call mum', owner: 'owner' })])
    expect(await invoke(ctx, ' goal list')).toMatchObject({ text: expect.stringContaining('Call mum') })
  })

  it('serves structured status and platform views', async () => {
    const ctx = await setupCore()
    ctx.anima.addStatusPart('life', () => ({ nextHeartbeat: '2026-11-10 11:00' }))
    ctx.anima.providePlatform({
      platform: 'qq', title: 'QQ', view: () => ({ health: 'ok', summary: 'connected', details: { account: '1' } }),
      actions: { ping: () => ({ pong: true }) },
    })
    const status = await ctx.anima.ownerView('status') as Record<string, unknown>
    expect(status).toMatchObject({ paused: false, clock: { day: '2026-11-10', mode: 'day' }, parts: { life: { nextHeartbeat: '2026-11-10 11:00' } } })
    expect(await ctx.anima.ownerView('platforms')).toEqual([{ platform: 'qq', title: 'QQ', view: { health: 'ok', summary: 'connected', details: { account: '1' } } }])
    expect(await ctx.anima.ownerAction('qq.ping', {}, 'page')).toEqual({ pong: true })
    await expect(ctx.anima.ownerView('nope')).rejects.toThrow(/anima\/unknown-view/)
  })

  it('answers approvals from the page', async () => {
    const ctx = await setupCore()
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test line', send: async (text) => { sent.push(text) } })
    const pending = ctx.anima.requestApproval('She wants to call x.')
    await Promise.resolve()
    const view = await ctx.anima.ownerView('approvals') as { pending: { id: string }[] }
    expect(view.pending).toHaveLength(1)
    expect(await ctx.anima.ownerAction('approve', { id: view.pending[0]!.id }, 'page')).toEqual({ answered: true })
    expect(await pending).toBe('approved')
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
    const summary = summarize('2026-11-11', log.read('2026-11-11'), { ...emptyDay(), tokens: { day: 10, night: 0 } })
    expect(summary).toMatchObject({ calls: { refused: 1 }, refusals: [{ code: 'anima/quiet-hours', count: 1 }], tokens: { day: 10 } })
  })
})
