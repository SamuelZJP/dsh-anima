import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { SAY_META, SAY_PARAMETERS } from '@anima/core'
import { AnimaLife, consolidationSessionId, type Delivery, type LogEvent, type PublishedChannel, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as memory from '../src/index.ts'
import { buildBlock, channelsIn, cutPieces, decayStep, gistOf, MEMORY_HEADER, MemoryStore, personOf, renderLog, resolveMemoryConfig, searchTerms, sourceLabel } from '../src/index.ts'

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
const ALICE_KEY = 'test:me:private:alice'
const GROUP_KEY = 'test:me:group:g'

describe('MemoryStore', () => {
  it('recalls every memory wherever it came from, and finds CJK terms of two characters and longer', () => {
    const store = openStore()
    store.remember({ kind: 'fact', channelKey: ALICE_KEY, fromPerson: 'test:alice', fromName: 'Alice', personId: 'test:alice', text: 'Alice has an interview at a game studio on Friday.', now: NOW })
    store.remember({ kind: 'fact', channelKey: GROUP_KEY, text: '读书群周末去香山爬山', now: NOW })
    expect(store.recall('interview').map(m => m.channelKey)).toEqual([ALICE_KEY])
    expect(store.recall('香山').map(m => m.text)).toEqual(['读书群周末去香山爬山'])
    expect(searchTerms('a an 我 香山 interview')).toEqual(['香山', 'interview'])
  })

  it('keeps superseded memories as history, out of recall', () => {
    const store = openStore()
    const old = store.remember({ kind: 'fact', text: 'Bob lives in Beijing.', now: NOW })
    const fresh = store.remember({ kind: 'fact', text: 'Bob lives in Shanghai now.', now: NOW })
    store.supersede(old.id, fresh.id, NOW)
    expect(store.recall('Bob lives').map(m => m.id)).toEqual([fresh.id])
    expect(store.get(old.id)).toMatchObject({ status: 'superseded', replacedBy: fresh.id })
  })

  it('fails loud on a store of the first design and leaves it as it is', () => {
    const path = join(tempDir(), 'memory.db')
    const old = new DatabaseSync(path)
    old.exec("CREATE TABLE transcript (id INTEGER PRIMARY KEY); CREATE TABLE memories (id INTEGER PRIMARY KEY, scope TEXT); INSERT INTO memories (scope) VALUES ('owner');")
    old.close()
    expect(() => new MemoryStore(path)).toThrow(/anima\/memory-old-store: .*fresh dataDir/)
    const again = new DatabaseSync(path)
    expect(again.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 1 })
    again.close()
  })

  it('tracks what was shown in a waking and how far each ended waking is consolidated', () => {
    const store = openStore()
    store.markShown('w1', ['m1', 'waking'])
    expect(store.shownIn('w1', ['m1', 'm2', 'waking'])).toEqual(new Set(['m1', 'waking']))
    expect(store.shownIn('w2', ['m1']).size).toBe(0)
    store.addWaking('w1', NOW)
    store.addWaking('w1', NOW + 1)
    expect(store.pendingWakings()).toEqual([{ sessionId: 'w1', upto: -1, archivedAt: NOW }])
    store.advanceWaking('w1', 12)
    store.advanceWaking('w1', 7)
    expect(store.pendingWakings()[0]!.upto).toBe(12)
    store.finishWaking('w1')
    expect(store.pendingWakings()).toEqual([])
  })
})

describe('decay', () => {
  it('halves an episode over its half-life and leaves self memories alone', () => {
    const episode = { kind: 'episode' as const, strength: 1, importance: 0, recalls: 0, gisted: false }
    expect(decayStep(episode, 7, decay).strength).toBeCloseTo(0.5)
    expect(decayStep({ ...episode, kind: 'self' }, 70, decay).strength).toBe(1)
  })

  it('gists, then archives weak memories', () => {
    const store = openStore()
    const m = store.remember({ kind: 'episode', text: 'We talked about hiking. Then about dinner plans for Friday.', importance: 0, now: NOW })
    store.decay(20, decay, NOW)
    expect(store.get(m.id)).toMatchObject({ text: 'We talked about hiking.', status: 'active' })
    store.decay(20, decay, NOW)
    expect(store.get(m.id)!.status).toBe('archived')
    expect(store.recall('hiking')).toEqual([])
    expect(store.recall('hiking', { archive: true })).toHaveLength(1)
    expect(gistOf('一二三四五六七八九十', 5)).toBe('一二三四…')
  })
})

describe('sources', () => {
  it('names a person by owner, link or account, and labels where a memory came from', () => {
    const persons = [{ id: 'alice', accounts: ['qq:1', 'wechat:a'] }]
    expect(personOf('qq', '9', true, persons)).toBe('owner')
    expect(personOf('wechat', 'a', false, persons)).toBe('alice')
    expect(personOf('qq', '2', false, persons)).toBe('qq:2')
    const channel = { platform: 'qq', account: 'me', kind: 'private' as const, id: '1', display: 'Alice' }
    expect(sourceLabel({ channelKey: 'qq:me:private:1', fromName: 'Alice', createdAt: NOW }, channel)).toBe('来源：Alice，[QQ 私聊「Alice」 qq:me:private:1]，11-10 10:00')
    expect(sourceLabel({ createdAt: NOW }, undefined)).toBe('来源：你自己，11-10 10:00')
  })
})

describe('buildBlock', () => {
  it('stays within the token budget, skips what was shown, and labels every memory', () => {
    const store = openStore()
    for (let i = 0; i < 20; i += 1) store.remember({ kind: 'fact', personId: 'p', channelKey: ALICE_KEY, text: `P likes thing number ${i} quite a lot.`, now: NOW })
    const cues = { people: ['p'], channels: [], query: '', latest: 0 }
    const block = buildBlock({ store, cues, channelEpisodes: 3, exclude: new Set(['m20']), channel: () => undefined, tokenBudget: 100, maxItems: 12 })!
    expect(block.text.startsWith(MEMORY_HEADER)).toBe(true)
    expect(block.ids).not.toContain('m20')
    expect(block.ids.length).toBeGreaterThan(0)
    expect(block.ids.length).toBeLessThan(12)
    expect(block.text).toContain(`来源：[${ALICE_KEY}]`)
    expect(buildBlock({ store, cues: { people: [], channels: [], query: 'nothing here', latest: 0 }, channelEpisodes: 3, exclude: new Set(), channel: () => undefined, tokenBudget: 800, maxItems: 12 })).toBeUndefined()
  })
})

// ---- the log of an ended waking ----

let seq = 0
const ev = (type: string, data: unknown): LogEvent => ({ type, seq: ++seq, time: 0, data })
const arrival = (text: string, extra: Record<string, unknown> = {}, kind = 'anima-stimulus') => ev('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind, stimulus: 'message', ...extra } })
const assistant = (...content: unknown[]) => ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content }, stream: [] })
const result = (callId: string, text: string, isError = false) => ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], ...isError ? { isError } : {} } })

describe('renderLog', () => {
  it('keeps what entered her context, leaves out what came to mind, and cuts pieces at event edges', () => {
    const alice = [{ platform: 'test', userId: 'alice', name: 'Alice' }]
    const events = [
      ev('request/header', {}),
      arrival(`[Tue 10:00] [test 私聊「Alice」 ${ALICE_KEY}] Alice 对你说: 我下午去面试，先别说`, { channel: ALICE_KEY, people: alice }),
      arrival('[memory] 你此刻想起的事：- m1 …', {}, 'anima-memory'),
      assistant({ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '她很紧张' }, { type: 'tool-call', id: 'c1', name: 'test_say', arguments: JSON.stringify({ channel: ALICE_KEY, text: '加油！', also: ['我不说'] }) }),
      result('c1', 'sent'),
      assistant({ type: 'tool-call', id: 'c2', name: 'groups_glance', arguments: '{}' }),
      result('c2', `[test 群「g」 ${GROUP_KEY}] 1 条未读：${'很长的一行'.repeat(40)}`),
      arrival('[Tue 11:00] [心跳]\n状态 … '.padEnd(400, '。'), { stimulus: 'heartbeat' }),
    ]
    const lines = renderLog(events, { resultChars: 60 })
    expect(lines.map(line => line.text.slice(0, 12))).toEqual(['[Tue 10:00] ', '（你心里想：她很紧张）', `你在 ${ALICE_KEY}`.slice(0, 12), '你用了 groups_g', '→ [test 群「g」', '[Tue 11:00] '])
    expect(lines.some(line => line.text.includes('[memory]') || line.text.includes('hidden'))).toBe(false)
    expect(lines[2]!.text).toBe(`你在 ${ALICE_KEY} 说：「加油！」「我不说」`)
    expect(lines[0]).toMatchObject({ channels: [ALICE_KEY], people: alice })
    expect(lines[4]!.channels).toEqual([GROUP_KEY])
    expect(lines[4]!.text.length).toBeLessThanOrEqual(62)
    expect(lines[5]!.text.length).toBeLessThanOrEqual(60)
    const pieces = cutPieces(lines, 40)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(new Set(piece.lines.map(l => l.seq)).size).toBeGreaterThan(0)
    // Lines of one event never split across pieces.
    expect(pieces.flatMap(p => p.lines)).toEqual(lines)
    expect(new Set(pieces.map(p => p.lines.at(-1)!.seq)).size).toBe(pieces.length)
    expect(pieces.every((p, i) => i === 0 || p.from > pieces[i - 1]!.to)).toBe(true)
    expect(channelsIn('[QQ 群「x」 qq:1:group:300] 和 qq:1:private:2。')).toEqual(['qq:1:group:300', 'qq:1:private:2'])
  })
})

// ---- the service, over core and life with a fake session host ----

/** A fake DSH: sessions, and a log of what was delivered into each (as DSH logs steered and injected messages). */
class RecordingHost implements SessionHost {
  readonly delivered: { id: string; text: string }[] = []
  readonly models: { id: string; model: string }[] = []
  readonly cancelled: string[] = []
  readonly existing = new Set<string>()
  readonly archived = new Set<string>()
  readonly logs = new Map<string, LogEvent[]>()
  private seq = 0
  async resolve(id: string) { return this.existing.has(id) ? { id } : undefined }
  async create(id: string) { this.existing.add(id); return id }
  isArchived(id: string) { return this.archived.has(id) }
  async archive(id: string) { this.archived.add(id); return 'archived' as const }
  async moveAlarms() { return 0 }
  rename() {}
  private log(id: string, delivery: Delivery) {
    const source = { kind: 'anima-stimulus', stimulus: delivery.stimulus, ...delivery.channel === undefined ? {} : { channel: delivery.channel }, ...delivery.people === undefined ? {} : { people: delivery.people } }
    this.logEvent(id, 'user/message', { role: 'user', content: [{ type: 'text', text: delivery.text }], source })
  }
  logEvent(id: string, type: string, data: unknown) {
    const list = this.logs.get(id) ?? []
    list.push({ type, seq: ++this.seq, time: 0, data })
    this.logs.set(id, list)
  }
  async readLog(id: string) { return this.logs.get(id) ?? [] }
  async deliver(agent: { id: string }, delivery: Delivery) { this.delivered.push({ id: agent.id, text: delivery.text }); this.log(agent.id, delivery) }
  async inject(agent: { id: string }, delivery: Delivery) { this.log(agent.id, delivery) }
  cancel(agent: { id: string }) { this.cancelled.push(agent.id) }
  selectModel(agent: { id: string }, choice: { model: string }) { this.models.push({ id: agent.id, model: choice.model }) }
}

const OWNER: PublishedChannel = { platform: 'test', account: 'me', kind: 'private', id: 'sam', display: 'Sam (test)', isOwner: true }
const ALICE: PublishedChannel = { platform: 'test', account: 'me', kind: 'private', id: 'alice', display: 'Alice (test)' }
const GROUP: PublishedChannel = { platform: 'test', account: 'me', kind: 'group', id: 'g', display: 'group g (test)' }
const QUIET: PublishedChannel = { platform: 'test', account: 'me', kind: 'group', id: 'q', display: 'quiet group (test)' }
const genes = { risePerHour: 0.05, fallPerHour: 0.1, fallAsleepAbove: 0.1, overwhelmAbove: 0.95, wakeBelow: 0.01 }
const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

async function setup(config: Partial<memory.Config> = {}) {
  const dataDir = tempDir()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir, sleep: genes, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const host = new RecordingHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  ctx.animaLife.publish([OWNER, ALICE, GROUP, QUIET])
  ctx.anima.registerBehavior(defineTool({
    name: 'test_say',
    description: 'say',
    parameters: { ...SAY_PARAMETERS },
    output: { schema: { type: 'object', additionalProperties: false, properties: { sent: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute() { return { sent: true } },
  }), { platform: 'test', effect: 'express', sessions: ['waking'], ...SAY_META })
  const fiber = await ctx.plugin(memory, config)
  await settle(5)
  const waking = ctx.animaLife.waking.current!
  return { ctx, host, fiber, dataDir, waking }
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

/** A step of a session with these messages (an arrival's source as life writes it), through memory's pre-step. */
async function preStep(ctx: Context, sessionId: string, text: string, source: Record<string, unknown> = { kind: 'user' }, step = 1): Promise<UserMessage[]> {
  const incoming = createUserMessage({ content: [{ type: 'text', text }], source: source as never })
  const service = ctx.animaMemory as unknown as { preStep: (p: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> }
  const decision = await service.preStep({ agent: { id: sessionId }, messages: [incoming], step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [incoming] }))
  return decision.kind === 'enter' ? decision.messages : []
}

const fromGroup = (name: string) => ({ kind: 'anima-stimulus', stimulus: 'message', channel: GROUP_KEY, people: [{ platform: 'test', userId: name.toLowerCase(), name }] })
const memoryText = (messages: UserMessage[]) => messages.filter(m => m.source?.kind === 'anima-memory').map(m => JSON.stringify(m.content)).join('')

describe('native DSH sessions (not hers)', () => {
  it('get nothing from Anima: no behavior, no recall, no record, no stimulus', async () => {
    const { ctx, host, waking } = await setup()
    await callAs(ctx, waking, 'memory_remember', { text: 'Alice likes rainy days.', channel: ALICE_KEY })
    const records: unknown[] = []
    ctx.on('anima/record', record => { records.push(record) })
    const sent = host.delivered.length
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
    ctx.emit('session/event' as never, { id: web } as never, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    expect(records).toEqual([])
    expect(host.delivered.length).toBe(sent)
  })
})

describe('AnimaMemory: coming to mind', () => {
  it('brings what Alice said privately to mind in a group, labelled with where it came from, once per waking', async () => {
    const { ctx, waking } = await setup()
    const kept = await callAs(ctx, waking, 'memory_remember', { text: 'Alice has an interview at a game studio this afternoon.', channel: ALICE_KEY })
    expect(kept.text).toContain(`来源：Alice，[test 私聊「Alice」 ${ALICE_KEY}]`)
    expect(ctx.animaMemory.store.list()[0]).toMatchObject({ fromPerson: 'test:alice', personId: 'test:alice', channelKey: ALICE_KEY, waking })
    // The first step of a waking (nothing cued yet), then a group asks about her.
    await preStep(ctx, waking, '[醒来]')
    const cued = await preStep(ctx, waking, `[Tue 11:00] [test 群「group g」 ${GROUP_KEY}] Bob 叫你: what is Alice doing this afternoon, an interview?`, fromGroup('Bob'), 3)
    expect(cued).toHaveLength(2)
    expect(cued[1]!.source).toMatchObject({ kind: 'anima-memory', form: 'recall' })
    expect(memoryText(cued)).toContain('game studio')
    expect(memoryText(cued)).toContain(`私聊「Alice」 ${ALICE_KEY}`)
    expect(ctx.animaMemory.store.list()[0]!.recalls).toBe(1)
    // No repeats in this waking.
    expect(await preStep(ctx, waking, 'interview interview', fromGroup('Bob'), 5)).toHaveLength(1)
    expect((await callAs(ctx, waking, 'memory_recall', { query: 'interview' })).text).toContain('来源：Alice')
  })

  it('at the first step of a waking brings her open goals and latest episodes, and facts about the people that write', async () => {
    const { ctx, waking } = await setup()
    ctx.anima.goals.add({ text: 'ask Alice how the interview went', owner: 'her', now: NOW })
    ctx.animaMemory.store.remember({ kind: 'episode', channelKey: GROUP_KEY, text: 'The book club planned a hike to Xiangshan.', now: NOW })
    ctx.animaMemory.store.remember({ kind: 'fact', personId: 'test:bob', text: 'Bob is allergic to cats.', now: NOW })
    const first = memoryText(await preStep(ctx, waking, '[醒来] 你睡醒了。'))
    expect(first).toContain('ask Alice how the interview went')
    expect(first).toContain('Xiangshan')
    expect(first).not.toContain('allergic')
    expect(memoryText(await preStep(ctx, waking, '[心跳]\n精力 0.80', { kind: 'anima-stimulus', stimulus: 'heartbeat' }))).toBe('')
    expect(memoryText(await preStep(ctx, waking, 'hi', fromGroup('Bob'), 2))).toContain('allergic')
  })

  it('at first contact in a waking brings the chat\'s last lines from before she woke, from its history', async () => {
    const { ctx, waking } = await setup()
    const woke = ctx.anima.sleepInfo().since
    ctx.animaLife.provideHistory('test', async (_channel, request) => [
      { ts: woke - 3_600_000, who: 'Alice', text: 'see you tomorrow at the station', messageId: '1' },
      { ts: woke - 60_000, who: 'you', text: 'good night', messageId: '2' },
      { ts: woke + 1, who: 'Alice', text: 'morning!', messageId: '3' },
    ].slice(-request.count))
    await preStep(ctx, waking, '[醒来]')
    const source = { kind: 'anima-stimulus', stimulus: 'message', channel: ALICE_KEY, people: [{ platform: 'test', userId: 'alice', name: 'Alice' }] }
    const first = memoryText(await preStep(ctx, waking, `[test 私聊「Alice」 ${ALICE_KEY}] Alice 对你说: morning!`, source, 2))
    expect(first).toContain('你醒来之前，这里最后几句')
    expect(first).toContain('see you tomorrow at the station')
    expect(first).toContain('good night')
    expect(first).not.toContain('morning!')
    expect(memoryText(await preStep(ctx, waking, 'again', source, 4))).not.toContain('你醒来之前')
  })
})

describe('AnimaMemory: behaviors', () => {
  it('has no behavior to forget, and refuses an unknown channel', async () => {
    const { ctx, waking } = await setup()
    expect(ctx.anima.behavior('memory_forget')).toBeUndefined()
    expect((await callAs(ctx, waking, 'memory_remember', { text: 'x', channel: 'test:me:private:nobody' })).text).toContain('anima/unknown-channel')
  })

  it('maps a person named by display name to their person id', async () => {
    const { ctx, waking } = await setup()
    await callAs(ctx, waking, 'memory_remember', { text: 'Alice plays cello.', about: 'Alice', channel: ALICE_KEY })
    await callAs(ctx, waking, 'memory_remember', { text: 'Bob is her brother.', about: 'Bob', channel: ALICE_KEY })
    expect(ctx.animaMemory.store.list().map(m => m.personId)).toEqual(['Bob', 'test:alice'])
  })

  it('removes its registrations on unload', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.anima.behavior('memory_recall')).toMatchObject({ effect: 'observe' })
    await fiber.dispose()
    for (const name of ['memory_recall', 'memory_remember', 'memory_write']) {
      expect(ctx.anima.behavior(name)).toBeUndefined()
      expect(ctx.tools.get(name)).toBeUndefined()
    }
  })

  it('fails loud on the removed fallback', () => {
    expect(() => resolveMemoryConfig({ consolidation: { fallbackHours: 24 } } as never)).toThrow(/anima\/config-removed: consolidation\.fallbackHours is gone/)
  })
})

describe('AnimaMemory: consolidation in sleep', () => {
  it('sorts the archived log of the ended waking while she sleeps, piece by piece; unglanced group lines are not in it', async () => {
    const { ctx, host, waking } = await setup({ consolidation: { maxInputTokens: 200 } as never })
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'I moved to Hangzhou last week, keep it quiet'))
    await ctx.animaLife.deliver(message(OWNER, 'Sam', `今天${'很忙'.repeat(120)}`, { isOwner: true }))
    await ctx.animaLife.deliver(message(QUIET, 'Carol', 'the purple submarine sails at noon', { addressed: false }))
    await ctx.animaLife.deliver(message(GROUP, 'Bob', 'anyone up for hotpot?', { addressed: true }))
    host.logEvent(waking, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'k1', name: 'test_say', arguments: JSON.stringify({ channel: GROUP_KEY, text: 'me!' }) }] } })
    expect(ctx.anima.behavior('memory_consolidate')).toBeUndefined()
    ctx.animaMemory.tick()
    expect(ctx.animaMemory.consolidating).toBe(false)

    expect((await callAs(ctx, waking, 'sleep', {})).text).toBe('你睡着了。')
    await settle()
    expect(ctx.animaMemory.consolidating).toBe(true)
    const consolidationId = consolidationSessionId('anima', waking)
    expect(ctx.anima.describeSession(consolidationId)).toEqual({ kind: 'consolidation' })
    expect(host.models).toContainEqual({ id: consolidationId, model: 'deepseek-flash' })
    const pieces = () => host.delivered.filter(d => d.id === consolidationId).map(d => d.text)
    const all = () => pieces().join('\n')
    expect(pieces()[0]).toContain('在场的人：')
    expect(pieces()[0]).toContain('Hangzhou')

    // A memory's source must be a place in the piece.
    expect((await callAs(ctx, consolidationId, 'memory_write', { kind: 'fact', text: 'x', channel: 'test:me:private:sam' })).text).toContain('anima/unknown-channel')
    expect((await callAs(ctx, waking, 'memory_write', { kind: 'fact', text: 'x' })).isError).toBe(true)
    const wrote = await callAs(ctx, consolidationId, 'memory_write', { kind: 'fact', text: 'Alice moved to Hangzhou in early November 2026.', channel: ALICE_KEY })
    expect(wrote.text).toContain(`来源：Alice，[test 私聊「Alice」 ${ALICE_KEY}]`)
    expect(ctx.animaMemory.store.list()[0]).toMatchObject({ channelKey: ALICE_KEY, fromPerson: 'test:alice', personId: 'test:alice', waking })

    // Each completed turn moves on to the next piece, until the waking is done.
    for (let i = 0; i < 10 && ctx.animaMemory.consolidating; i += 1) {
      ctx.emit('session/event' as never, { id: consolidationId } as never, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
      await settle()
    }
    expect(pieces().length).toBeGreaterThan(1)
    expect(all()).toContain('anyone up for hotpot?')
    expect(all()).toContain(`你在 ${GROUP_KEY} 说：「me!」`)
    expect(all()).not.toContain('purple submarine')
    expect(ctx.animaMemory.store.pendingWakings()).toEqual([])
    expect(ctx.animaMemory.reportLine()).toMatch(/^Memory: every ended waking is consolidated; last consolidation 2026-11-10 10:00\.$/)
  })

  it('stops when she wakes and takes the piece up again at her next sleep', async () => {
    const { ctx, host, waking } = await setup()
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'my cat is called Mochi'))
    await callAs(ctx, waking, 'sleep', {})
    await settle()
    const consolidationId = consolidationSessionId('anima', waking)
    expect(ctx.animaMemory.consolidating).toBe(true)
    expect(ctx.anima.wakeByOwner()).toMatchObject({ woken: true })
    await settle()
    expect(ctx.animaMemory.consolidating).toBe(false)
    expect(host.cancelled).toEqual([consolidationId])
    // The cancelled turn's end does not count.
    ctx.emit('session/event' as never, { id: consolidationId } as never, { type: 'turn/end', data: { reason: { kind: 'aborted' } } } as never)
    expect(ctx.animaMemory.store.pendingWakings().map(w => w.sessionId)).toEqual([waking])
    const before = host.delivered.filter(d => d.id === consolidationId).length

    await callAs(ctx, ctx.animaLife.waking.current!, 'sleep', {})
    await settle()
    const again = host.delivered.filter(d => d.id === consolidationId)
    expect(again.length).toBe(before + 1)
    expect(again.at(-1)!.text).toContain('Mochi')
  })

  it('waits for her next sleep when a turn ends cut short', async () => {
    const { ctx, host, waking } = await setup()
    await ctx.animaLife.deliver(message(ALICE, 'Alice', 'my cat is called Mochi'))
    await callAs(ctx, waking, 'sleep', {})
    await settle()
    const consolidationId = consolidationSessionId('anima', waking)
    ctx.emit('session/event' as never, { id: consolidationId } as never, { type: 'turn/end', data: { reason: { kind: 'error' } } } as never)
    await settle()
    expect(ctx.animaMemory.consolidating).toBe(false)
    expect(host.delivered.filter(d => d.id === consolidationId)).toHaveLength(1)
    expect(ctx.animaMemory.store.pendingWakings()).toHaveLength(1)
  })
})
