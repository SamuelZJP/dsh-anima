import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as animaCore from '../src/index.ts'
import { SelfModelStore } from '../src/index.ts'
import * as persona from '../src/persona.ts'
import { callAs, fakeAgent, provideSessions, registerEcho, setupCore, tempDataDir, textOf } from './helpers.ts'

const options = { digestChars: 60 }
const waking = { kind: 'waking' as const, current: true }

function store(dir = tempDataDir()) {
  return new SelfModelStore(join(dir, 'self-model.json'), join(dir, 'self-model-log.jsonl'), options)
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

  it('keeps any number of notes of any length; refuses only an empty add and an unknown id', () => {
    const s = store()
    s.note({ section: 'other', text: 'x'.repeat(500), reason: 'r', at: 1, real: 1 })
    for (let i = 0; i < 60; i++) s.note({ section: 'other', text: `note ${i}`, reason: 'r', at: i, real: i })
    expect(s.entries()).toHaveLength(61)
    expect(() => s.note({ section: 'other', text: ' ', reason: 'r', at: 9, real: 9 })).toThrow(/anima\/self-model-text/)
    expect(() => s.note({ section: 'other', replaces: 'n999', reason: 'r', at: 9, real: 9 })).toThrow(/anima\/self-model-unknown/)
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
    expect(full).not.toMatch(/always wins/)
    const short = s.digest(false)
    expect(short).not.toContain('[n')
    // Newest first, cut at digestChars (60): the newer taste fits, then the budget runs out.
    expect(short).toContain('Newer taste note')
    expect(short).not.toContain('Long opinion')
  })
})

describe('self_note behavior', () => {
  it('takes every change she makes: nothing inside limits how often', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'self-1': waking })
    for (let i = 1; i <= 5; i++) {
      const result = await callAs(ctx, 'self-1', 'self_note', { section: 'tastes', text: `taste ${i}`, reason: 'noticed' })
      expect(result.isError).toBe(false)
      expect(textOf(result)).toMatch(new RegExp(`d${i}: added n${i}`))
    }
    expect(ctx.anima.selfModel.entries()).toHaveLength(5)
    expect(ctx.anima.selfModel.diffs()[0]).toMatchObject({ sessionId: 'self-1', by: 'her' })
  })

  it('is offered awake and in sleep\'s consolidation, and nowhere else', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { 'w-1': waking, 'cons-1': { kind: 'consolidation' } })
    expect((await callAs(ctx, 'w-1', 'self_note', { section: 'other', text: 'x', reason: 'y' })).isError).toBe(false)
    expect((await callAs(ctx, 'cons-1', 'self_note', { section: 'habits', text: 'Quiet mornings.', reason: 'from the day' })).isError).toBe(false)
    expect(textOf(await callAs(ctx, 'plain-dsh', 'self_note', { section: 'other', text: 'x', reason: 'y' }))).toMatch(/Error/)
  })

  it('unregisters self_note when the plugin is disposed', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const fiber = await ctx.plugin(animaCore, { dataDir: tempDataDir() })
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
    await ctx.plugin(animaCore, { dataDir: tempDataDir() })
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

  it('shows her waking self and sleep\'s consolidation every note with its id, live', async () => {
    const ctx = await setup()
    const captured = capture()
    await (await agentScope(ctx, 'anima-w-z')).scope.ctx.plugin(persona, { kind: 'waking' })
    await (await agentScope(ctx, 'anima-m-z')).scope.ctx.plugin(persona, { kind: 'consolidation' })
    expect(captured.contexts.filter(c => c.name === persona.SELF_MODEL_CONTEXT)).toHaveLength(2)
    expect(digestOf(captured, 0)).toMatch(/No notes yet/)
    ctx.anima.selfModel.note({ section: 'tastes', text: 'Green tea over coffee.', reason: 'r', at: 1, real: 1 })
    expect(digestOf(captured, 0)).toContain('[n1] Green tea over coffee.')
    expect(digestOf(captured, 1)).toContain('[n1] Green tea over coffee.')
  })

  it('applies a saved constitution to running sessions and keeps a backup', async () => {
    const ctx = await setup()
    const captured = capture()
    await (await agentScope(ctx, 'anima-w-k')).scope.ctx.plugin(persona, { kind: 'waking' })
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
