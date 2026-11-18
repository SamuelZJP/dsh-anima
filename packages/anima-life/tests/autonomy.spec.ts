import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { AdmitRefusal, AdmitRequest } from '@anima/core'
import * as animaCore from '@anima/core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { alarmPrompts, AnimaLife, buildReport, conversationSessionId, IntentTracker, nextBeat, selfSessionId, triageSessionId } from '../src/index.ts'
import type { ModelChoice, PublishedChannel, SessionHost } from '../src/index.ts'

const at = (text: string) => new Date(text).getTime()

describe('nextBeat', () => {
  it('is her resting rhythm and nothing else', () => {
    const noon = at('2026-11-10T12:00')
    expect(nextBeat(noon, 60)).toBe(at('2026-11-10T13:00'))
    expect(nextBeat(at('2026-11-11T02:00'), 45)).toBe(at('2026-11-11T02:45'))
  })
})

describe('IntentTracker', () => {
  const intent = { id: 'i1', sessionId: 'c1', channelKey: 'demo:owner:private:owner', display: 'Owner (demo)', intent: 'say hi', at: 0 }
  const isSay = (name: string) => name === 'demo_say'

  function claimed() {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, isSay)
    tracker.open(intent)
    tracker.onUserMessage('c1', 'i1')
    return tracker
  }

  it('reports sent, then replied on the next owner message', () => {
    const tracker = claimed()
    tracker.onToolCall('c1', 'a', 'demo_say')
    expect(tracker.onToolResult('c1', 'a', false)).toMatchObject({ kind: 'sent' })
    expect(tracker.onTurnEnd('c1')).toBeUndefined()
    expect(tracker.onOwnerMessage('demo:owner:private:owner')).toMatchObject({ kind: 'replied' })
    expect(tracker.onOwnerMessage('demo:owner:private:owner')).toBeUndefined()
  })

  it('reports a decline with the end_turn reason', () => {
    const tracker = claimed()
    tracker.onToolCall('c1', 'a', 'end_turn', 'he is asleep')
    expect(tracker.onToolResult('c1', 'a', false)).toEqual({ intent, kind: 'declined', detail: 'he is asleep' })
  })

  it('reports no-action when the turn ends without speaking', () => {
    const tracker = claimed()
    tracker.onToolCall('c1', 'a', 'self_feel')
    expect(tracker.onToolResult('c1', 'a', false)).toBeUndefined()
    expect(tracker.onTurnEnd('c1')).toMatchObject({ kind: 'no-action' })
  })

  it('reports a failed say', () => {
    const tracker = claimed()
    tracker.onToolCall('c1', 'a', 'demo_say')
    expect(tracker.onToolResult('c1', 'a', true, 'Error: anima/over-quota: …')).toMatchObject({ kind: 'failed', detail: 'Error: anima/over-quota: …' })
  })

  it('ignores conversation events before the intent is claimed', () => {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, isSay)
    tracker.open(intent)
    expect(tracker.onTurnEnd('c1')).toBeUndefined()
    tracker.onUserMessage('c1', undefined)
    expect(tracker.onTurnEnd('c1')).toBeUndefined()
    tracker.onUserMessage('c1', 'i1')
    expect(tracker.onTurnEnd('c1')).toMatchObject({ kind: 'no-action' })
  })
})

describe('situation report', () => {
  it('lists state, goals, events, budgets and channels', () => {
    const now = at('2026-11-10T12:00')
    const text = buildReport({
      time: 'Tue 2026-11-10 12:00', phase: 'day', mode: 'day',
      state: ['energy 0.80'], goals: ['g1 [owner] ask about the exam'], events: [],
      budgets: ['conversations you may still start today: 3 of 3'],
      channels: [{ key: 'demo:owner:private:owner', display: 'Owner (demo)', mayInitiate: true, lastContact: now - 3 * 3_600_000 }],
      now,
    })
    expect(text).toContain('Time Tue 2026-11-10 12:00; phase day.')
    expect(text).toContain('Since your last heartbeat: nothing new')
    expect(text).toContain('  g1 [owner] ask about the exam')
    expect(text).toContain('Owner (demo) — channel "demo:owner:private:owner"; you may start a conversation; last message 3 h ago')
  })
})

// ---- service flow with a fake host ----

interface FakeAgent { id: string; inbox: string[]; models: ModelChoice[] }

class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent & { preset: string }>()
  busy = new Set<string>()
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string, spec: { agentPreset: string }) {
    this.sessions.set(id, { id, inbox: [], models: [], preset: spec.agentPreset })
    return id
  }
  isArchived() { return false }
  rename() {}
  async deliver(agent: FakeAgent, text: string) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, text: string) { agent.inbox.push(`(inject) ${text}`) }
  steer(agent: FakeAgent, text: string) { agent.inbox.push(`(steer) ${text}`) }
  selectModel(agent: FakeAgent, choice: ModelChoice) { agent.models.push(choice) }
  isBusy(agent: FakeAgent) { return this.busy.has(agent.id) }
}

const owner: PublishedChannel = { platform: 'demo', account: 'owner', kind: 'private', id: 'owner', display: 'Owner (demo)', isOwner: true }
const ownerKey = 'demo:owner:private:owner'

async function setup(start: string, config: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-auto-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, ...config })
  const clock = { now: at(start) }
  ctx.anima.setClock(() => clock.now)
  // A stand-in for the outside: it refuses what a test tells it to, and keeps what she reports.
  const outside: { refuse: (request: AdmitRequest) => AdmitRefusal | undefined } = { refuse: () => undefined }
  ctx.on('anima/admit', request => outside.refuse(request))
  const recorded: { type: string }[] = []
  ctx.on('anima/record', (record) => { recorded.push(record) })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner]) } })
  // A stand-in say behavior for the local platform.
  ctx.anima.registerBehavior((await import('@deepseek-ai/dsh-tools')).defineTool({
    name: 'demo_say', description: 'say', parameters: { text: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute() { return { ok: true } },
  }), { platform: 'demo', effect: 'express', sessions: ['conversation'], closes: args => args.more !== true })
  return { ctx, host, clock, outside, recorded }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`c${++calls}`), name, arguments: args, agent, toolSet, signal })
    const block = result.content[0] as { text?: string } | undefined
    return { isError: result.isError, text: block?.text ?? '' }
  } finally {
    toolSet.dispose()
  }
}

function event(ctx: Context, sessionId: string, type: string, data: unknown) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

describe('heartbeat loop', () => {
  it('delivers the report to the day’s triage session on the triage model', async () => {
    const { ctx, host } = await setup('2026-11-10T10:00')
    await ctx.animaLife.beat()
    const triage = host.sessions.get(triageSessionId('anima', '2026-11-10'))!
    expect(triage.preset).toBe('anima-triage')
    expect(triage.models).toEqual([{ provider: 'deepseek-official', model: 'deepseek-flash' }])
    expect(triage.inbox[0]).toMatch(/^\[Tue 2026-11-10 10:00\] \[心跳\]\nTime Tue 2026-11-10 10:00; phase day\./)
    expect(triage.inbox[0]).toContain('channel "demo:owner:private:owner"; you may start a conversation')
    expect(triage.inbox[0]).toContain('heartbeat_act(reason)')
    expect(ctx.anima.describeSession(triage.id)).toEqual({ kind: 'triage' })
  })

  it('rest only ends the turn: her heart keeps its own rhythm', async () => {
    const { ctx } = await setup('2026-11-10T10:00')
    await ctx.animaLife.beat()
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T11:00'))
    const triageId = triageSessionId('anima', '2026-11-10')
    expect(await callAs(ctx, triageId, 'rest')).toEqual({ isError: false, text: 'Resting.' })
    // Whatever she passes, rest moves nothing in her body.
    await callAs(ctx, triageId, 'rest', { until: '10:05' })
    await callAs(ctx, triageId, 'rest', { note: 'tired' })
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T11:00'))
  })

  it('escalates to Self on the action model, then hands an intent to the owner conversation', async () => {
    const { ctx, host } = await setup('2026-11-10T08:00')
    await ctx.animaLife.beat()
    const triageId = triageSessionId('anima', '2026-11-10')
    expect((await callAs(ctx, triageId, 'heartbeat_act', { reason: 'say good morning to Sam' })).isError).toBe(false)
    const selfId = selfSessionId('anima')
    await vi.waitFor(() => expect(host.sessions.get(selfId)?.inbox).toHaveLength(1))
    const self = host.sessions.get(selfId)!
    expect(self.models).toEqual([{ provider: 'deepseek-official', model: 'deepseek-flash' }])
    expect(self.inbox[0]).toContain('You woke up wanting to: say good morning to Sam')

    // Self may not call platform say directly, but can open a conversation.
    expect((await callAs(ctx, selfId, 'demo_say', { text: 'hi' })).isError).toBe(true)
    const opened = await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'wish him a good morning' })
    expect(opened).toEqual({ isError: false, text: 'Intent i1 handed to the conversation. Its outcome will arrive here as a notice.' })
    const chatId = conversationSessionId('anima', ownerKey)
    expect(host.sessions.get(chatId)!.inbox[0]).toMatch(/^\[Tue 2026-11-10 08:00\] \[来自 Self 的意图\]（i1）你在自己的内心决定来 demo 私聊「Owner」 开口。对方没有发消息给你。\n你想要的：wish him a good morning\nSelf 会知道结果。\n在这里回应：用 demo_say 说话/)

    // The conversation declines; Self hears about it without waking.
    event(ctx, chatId, 'user/message', { source: { kind: 'anima-stimulus', stimulus: 'intent', ref: 'i1' }, content: [] })
    event(ctx, chatId, 'tool/call', { callId: 'x1', name: 'end_turn', arguments: '{"reason":"too early"}' })
    expect((await callAs(ctx, chatId, 'end_turn', { reason: 'too early' })).isError).toBe(false)
    event(ctx, chatId, 'tool/result', { message: { toolCallId: 'x1', isError: false, content: [] } })
    await vi.waitFor(() => expect(self.inbox).toHaveLength(2))
    expect(self.inbox[1]).toBe('(inject) [Tue 2026-11-10 08:00] [notice] Your intent i1 for Owner (demo) ("wish him a good morning"): declined — you chose not to speak there: too early.')

    // The next heartbeat report shows it.
    expect((await callAs(ctx, selfId, 'rest')).text).toBe('Resting.')
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageId)!.inbox[1]).toContain('declined — you chose not to speak there: too early.')
  })

  it('cannot start a conversation while asleep (her body), however many she started', async () => {
    const { ctx, clock } = await setup('2026-11-10T09:00')
    const selfId = selfSessionId('anima')
    await ctx.animaLife.router.ensureSelf()
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'a' })).isError).toBe(false)
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'b' })).isError).toBe(false)
    clock.now = at('2026-11-11T02:00')
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'c' })).text).toMatch(/^Error: anima\/night: /)
  })

  it('beats on while she sleeps, without waking her', async () => {
    const { ctx, host, clock } = await setup('2026-11-11T02:00')
    await ctx.animaLife.beat()
    expect(host.sessions.size).toBe(0)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-11T03:00'))
    clock.now = at('2026-11-11T03:00')
    await ctx.animaLife.beat()
    expect(host.sessions.size).toBe(0)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-11T04:00'))
  })

  it('beats at her resting rhythm whatever the outside says; a beat while she is in a turn starts no second one', async () => {
    const { ctx, host, clock, outside } = await setup('2026-11-10T10:00')
    const asked: AdmitRequest[] = []
    // The outside refuses everything it is asked; her heart is never among the things it is asked about.
    outside.refuse = (request) => { asked.push(request); return { code: 'anima/paused', reason: 'paused' } }
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageSessionId('anima', '2026-11-10'))!.inbox).toHaveLength(1)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T11:00'))
    expect(asked.map(request => request.kind as string)).not.toContain('turn')

    outside.refuse = () => undefined
    host.busy.add(triageSessionId('anima', '2026-11-10'))
    clock.now = at('2026-11-10T11:00')
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageSessionId('anima', '2026-11-10'))!.inbox).toHaveLength(1)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T12:00'))
  })

  it('keeps her rhythm when an escalated Self turn ends without rest', async () => {
    const { ctx, host } = await setup('2026-11-10T10:00')
    await ctx.animaLife.beat()
    await callAs(ctx, triageSessionId('anima', '2026-11-10'), 'heartbeat_act', { reason: 'look around' })
    await vi.waitFor(() => expect(host.sessions.get(selfSessionId('anima'))?.inbox).toHaveLength(1))
    event(ctx, selfSessionId('anima'), 'turn/end', { turn: 1, reason: 'completed' })
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T11:00'))
  })

  it('records alarms from DSH schedule as events for the next report', async () => {
    const { ctx, host } = await setup('2026-11-10T10:00')
    await ctx.animaLife.router.ensureSelf()
    event(ctx, selfSessionId('anima'), 'user/message', { source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nreminder_prompt_json: "ask about the exam"' }] })
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageSessionId('anima', '2026-11-10'))!.inbox[0]).toContain('An alarm you set rang: "ask about the exam".')
  })
})

describe('alarmPrompts', () => {
  it('reads single and batch schedule deliveries', () => {
    expect(alarmPrompts('[SCHEDULE REMINDER]\nreminder_prompt_json: "ask"')).toEqual(['ask'])
    expect(alarmPrompts('[SCHEDULE REMINDER BATCH]\nreminders_json: [{"schedule_id":"s","reminder_prompt":"think about the evening"},{"reminder_prompt":"b"}]')).toEqual(['think about the evening', 'b'])
    expect(alarmPrompts('nothing')).toEqual([])
  })
})

describe('plain text is her thinking', () => {
  it('a turn that ends with only text has nothing steered into it and nothing recorded', async () => {
    const env = await setup('2026-11-10T12:00')
    const id = await env.ctx.animaLife.deliver({ type: 'message', channel: owner, sender: { platformUserId: 'owner', displayName: 'Sam', isOwner: true }, text: '在吗', ts: env.clock.now })
    const agent = env.host.sessions.get(id)!
    const before = agent.inbox.length
    event(env.ctx, id, 'user/message', { source: { kind: 'anima-stimulus', stimulus: 'message', wake: true }, content: [] })
    event(env.ctx, id, 'assistant/message', { message: { content: [{ type: 'text', text: '嗯……先不回了' }] } })
    env.ctx.emit('agent/turn-stopping' as never, { agent, turn: 1, signal: new AbortController().signal } as never)
    event(env.ctx, id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(agent.inbox.length).toBe(before)
    expect(env.recorded.filter(r => r.type === 'reminder' || r.type === 'lost-reply')).toEqual([])
  })
})

describe('reach from outside', () => {
  const bob: PublishedChannel = { platform: 'demo', account: 'owner', kind: 'private', id: 'bob', display: 'Bob (demo)' }
  const fromBob = (ts: number) => ({ type: 'message' as const, channel: bob, sender: { platformUserId: 'bob', displayName: 'Bob', isOwner: false }, text: 'hi', ts })

  it('a chat the outside drops never reaches her, is not held and leaves no record', async () => {
    const { ctx, host, clock, outside } = await setup('2026-11-10T12:00')
    outside.refuse = request => request.kind === 'reach' && request.channelKey === 'demo:owner:private:bob'
      ? { code: 'anima/not-allowlisted', reason: 'not-allowlisted', drop: true }
      : undefined
    const seen: unknown[] = []
    ctx.on('anima/stimulus', event => { seen.push(event) })
    await ctx.animaLife.deliver(fromBob(clock.now))
    expect(host.sessions.size).toBe(0)
    expect(ctx.animaLife.inbox.size()).toBe(0)
    expect(seen).toEqual([])
    // The owner's chat still reaches her.
    await ctx.animaLife.deliver({ type: 'message', channel: owner, sender: { platformUserId: 'owner', displayName: 'Sam', isOwner: true }, text: '在吗', ts: clock.now })
    expect(host.sessions.size).toBe(1)
  })

  it('a refusal without drop (a pause) holds the message in her inbox', async () => {
    const { ctx, host, clock, outside } = await setup('2026-11-10T12:00')
    outside.refuse = request => request.kind === 'reach' && request.channelKey === undefined ? { code: 'anima/paused', reason: 'paused' } : undefined
    await ctx.animaLife.deliver(fromBob(clock.now))
    expect(host.sessions.size).toBe(0)
    expect(ctx.animaLife.inbox.size()).toBe(1)
  })
})
