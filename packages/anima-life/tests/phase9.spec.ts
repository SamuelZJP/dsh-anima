import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AnimaLife, conversationSessionId, Inbox, inboxSummary, paceMessages, selfSessionId, typingMs, type ModelChoice, type PublishedChannel, type SessionHost, type StimulusEvent } from '../src/index.ts'

interface FakeAgent { id: string; inbox: string[]; models: ModelChoice[] }

class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent & { preset: string }>()
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string, spec: { agentPreset: string }) {
    this.sessions.set(id, { id, inbox: [], models: [], preset: spec.agentPreset })
    return id
  }
  isArchived() { return false }
  rename() {}
  async deliver(agent: FakeAgent, text: string) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, text: string) { agent.inbox.push(`(inject) ${text}`) }
  selectModel(agent: FakeAgent, choice: ModelChoice) { agent.models.push(choice) }
  isBusy() { return false }
}

const at = (text: string) => new Date(text).getTime()
const ownerChat: PublishedChannel = { platform: 'qq', account: '10', kind: 'private', id: '1', display: 'Sam', isOwner: true }
const ownerKey = 'qq:10:private:1'
const ownerSession = conversationSessionId('anima', ownerKey)
const group: PublishedChannel = { platform: 'qq', account: '10', kind: 'group', id: '42', display: 'Test group' }
const groupKey = 'qq:10:group:42'
const groupSession = conversationSessionId('anima', groupKey)
const sam = { platformUserId: '1', displayName: 'Sam', isOwner: true }
const bob = { platformUserId: '2001', displayName: 'Bob', isOwner: false }
const selfId = selfSessionId('anima')

async function setup(life: Record<string, unknown> = {}, start = '2026-11-10T10:00', dataDir = mkdtempSync(join(tmpdir(), 'anima-p9-'))) {
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start } })
  const clock = { now: at(start) }
  ctx.anima.setClock(() => clock.now)
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0, ...life.conversation as object }, groupTriage: { windowSeconds: 0.05, maxBatch: 3, timeoutSeconds: 0.3, ...life.groupTriage as object } } })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([ownerChat, group]) } })
  ctx.anima.registerBehavior(defineTool({
    name: 'qq_say', description: 'say', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute() { return { ok: true } },
  }), { platform: 'qq', effect: 'express', sessions: ['conversation'] })
  const stimuli: StimulusEvent[] = []
  ctx.on('anima/stimulus', event => { stimuli.push(event) })
  // A stand-in for the outside: a pause it can switch, and what she reports.
  const outside = { paused: false }
  ctx.on('anima/admit', request => outside.paused && (request.kind === 'reach' || request.kind === 'turn') ? { code: 'anima/paused', reason: 'paused' } : undefined)
  const recorded: { type: string; reason?: string; count?: number }[] = []
  ctx.on('anima/record', (record) => { recorded.push(record as never) })
  const pause = (paused: boolean) => { outside.paused = paused; ctx.emit('anima/paused', paused) }
  const reads: string[] = []
  ctx.on('anima/read', ({ channel }) => { reads.push(animaCore.channelKey(channel)) })
  return { ctx, host, clock, stimuli, reads, dataDir, recorded, pause }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`p9-${++calls}`), name, arguments: args, agent, toolSet, signal })
    const block = result.content[0] as { text?: string } | undefined
    return { isError: result.isError, text: block?.text ?? '' }
  } finally {
    toolSet.dispose()
  }
}

const dm = (ctx: Context, text: string) => ctx.animaLife.deliver({ type: 'message', channel: ownerChat, sender: sam, text, ts: ctx.anima.clock.now(), messageId: String(++calls) })
const chatter = (ctx: Context, text: string, extra: Record<string, unknown> = {}) => ctx.animaLife.deliver({ type: 'message', channel: group, sender: bob, text, ts: ctx.anima.clock.now(), messageId: String(++calls), ...extra })

describe('the inbox (DESIGN §5, Phase 9)', () => {
  it('holds chat messages while she sleeps: no wake, nothing read, persisted, in the transcript', async () => {
    const { ctx, host, clock, stimuli, reads, dataDir, recorded } = await setup({}, '2026-11-11T01:00')
    expect(ctx.anima.asleep()).toBe(true)
    await dm(ctx, '睡了吗')
    clock.now = at('2026-11-11T01:12')
    await dm(ctx, '晚安')
    await chatter(ctx, '@her 在吗', { addressed: true })
    expect(host.sessions.has(ownerSession)).toBe(false)
    expect(host.sessions.has(groupSession)).toBe(false)
    expect(reads).toEqual([])
    expect(stimuli.map(s => s.delivery)).toEqual(['record', 'record', 'record'])
    const saved = JSON.parse(readFileSync(join(dataDir, 'inbox.json'), 'utf8')) as { channels: Record<string, { messages: unknown[] }> }
    expect(saved.channels[ownerKey]!.messages).toHaveLength(2)
    expect(new Inbox(join(dataDir, 'inbox.json')).size()).toBe(3)
    expect(inboxSummary(ctx.animaLife.inbox.entries())).toBe(`收件箱：Sam 2 条（最后 01:12，channel "${ownerKey}"），Test group @你 1 条（最后 01:12，channel "${groupKey}"）。用 inbox_read 看，用 inbox_answer 交给那个聊天去回。`)
    expect(recorded.filter(r => r.type === 'inbox-held')).toHaveLength(3)
  })

  it('keeps unaddressed group chatter out of the inbox at night (remembered without a model)', async () => {
    const { ctx } = await setup({}, '2026-11-11T01:00')
    await chatter(ctx, 'late chatter')
    expect(ctx.animaLife.inbox.size()).toBe(0)
    await vi.waitFor(() => expect(ctx.animaLife.triage.batch('b1')).toMatchObject({ decision: 'remember', by: 'skipped' }))
  })

  it('shows Self the inbox at the first heartbeat after waking; inbox_answer hands one chat its burst as a reply', async () => {
    const { ctx, host, clock, reads, recorded } = await setup({}, '2026-11-11T01:00')
    await dm(ctx, '睡了吗')
    clock.now = at('2026-11-11T01:12')
    await dm(ctx, '晚安')
    clock.now = at('2026-11-11T07:40')
    await ctx.animaLife.beat()
    const self = host.sessions.get(selfId)!
    expect(self.inbox).toHaveLength(1)
    expect(self.inbox[0]).toMatch(/\[醒来\] 你醒了，收件箱里有你睡着时收到的消息。/)
    expect(self.inbox[0]).toContain('收件箱：Sam 2 条（最后 01:12')
    // A second heartbeat with nothing new goes to triage as usual.
    await ctx.animaLife.beat()
    expect(self.inbox).toHaveLength(1)

    const read = await callAs(ctx, selfId, 'inbox_read', {})
    expect(read.text).toMatch(/Sam — channel "qq:10:private:1"，2 条：\n  2026-11-11 01:00 Sam（主人） \[msg \d+\]: 睡了吗\n  2026-11-11 01:12 Sam（主人） \[msg \d+\]: 晚安/)
    const answered = await callAs(ctx, selfId, 'inbox_answer', { channel: ownerKey, note: '他昨晚睡得晚' })
    expect(answered).toEqual({ isError: false, text: '2 条消息交给了那个聊天。' })
    const chat = host.sessions.get(ownerSession)!.inbox
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatch(/Sam（主人）发来 2 条：\n  01:00（你睡着时收到） \[msg \d+\] 睡了吗\n  01:12（你睡着时收到） \[msg \d+\] 晚安\n（这些是你睡着时收到的，发送时间如上；你现在已经醒了。）\n（你在内心里想的：他昨晚睡得晚）\n在这里回应：用 qq_say 说话/)
    expect(reads).toEqual([ownerKey])
    expect(ctx.animaLife.inbox.size()).toBe(0)
    // It is a reply, not a conversation she started.
    expect(ctx.anima.behavior('inbox_answer')?.effect).toBe('express')
    const empty = await callAs(ctx, selfId, 'inbox_answer', { channel: ownerKey })
    expect(empty.text).toMatch(/^Error: anima\/inbox-empty: 收件箱里没有 Sam 的消息/)
    expect(recorded.filter(r => r.type === 'inbox-release' && r.reason === 'answer')).toEqual([expect.objectContaining({ count: 2 })])
  })

  it('releases held messages into the next burst when that chat wakes her again', async () => {
    const { ctx, host, clock } = await setup({}, '2026-11-11T01:00')
    await dm(ctx, '睡了吗')
    clock.now = at('2026-11-11T08:00')
    await dm(ctx, '早')
    const chat = host.sessions.get(ownerSession)!.inbox
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatch(/发来 2 条：\n  01:00（你睡着时收到） \[msg \d+\] 睡了吗\n  08:00 \[msg \d+\] 早\n（前 1 条是你睡着时收到的；你现在已经醒了。）/)
    expect(ctx.animaLife.inbox.size()).toBe(0)
  })

  it('wakes Self when the owner wakes her on purpose, with the inbox in her report', async () => {
    const { ctx, host } = await setup({}, '2026-11-11T02:00')
    await dm(ctx, '醒醒')
    ctx.anima.wakeByOwner()
    await vi.waitFor(() => expect(host.sessions.get(selfId)?.inbox.length).toBe(1))
    const text = host.sessions.get(selfId)!.inbox[0]!
    expect(text).toContain('[被叫醒] 主人把你叫醒了。')
    expect(text).toContain('The owner woke you at 02:00; you stay awake until you sleep again (sleep) or until 02:30.')
    expect(text).toContain('收件箱：Sam 1 条')
    // Awake now: a new message reaches the chat with the held one.
    await dm(ctx, '在吗')
    expect(host.sessions.get(ownerSession)!.inbox[0]).toMatch(/发来 2 条/)
  })

  it('holds messages while paused, and shows them in Self on resume', async () => {
    const { ctx, host, pause } = await setup()
    pause(true)
    await dm(ctx, 'hi')
    expect(host.sessions.has(ownerSession)).toBe(false)
    expect(ctx.animaLife.inbox.peek(ownerKey)).toEqual([expect.objectContaining({ text: 'hi', reason: 'paused' })])
    pause(false)
    await vi.waitFor(() => expect(host.sessions.get(selfId)?.inbox.length).toBe(1))
    expect(host.sessions.get(selfId)!.inbox[0]).toContain('[继续] 主人让你继续了。')
    await callAs(ctx, selfId, 'inbox_answer', { channel: ownerKey })
    expect(host.sessions.get(ownerSession)!.inbox[0]).toMatch(/暂停时收到/)
  })

  it('keeps notices for Self until she wakes', async () => {
    const { ctx, host } = await setup({}, '2026-11-11T02:00')
    await ctx.animaLife.deliver({ type: 'notice', text: 'look at this', ts: ctx.anima.clock.now() })
    expect(host.sessions.has(selfId)).toBe(false)
    expect(ctx.anima.statusLines().join('\n')).toContain('Asleep since')
  })

  it('moves messages settling when she falls asleep into the inbox', async () => {
    const { ctx, host, clock } = await setup({ conversation: { settleSeconds: 5 } }, '2026-11-10T22:40')
    await dm(ctx, '要睡了吗')
    clock.now = at('2026-11-10T22:45')
    expect((await callAs(ctx, selfId, 'sleep', {})).isError).toBe(false)
    expect(host.sessions.has(ownerSession)).toBe(false)
    expect(ctx.animaLife.inbox.peek(ownerKey)).toHaveLength(1)
  })
})

describe('settle timing (DESIGN §6, Phase 9)', () => {
  it('waits for quiet, and wakes at the cap however long the stream goes on', async () => {
    const { ctx, host } = await setup({ conversation: { settleSeconds: 0.08, settleMaxSeconds: 0.2 } })
    const started = Date.now()
    for (let i = 0; i < 8; i++) {
      await dm(ctx, `line ${i}`)
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    await vi.waitFor(() => expect(host.sessions.get(ownerSession)?.inbox.length).toBeGreaterThanOrEqual(1))
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(330)
    expect(host.sessions.get(ownerSession)!.inbox[0]).toMatch(/Sam（主人）发来 \d 条/)
  })

  it('keeps the window open while the other person types', async () => {
    const { ctx, host } = await setup({ conversation: { settleSeconds: 0.08, settleMaxSeconds: 1 } })
    await dm(ctx, '我跟你说')
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      ctx.animaLife.typing(ownerChat)
    }
    expect(host.sessions.has(ownerSession)).toBe(false)
    await dm(ctx, '今天发生了一件事')
    await vi.waitFor(() => expect(host.sessions.get(ownerSession)?.inbox.length).toBe(1))
    expect(host.sessions.get(ownerSession)!.inbox[0]).toMatch(/发来 2 条/)
    expect(ctx.anima.statusLines().join('\n')).toContain('Settle window: 0.08 s quiet, at most 1 s')
  })

  it('has the owner-approved defaults: 15 s of quiet, at most 60 s', async () => {
    const { resolveLifeConfig } = await import('../src/index.ts')
    expect(resolveLifeConfig({}).conversation).toMatchObject({ settleSeconds: 15, settleMaxSeconds: 60 })
  })
})

describe('message spacing (DESIGN §6, Phase 9)', () => {
  const pacing = { baseSeconds: 1, perCharSeconds: 0.15, maxSeconds: 6 }

  it('gives a typing time from length: 1 s + 0.15 s per character, at most 6 s', () => {
    expect(typingMs('好', pacing)).toBe(1150)
    expect(typingMs('今天天气不错呀', pacing)).toBe(2050)
    expect(typingMs('x'.repeat(100), pacing)).toBe(6000)
  })

  it('waits before each message after the first and says when it waits', async () => {
    const waits: number[] = []
    const shown: number[] = []
    const sent = await paceMessages(['在的', '刚醒', '你呢？'], pacing, async (index, text) => `${index}:${text}`, {
      beforeWait: index => { shown.push(index) },
      wait: async ms => { waits.push(ms) },
    })
    expect(sent).toEqual(['0:在的', '1:刚醒', '2:你呢？'])
    expect(waits).toEqual([1300, 1450])
    expect(shown).toEqual([1, 2])
  })
})
