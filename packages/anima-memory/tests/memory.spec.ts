import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { AnimaLife, consolidationSessionId, conversationSessionId, selfSessionId, type PublishedChannel, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as memory from '../src/index.ts'
import { audienceOf, buildBlock, decayStep, EVERYONE, gistOf, learnScope, MemoryStore, narrow, resolveMemoryConfig, searchTerms } from '../src/index.ts'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-memory-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function openStore(): MemoryStore {
  const store = new MemoryStore(join(tempDir(), 'memory.db'))
  onTestFinished(() => store.close())
  return store
}

const NOW = new Date('2026-11-10T10:00').getTime()
const decay = resolveMemoryConfig({}).decay

describe('MemoryStore recall', () => {
  it('filters by audience', () => {
    const store = openStore()
    store.remember({ kind: 'fact', scope: 'private:test:alice', personId: 'test:alice', text: 'Alice is interviewing at Tencent next Friday.', now: NOW })
    expect(store.recall('Tencent interview', ['group:test:me:group:g', 'public'])).toEqual([])
    expect(store.recall('Tencent interview', ['private:test:alice', 'public']).map(m => m.text)).toEqual(['Alice is interviewing at Tencent next Friday.'])
    expect(store.recall('tencent', EVERYONE)).toHaveLength(1)
    expect(store.recall('Tencent', [])).toEqual([])
  })

  it('finds CJK terms of two characters and longer', () => {
    const store = openStore()
    store.remember({ kind: 'fact', scope: 'public', text: '小明喜欢爵士乐', now: NOW })
    expect(store.recall('小明', EVERYONE)).toHaveLength(1)
    expect(store.recall('爵士乐', EVERYONE)).toHaveLength(1)
    expect(store.recall('摇滚', EVERYONE)).toHaveLength(0)
    expect(searchTerms('Hi, my job! 小明 a')).toEqual(['job', '小明'])
  })

  it('keeps superseded memories as history, out of recall', () => {
    const store = openStore()
    const old = store.remember({ kind: 'fact', scope: 'owner', text: 'Sam lives in Beijing.', now: NOW })
    const fresh = store.remember({ kind: 'fact', scope: 'owner', text: 'Sam lives in Shanghai now.', now: NOW })
    store.supersede(old.id, fresh.id, NOW)
    expect(store.recall('Sam lives', EVERYONE).map(m => m.id)).toEqual([fresh.id])
    expect(store.get(old.id)).toMatchObject({ status: 'superseded', replacedBy: fresh.id })
    expect(store.forget(fresh.id)).toBe(true)
    expect(store.get(old.id)?.replacedBy).toBeUndefined()
    expect(store.get(fresh.id)).toBeUndefined()
  })

  it('claims pending transcript lines into segments per session and scope', () => {
    const store = openStore()
    store.record({ ts: NOW, sessionId: 'a', channelKey: 'k1', scope: 'private:x', dir: 'in', speaker: 'X', speakerId: 'x', text: 'hello' })
    store.record({ ts: NOW + 1, sessionId: 'b', channelKey: 'k2', scope: 'group:k2', dir: 'in', speaker: 'Y', text: 'hey all' })
    store.record({ ts: NOW + 2, sessionId: 'a', channelKey: 'k1', scope: 'private:x', dir: 'out', speaker: 'you', text: 'hi X' })
    expect(store.oldestPending()).toBe(NOW)
    const segments = store.claim('r1', 1000)
    expect(segments.map(s => [s.sessionId, s.lines.length])).toEqual([['a', 2], ['b', 1]])
    expect(store.pendingCount()).toBe(0)
    store.releaseRun('r1')
    expect(store.pendingCount()).toBe(3)
    store.claim('r2', 1000)
    expect(store.finishRun('r2')).toBe(3)
    expect(store.oldestPending()).toBeUndefined()
  })
})

describe('decay', () => {
  it('halves an episode over its half-life and leaves self memories alone', () => {
    const episode = decayStep({ kind: 'episode', strength: 1, importance: 0, recalls: 0, gisted: false }, decay.halfLifeDays, decay)
    expect(episode.strength).toBeCloseTo(0.5)
    const fact = decayStep({ kind: 'fact', strength: 1, importance: 0, recalls: 0, gisted: false }, decay.halfLifeDays, decay)
    expect(fact.strength).toBeGreaterThan(0.8)
    expect(decayStep({ kind: 'self', strength: 1, importance: 0, recalls: 0, gisted: false }, 100, decay).strength).toBe(1)
  })

  it('gists, then archives weak memories', () => {
    const store = openStore()
    const m = store.remember({ kind: 'episode', scope: 'public', importance: 0, text: 'We talked about jazz for an hour. Then about rain.', now: NOW })
    expect(store.decay(decay.halfLifeDays * 3, decay, NOW)).toEqual({ gisted: 1, archived: 0 })
    expect(store.get(m.id)?.text).toBe('We talked about jazz for an hour.')
    expect(store.decay(decay.halfLifeDays * 3, decay, NOW)).toEqual({ gisted: 0, archived: 1 })
    expect(store.recall('jazz', EVERYONE)).toEqual([])
    expect(store.recall('jazz', EVERYONE, { archive: true })).toHaveLength(1)
    expect(gistOf('x'.repeat(200), 20)).toHaveLength(20)
  })
})

describe('audience', () => {
  const channel = (kind: string, id: string) => ({ platform: 'test', account: 'me', kind, id })
  const conv = (kind: string, id: string) => ({ kind: 'conversation' as const, channel: channel(kind, id), channelKey: `test:me:${kind}:${id}` })
  const persons = [{ id: 'alice', accounts: ['test:alice', 'qq:123'] }]

  it('sets scopes from the session, never from the model', () => {
    expect(learnScope({ info: conv('private', 'alice'), isOwner: false }, [])).toBe('private:test:alice')
    expect(learnScope({ info: conv('private', 'alice'), isOwner: false }, persons)).toBe('private:alice')
    expect(learnScope({ info: conv('private', 'sam'), isOwner: true }, [])).toBe('owner')
    expect(learnScope({ info: conv('group', 'g'), isOwner: false }, [])).toBe('group:test:me:group:g')
    expect(learnScope({ info: { kind: 'self' }, isOwner: false }, [])).toBe('self')
    expect(learnScope({ info: { kind: 'triage' }, isOwner: false }, [])).toBeUndefined()
  })

  it('lets a conversation hear only its own scope and public; Self hears everything', () => {
    expect(audienceOf({ info: conv('group', 'g'), isOwner: false }, [])).toEqual(['group:test:me:group:g', 'public'])
    expect(audienceOf({ info: { kind: 'self' }, isOwner: false }, [])).toBe(EVERYONE)
    expect(audienceOf({ info: { kind: 'consolidation' }, isOwner: false }, [])).toEqual([])
    expect(audienceOf({ info: undefined, isOwner: false }, [])).toEqual([])
  })

  it('only narrows', () => {
    expect(narrow('group:x', 'self')).toBe('self')
    expect(narrow('group:x', 'here')).toBe('group:x')
    expect(narrow('group:x', undefined)).toBe('group:x')
  })

  it('rejects bad person config loudly', () => {
    expect(() => resolveMemoryConfig({ persons: [{ id: 'owner', accounts: [] }] })).toThrow(/anima\/config-invalid/)
    expect(() => resolveMemoryConfig({ persons: [{ id: 'a', accounts: ['x:1'] }, { id: 'b', accounts: ['x:1'] }] })).toThrow(/linked to both/)
  })
})

describe('buildBlock', () => {
  it('stays within the token budget and the audience', () => {
    const store = openStore()
    for (let i = 0; i < 20; i += 1) store.remember({ kind: 'fact', scope: 'private:p', personId: 'p', text: `P likes thing number ${i} quite a lot.`, now: NOW })
    store.remember({ kind: 'fact', scope: 'private:q', personId: 'p', text: 'Secret from Q about P.', now: NOW })
    const block = buildBlock({ store, audience: ['private:p', 'public'], person: 'p', query: 'secret', tokenBudget: 80, maxItems: 12 })!
    expect(block.text).not.toContain('Secret from Q')
    expect(block.ids.length).toBeGreaterThan(0)
    expect(block.ids.length).toBeLessThan(12)
    expect(buildBlock({ store, audience: ['group:z'], query: 'thing', tokenBudget: 800, maxItems: 12 })).toBeUndefined()
  })
})

// ---- the service, over core and life with a fake session host ----

class RecordingHost implements SessionHost {
  readonly delivered: { id: string; text: string }[] = []
  readonly injected: { id: string; text: string }[] = []
  readonly models: { id: string; model: string }[] = []
  readonly existing = new Set<string>()
  async resolve(id: string) { return this.existing.has(id) ? { id } : undefined }
  async create(id: string) { this.existing.add(id); return id }
  isArchived() { return false }
  rename() {}
  async deliver(agent: { id: string }, text: string) { this.delivered.push({ id: agent.id, text }) }
  async inject(agent: { id: string }, text: string) { this.injected.push({ id: agent.id, text }) }
  selectModel(agent: { id: string }, choice: { model: string }) { this.models.push({ id: agent.id, model: choice.model }) }
  isBusy() { return false }
}

const OWNER: PublishedChannel = { platform: 'test', account: 'me', kind: 'private', id: 'sam', display: 'Sam (test)', isOwner: true }
const ALICE: PublishedChannel = { platform: 'test', account: 'me', kind: 'private', id: 'alice', display: 'Alice (test)' }
const GROUP: PublishedChannel = { platform: 'test', account: 'me', kind: 'group', id: 'g', display: 'group g (test)' }
const sessionOf = (channel: PublishedChannel) => conversationSessionId('anima', `${channel.platform}:${channel.account}:${channel.kind}:${channel.id}`)

async function setup(config: Partial<memory.Config> = {}) {
  const dataDir = tempDir()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const host = new RecordingHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  ctx.animaLife.publish([OWNER, ALICE, GROUP])
  ctx.anima.registerBehavior(defineTool({
    name: 'test_say',
    description: 'say',
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute() { return { sent: true } },
  }), { platform: 'test', effect: 'express', sessions: ['conversation'] })
  const fiber = await ctx.plugin(memory, config)
  return { ctx, host, fiber, dataDir }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`c${++calls}`), name, arguments: args, agent, toolSet, signal })
    return { isError: result.isError, text: result.content.map(block => (block as { text?: string }).text ?? '').join('') }
  } finally {
    toolSet.dispose()
  }
}

function message(channel: PublishedChannel, name: string, text: string, extra: { isOwner?: boolean; addressed?: boolean } = {}) {
  return {
    type: 'message' as const, channel, text, ts: NOW,
    sender: { platformUserId: name.toLowerCase(), displayName: name, isOwner: extra.isOwner === true },
    ...extra.addressed === undefined ? {} : { addressed: extra.addressed },
  }
}

async function preStep(ctx: Context, sessionId: string, text: string): Promise<UserMessage[]> {
  const incoming = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const service = ctx.animaMemory as unknown as { preStep: (p: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> }
  const decision = await service.preStep({ agent: { id: sessionId }, messages: [incoming], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [incoming] }))
  return decision.kind === 'enter' ? decision.messages : []
}

describe('native DSH sessions (not hers)', () => {
  it('get nothing from Anima: no behavior, no recall, no record, no stimulus', async () => {
    const { ctx, host } = await setup()
    await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Alice likes rainy days.' })
    const records: unknown[] = []
    ctx.on('anima/record', record => { records.push(record) })
    const sent = host.delivered.length + host.injected.length
    const web = 'web-session-1'
    expect(ctx.anima.describeSession(web)).toBeUndefined()

    const agent = { id: web } as unknown as Agent
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal: new AbortController().signal })
    try {
      const view = toolSet.view(agent)
      expect(ctx.anima.behaviorNames().length).toBeGreaterThan(5)
      expect(ctx.anima.behaviorNames().filter(name => view.has(name))).toEqual([])
    } finally {
      toolSet.dispose()
    }
    expect(await preStep(ctx, web, 'what does Alice like? rainy days?')).toHaveLength(1)
    ctx.emit('session/event' as never, { id: web } as never, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } as never)
    ctx.emit('session/event' as never, { id: web } as never, { type: 'turn/end', data: { reason: 'done' } } as never)
    expect(records).toEqual([])
    expect(host.delivered.length + host.injected.length).toBe(sent)
  })
})

describe('AnimaMemory', () => {
  it('records inbound messages and outbound speech with the session scope', async () => {
    const { ctx } = await setup()
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'I have an interview at Tencent on Friday, keep it secret'))
    expect((await callAs(ctx, sessionOf(ALICE), 'test_say', { text: 'Good luck, I will not tell.' })).isError).toBe(false)
    await ctx.animaLife.deliver(message(OWNER, 'Sam', 'morning', { isOwner: true }))
    const segments = ctx.animaMemory.store.claim('r', 10_000)
    expect(segments.map(s => [s.scope, s.lines.map(l => `${l.dir} ${l.speaker}`)])).toEqual([
      ['private:test:alice', ['in Alice', 'out you']],
      ['owner', ['in Sam (owner)']],
    ])
  })

  it('recalls a private fact in that private chat and not in a group', async () => {
    const { ctx } = await setup()
    const remembered = await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Alice has a job interview at Tencent next Friday; it is a secret.' })
    expect(remembered.text).toContain('heard by: private, test:alice')
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_recall', { query: 'Tencent interview' })).text).toContain('Tencent')
    expect((await callAs(ctx, sessionOf(GROUP), 'memory_recall', { query: 'Tencent interview' })).text).toBe('Nothing comes to mind.')
    expect((await callAs(ctx, sessionOf(OWNER), 'memory_recall', { query: 'Tencent interview' })).text).toBe('Nothing comes to mind.')
    expect((await callAs(ctx, selfSessionId('anima'), 'memory_recall', { query: 'Tencent' })).text).toContain('heard by: private, test:alice')

    // Auto-injection follows the same audience.
    const inAlice = await preStep(ctx, sessionOf(ALICE), '[Tue 2026-11-10 10:00] [test private "Alice (test)"] Alice: what am I doing next Friday?')
    expect(inAlice).toHaveLength(2)
    expect(inAlice[1]!.source).toMatchObject({ kind: 'anima-memory', form: 'recall' })
    expect(JSON.stringify(inAlice[1]!.content)).toContain('Tencent')
    const inGroup = await preStep(ctx, sessionOf(GROUP), '[Tue 2026-11-10 10:00] [test group "group g (test)"] Bob: what is Alice doing next Friday at Tencent?')
    expect(inGroup).toHaveLength(1)
  })

  it('cannot widen a scope; keep self hides it from every conversation', async () => {
    const { ctx } = await setup()
    await callAs(ctx, sessionOf(GROUP), 'memory_remember', { text: 'Bob said the group jazz night moved to Sunday.' })
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_recall', { query: 'jazz night' })).text).toBe('Nothing comes to mind.')
    expect((await callAs(ctx, sessionOf(GROUP), 'memory_recall', { query: 'jazz night' })).text).toContain('jazz')
    await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Alice whispered the password word pineapple.', keep: 'self' })
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_recall', { query: 'pineapple' })).text).toBe('Nothing comes to mind.')
    const bad = await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'x', keep: 'public' })
    expect(bad.isError).toBe(true)
  })

  it('forgets only memories reachable in the session', async () => {
    const { ctx } = await setup()
    await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Alice likes tea.' })
    const id = ctx.animaMemory.store.list()[0]!.id
    expect((await callAs(ctx, sessionOf(GROUP), 'memory_forget', { id })).isError).toBe(true)
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_forget', { id })).isError).toBe(false)
    expect(ctx.animaMemory.store.get(id)).toBeUndefined()
  })

  it('consolidates in its own session; scopes come from the segment', async () => {
    const { ctx, host } = await setup()
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'I moved to Hangzhou last week'))
    await ctx.animaLife.deliver(message(GROUP, 'Bob', 'anyone up for hotpot?', { addressed: true }))
    const lines = await ctx.animaMemory.consolidate('her')
    expect(lines).toBe(2)
    const consolidationId = consolidationSessionId('anima', ctx.anima.dayKey())
    const delivered = host.delivered.find(d => d.id === consolidationId)!
    expect(delivered.text).toContain('## s1: Alice (test); heard by: private, test:alice')
    expect(delivered.text).toContain('People: Alice [test:alice]')
    expect(host.models).toContainEqual({ id: consolidationId, model: 'deepseek-flash' })
    expect(ctx.anima.describeSession(consolidationId)).toEqual({ kind: 'consolidation' })

    const wrote = await callAs(ctx, consolidationId, 'memory_write', { segment: 's1', kind: 'fact', text: 'Alice moved to Hangzhou in early November 2026.' })
    expect(wrote.text).toContain('heard by: private, test:alice')
    expect(ctx.animaMemory.store.list()[0]).toMatchObject({ scope: 'private:test:alice', personId: 'test:alice' })
    expect((await callAs(ctx, consolidationId, 'memory_write', { segment: 's9', kind: 'fact', text: 'x' })).isError).toBe(true)
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_write', { segment: 's1', kind: 'fact', text: 'x' })).isError).toBe(true)

    ctx.emit('session/event' as never, { id: consolidationId } as never, { type: 'turn/end', data: {} } as never)
    expect(ctx.animaMemory.consolidating).toBe(false)
    expect(ctx.animaMemory.store.pendingCount()).toBe(0)
    expect(ctx.animaMemory.reportLine()).toMatch(/^Memory: 0 conversation lines not yet consolidated; last consolidation 2026-11-10 10:00\.$/)
  })

  it('keeps what she watched as public: heard in the owner chat and by others, never widened further', async () => {
    const { ctx, host } = await setup()
    const id = ctx.animaMemory.observe({ text: 'You looked closely at BV1abc «Cat piano». Your viewing note: the cat plays a C major chord.', scope: 'public', memory: { kind: 'episode' } })
    expect(ctx.animaMemory.store.get(id!)).toMatchObject({ scope: 'public', kind: 'episode' })
    expect((await callAs(ctx, sessionOf(OWNER), 'memory_recall', { query: 'cat piano' })).text).toContain('C major')
    expect((await callAs(ctx, sessionOf(ALICE), 'memory_recall', { query: 'cat piano' })).text).toContain('C major')
    ctx.animaMemory.observe({ text: 'A private thought about the video.', scope: 'self', memory: {} })
    expect((await callAs(ctx, sessionOf(OWNER), 'memory_recall', { query: 'private thought video' })).text).toBe('Nothing comes to mind.')

    // A plain observation goes to the transcript as its own public segment for consolidation.
    expect(ctx.animaMemory.observe({ text: 'You watched BV1xyz «Hotpot vlog» by Mao.', scope: 'public' })).toBeUndefined()
    expect(await ctx.animaMemory.consolidate('her')).toBe(1)
    const delivered = host.delivered.find(d => d.id === consolidationSessionId('anima', ctx.anima.dayKey()))!
    expect(delivered.text).toContain('## s1: things you watched or read on your own; heard by: public')
    expect(delivered.text).toContain('Hotpot vlog')
  })

  it('runs the fallback when the oldest pending line is old enough', async () => {
    const { ctx, host } = await setup({ consolidation: { fallbackHours: 2 } as memory.Config['consolidation'] })
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'hello there'))
    ctx.animaMemory.tick()
    expect(ctx.animaMemory.consolidating).toBe(false)
    ctx.anima.setClock(() => NOW + 3 * 3_600_000)
    ctx.animaMemory.tick()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.animaMemory.consolidating).toBe(true)
    expect(host.delivered.some(d => d.text.includes('[整理记忆]'))).toBe(true)
  })

  it('wakes group conversations only when addressed', async () => {
    const { ctx, host } = await setup()
    await ctx.animaLife.deliver(message(GROUP, 'Bob', 'hotpot tonight?', { addressed: false }))
    await ctx.animaLife.deliver(message(GROUP, 'Bob', 'Anima, you coming?', { addressed: true }))
    // One burst wakes the group; the transcript still records both lines (Phase 9).
    expect(host.injected).toEqual([])
    expect(host.delivered.map(d => d.id)).toEqual([sessionOf(GROUP)])
    expect(ctx.animaMemory.store.pendingCount()).toBe(2)
  })

  it('records group lines that triage only remembers, with the group scope', async () => {
    const { ctx, host } = await setup()
    const stimulus = message(GROUP, 'Bob', 'the meetup moved to Sunday', { addressed: false })
    ctx.animaLife.router.know(GROUP)
    ctx.emit('anima/stimulus', { stimulus, sessionId: sessionOf(GROUP), delivery: 'record' })
    expect(ctx.animaMemory.store.pendingCount()).toBe(1)
    expect(host.delivered).toEqual([])
    const [segment] = ctx.animaMemory.store.claim('test', 10_000)
    expect(segment?.scope).toBe(`group:${GROUP.platform}:${GROUP.account}:${GROUP.kind}:${GROUP.id}`)
  })

  it('removes its registrations on unload', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.anima.behavior('memory_recall')).toMatchObject({ effect: 'observe' })
    await fiber.dispose()
    for (const name of ['memory_recall', 'memory_remember', 'memory_forget', 'memory_consolidate', 'memory_write']) {
      expect(ctx.anima.behavior(name)).toBeUndefined()
      expect(ctx.tools.get(name)).toBeUndefined()
    }
  })
})

describe('memory_remember about', () => {
  it('maps a private chat person named by display name to their person id', async () => {
    const { ctx } = await setup()
    await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Alice plays cello.', about: 'Alice' })
    await callAs(ctx, sessionOf(ALICE), 'memory_remember', { text: 'Bob is her brother.', about: 'Bob' })
    expect(ctx.animaMemory.store.list().map(m => m.personId)).toEqual(['Bob', 'test:alice'])
  })
})
