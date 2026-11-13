import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { formatLocal, resolveRhythm } from '@anima/core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { alarmPrompts, AnimaLife, buildReport, conversationSessionId, IntentTracker, nextHeartbeat, selfSessionId, triageSessionId } from '../src/index.ts'
import type { ModelChoice, PublishedChannel, SessionHost } from '../src/index.ts'

const at = (text: string) => new Date(text).getTime()
const rhythm = resolveRhythm({ wake: '07:30', sleep: '23:30', wakingMinutes: 60, evening: '18:00', windDownMinutes: 60 })
const bounds = { rhythm, minMinutes: 20, maxMinutes: 240, defaultMinutes: 60 }

describe('nextHeartbeat', () => {
  const noon = at('2026-11-10T12:00')

  it('takes her time when it is within bounds', () => {
    expect(nextHeartbeat({ ...bounds, now: noon, requested: at('2026-11-10T13:30'), nightWakesLeft: 1 })).toEqual({ at: at('2026-11-10T13:30'), nightWake: false })
  })

  it('clamps to the minimum and maximum interval', () => {
    const early = nextHeartbeat({ ...bounds, now: noon, requested: noon + 5 * 60_000, nightWakesLeft: 1 })
    expect(early.at).toBe(noon + 20 * 60_000)
    expect(early.adjusted).toContain('earliest')
    const late = nextHeartbeat({ ...bounds, now: noon, requested: at('2026-11-10T20:00'), nightWakesLeft: 1 })
    expect(late.at).toBe(noon + 240 * 60_000)
    expect(late.adjusted).toContain('latest')
  })

  it('uses the default interval when she gives none', () => {
    expect(nextHeartbeat({ ...bounds, now: noon, nightWakesLeft: 1 }).at).toBe(noon + 60 * 60_000)
  })

  it('moves a heartbeat that falls into the night to the next wake', () => {
    const next = nextHeartbeat({ ...bounds, now: at('2026-11-10T23:00'), nightWakesLeft: 1 })
    expect(formatLocal(next.at)).toBe('2026-11-11 07:30')
    expect(next.nightWake).toBe(false)
    const asked = nextHeartbeat({ ...bounds, now: at('2026-11-10T22:00'), requested: at('2026-11-11T08:00'), nightWakesLeft: 1 })
    expect(formatLocal(asked.at)).toBe('2026-11-11 07:30')
  })

  it('allows one night wake-up she asks for, then sleeps until wake', () => {
    const night = nextHeartbeat({ ...bounds, now: at('2026-11-10T23:00'), requested: at('2026-11-11T03:00'), nightWakesLeft: 1 })
    expect(night).toEqual({ at: at('2026-11-11T03:00'), nightWake: true })
    const none = nextHeartbeat({ ...bounds, now: at('2026-11-11T03:00'), requested: at('2026-11-11T05:00'), nightWakesLeft: 0 })
    expect(formatLocal(none.at)).toBe('2026-11-11 07:30')
    expect(none.adjusted).toContain('no night wake-up is left')
  })

  it('keeps every daytime heartbeat within bounds', () => {
    for (let minute = 8 * 60 + 30; minute < 19 * 60; minute += 37) {
      const now = at('2026-11-10T00:00') + minute * 60_000
      for (const offset of [-30, 0, 1, 19, 20, 100, 240, 241, 900]) {
        const next = nextHeartbeat({ ...bounds, now, requested: now + offset * 60_000, nightWakesLeft: 1 })
        expect(next.at - now).toBeGreaterThanOrEqual(20 * 60_000)
        expect(next.at - now).toBeLessThanOrEqual(240 * 60_000)
      }
    }
  })
})

describe('IntentTracker', () => {
  const intent = { id: 'i1', sessionId: 'c1', channelKey: 'local:owner:private:owner', display: 'Owner (local)', intent: 'say hi', at: 0 }
  const isSay = (name: string) => name === 'local_say'

  function claimed() {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, isSay)
    tracker.open(intent)
    tracker.onUserMessage('c1', 'i1')
    return tracker
  }

  it('reports sent, then replied on the next owner message', () => {
    const tracker = claimed()
    tracker.onToolCall('c1', 'a', 'local_say')
    expect(tracker.onToolResult('c1', 'a', false)).toMatchObject({ kind: 'sent' })
    expect(tracker.onTurnEnd('c1')).toBeUndefined()
    expect(tracker.onOwnerMessage('local:owner:private:owner')).toMatchObject({ kind: 'replied' })
    expect(tracker.onOwnerMessage('local:owner:private:owner')).toBeUndefined()
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
    tracker.onToolCall('c1', 'a', 'local_say')
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
      channels: [{ key: 'local:owner:private:owner', display: 'Owner (local)', mayInitiate: true, lastContact: now - 3 * 3_600_000 }],
      now,
    })
    expect(text).toContain('Time Tue 2026-11-10 12:00; phase day.')
    expect(text).toContain('Since your last heartbeat: nothing new')
    expect(text).toContain('  g1 [owner] ask about the exam')
    expect(text).toContain('Owner (local) — channel "local:owner:private:owner"; you may start a conversation; last message 3 h ago')
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

const owner: PublishedChannel = { platform: 'local', account: 'owner', kind: 'private', id: 'owner', display: 'Owner (local)', isOwner: true }
const ownerKey = 'local:owner:private:owner'

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
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner]) } })
  // A stand-in say behavior for the local platform.
  ctx.anima.registerBehavior((await import('@deepseek-ai/dsh-tools')).defineTool({
    name: 'local_say', description: 'say', parameters: { text: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute() { return { ok: true } },
  }), { platform: 'local', effect: 'express', sessions: ['conversation'], closes: args => args.more !== true })
  return { ctx, host, clock }
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
    expect(triage.inbox[0]).toContain('channel "local:owner:private:owner"; you may start a conversation')
    expect(triage.inbox[0]).toContain('heartbeat_act(reason)')
    expect(ctx.anima.describeSession(triage.id)).toEqual({ kind: 'triage' })
  })

  it('rest schedules the next heartbeat within bounds and ends the turn', async () => {
    const { ctx } = await setup('2026-11-10T10:00')
    await ctx.animaLife.beat()
    const triageId = triageSessionId('anima', '2026-11-10')
    const result = await callAs(ctx, triageId, 'rest', { until: '10:05' })
    expect(result.text).toBe('Resting. Next heartbeat 2026-11-10 10:20 (moved to the earliest allowed, 20 min from now).')
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T10:20'))
    expect((await callAs(ctx, triageId, 'rest', { until: 'later' })).text).toMatch(/anima\/bad-time/)
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
    expect((await callAs(ctx, selfId, 'local_say', { text: 'hi' })).isError).toBe(true)
    const opened = await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'wish him a good morning' })
    expect(opened).toEqual({ isError: false, text: 'Intent i1 handed to the conversation. Its outcome will arrive here as a notice.' })
    const chatId = conversationSessionId('anima', ownerKey)
    expect(host.sessions.get(chatId)!.inbox[0]).toMatch(/^\[Tue 2026-11-10 08:00\] \[来自 Self 的意图\]（i1）你在自己的内心决定来 本地 私聊「Owner」 开口。对方没有发消息给你。\n你想要的：wish him a good morning\n你发出的消息会先在发件箱里等 45 秒，主人在这期间可以取消。Self 会知道结果。\n在这里回应：用 local_say 说话/)
    expect(ctx.anima.todayLedger().initiates).toBe(1)

    // The conversation declines; Self hears about it without waking.
    event(ctx, chatId, 'user/message', { source: { kind: 'anima-stimulus', stimulus: 'intent', ref: 'i1' }, content: [] })
    event(ctx, chatId, 'tool/call', { callId: 'x1', name: 'end_turn', arguments: '{"reason":"too early"}' })
    expect((await callAs(ctx, chatId, 'end_turn', { reason: 'too early' })).isError).toBe(false)
    event(ctx, chatId, 'tool/result', { message: { toolCallId: 'x1', isError: false, content: [] } })
    await vi.waitFor(() => expect(self.inbox).toHaveLength(2))
    expect(self.inbox[1]).toBe('(inject) [Tue 2026-11-10 08:00] [notice] Your intent i1 for Owner (local) ("wish him a good morning"): declined — you chose not to speak there: too early.')

    // The decline still counts; the next heartbeat report shows it.
    expect(ctx.anima.todayLedger().initiates).toBe(1)
    expect((await callAs(ctx, selfId, 'rest', { until: '09:30' })).text).toBe('Resting. Next heartbeat 2026-11-10 09:30.')
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageId)!.inbox[1]).toContain('declined — you chose not to speak there: too early.')
    expect(host.sessions.get(triageId)!.inbox[1]).toContain('conversations you may still start today: 2 of 3')
  })

  it('refuses initiating at night and more than the daily budget', async () => {
    const { ctx, clock } = await setup('2026-11-10T09:00', { initiate: { perDay: 1 } })
    const selfId = selfSessionId('anima')
    await ctx.animaLife.router.ensureSelf()
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'a' })).isError).toBe(false)
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'b' })).text).toMatch(/^Error: anima\/over-quota: /)
    clock.now = at('2026-11-11T02:00')
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'c' })).text).toMatch(/^Error: anima\/night: /)
  })

  it('wakes at most once a night, and only to rest', async () => {
    const { ctx, host, clock } = await setup('2026-11-11T02:00')
    await ctx.animaLife.beat()
    const triageId = triageSessionId('anima', '2026-11-10')
    const triage = host.sessions.get(triageId)!
    expect(triage.inbox[0]).toContain('You are asleep. Call rest(until?)')
    expect((await callAs(ctx, triageId, 'heartbeat_act', { reason: 'x' })).text).toMatch(/^Error: anima\/night: /)
    expect((await callAs(ctx, triageId, 'rest', { until: '04:00' })).text).toBe('Resting. Next heartbeat 2026-11-11 07:30 (no night wake-up is left; you sleep until your wake time).')
    clock.now = at('2026-11-11T04:00')
    await ctx.animaLife.beat()
    expect(triage.inbox).toHaveLength(1)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-11T07:30'))
  })

  it('skips heartbeats while paused, busy, or over the token budget', async () => {
    const { ctx, host, clock } = await setup('2026-11-10T10:00', { modes: { day: { tokenBudget: 100 } } })
    const invoke = (rawInput: string) => ctx.anima.dispatchCommand({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal } as never)
    await invoke('pause')
    await ctx.animaLife.beat()
    expect(host.sessions.size).toBe(0)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T10:20'))
    await invoke('resume')

    await ctx.animaLife.router.ensureSelf()
    host.busy.add(selfSessionId('anima'))
    await ctx.animaLife.beat()
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-10T10:01'))
    host.busy.clear()

    event(ctx, selfSessionId('anima'), 'assistant/message', { usage: { inputTokens: 100, outputTokens: 0 } })
    clock.now = at('2026-11-10T11:00')
    await ctx.animaLife.beat()
    expect(host.sessions.has(triageSessionId('anima', '2026-11-10'))).toBe(false)
    expect(ctx.animaLife.nextHeartbeatAt).toBe(at('2026-11-11T07:30'))
  })

  it('schedules the default interval when an escalated Self turn ends without rest', async () => {
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

describe('turn closing (DESIGN §6, Turn shape)', () => {
  const said = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
  const woke = { source: { kind: 'anima-stimulus', stimulus: 'message', wake: true }, content: [] }

  async function chat() {
    const env = await setup('2026-11-10T12:00')
    const id = await env.ctx.animaLife.deliver({ type: 'message', channel: owner, sender: { platformUserId: 'owner', displayName: 'Sam', isOwner: true }, text: '在吗', ts: env.clock.now })
    const agent = env.host.sessions.get(id)!
    const stopping = () => env.ctx.emit('agent/turn-stopping' as never, { agent, turn: 1, signal: new AbortController().signal } as never)
    const records = () => env.ctx.anima.activity.read(env.ctx.anima.dayKey()).filter(r => r.type === 'reminder' || r.type === 'lost-reply')
    return { ...env, id, agent, stopping, records }
  }

  it('says nothing when a say closed the turn', async () => {
    const { ctx, id, agent, stopping, records } = await chat()
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'tool/call', { callId: 'x1', name: 'local_say', arguments: '{"text":"在的"}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'x1', isError: false, content: [] } })
    const before = agent.inbox.length
    stopping()
    expect(agent.inbox.length).toBe(before)
    expect(records()).toEqual([])
  })

  it('steers reminders into the same turn, then records a lost reply and forwards nothing', async () => {
    const { ctx, id, agent, stopping, records } = await chat()
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'assistant/message', said('在的在的，怎么了？'))
    const before = agent.inbox.length
    stopping()
    expect(agent.inbox.at(-1)).toMatch(/^\(steer\) \[Tue 2026-11-10 12:00\] \[提醒 1\/2\] 这一轮还没有用行动结束。你刚才写的「在的在的，怎么了？」/)
    expect(agent.inbox.at(-1)).toContain('调用 local_say')
    expect(agent.inbox.at(-1)).toContain('end_turn')
    stopping()
    expect(agent.inbox.length).toBe(before + 2)
    stopping()
    expect(agent.inbox.length).toBe(before + 2)
    event(ctx, id, 'turn/end', {})
    expect(records()).toEqual([
      expect.objectContaining({ type: 'reminder', count: 1, channel: ownerKey, sessionId: id, text: '在的在的，怎么了？' }),
      expect.objectContaining({ type: 'reminder', count: 2 }),
      expect.objectContaining({ type: 'lost-reply', channel: ownerKey, sessionId: id, text: '在的在的，怎么了？' }),
    ])
    expect(ctx.anima.daySummary().speech).toEqual({ reminders: 2, lostReplies: 1 })
  })

  it('accepts end_turn and a say after a reminder; a failed say does not close', async () => {
    const { ctx, id, agent, stopping, records } = await chat()
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'tool/call', { callId: 'x1', name: 'local_say', arguments: '{"text":"hi"}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'x1', isError: true, content: [] } })
    stopping()
    expect(records()).toHaveLength(1)
    event(ctx, id, 'tool/call', { callId: 'x2', name: 'end_turn', arguments: '{}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'x2', isError: false, content: [] } })
    const before = agent.inbox.length
    stopping()
    expect(agent.inbox.length).toBe(before)
    expect(records()).toHaveLength(1)
  })

  it('records a lost reply when an open turn ends in an error, not when it was aborted or closed', async () => {
    const { ctx, id, records } = await chat()
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'turn/end', { reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'tool input is invalid JSON' } } })
    expect(records()).toEqual([expect.objectContaining({ type: 'lost-reply', channel: ownerKey, reason: 'error: MALFORMED_RESPONSE' })])
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'turn/end', { reason: { kind: 'aborted' } })
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'tool/call', { callId: 'z1', name: 'end_turn', arguments: '{}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'z1', isError: false, content: [] } })
    event(ctx, id, 'turn/end', { reason: { kind: 'error', error: { code: 'X' } } })
    expect(records()).toHaveLength(1)
  })

  it('keeps the turn open after a say with more: true or a gesture, and reopens on a new arrival', async () => {
    const { ctx, id, stopping, records } = await chat()
    event(ctx, id, 'user/message', woke)
    event(ctx, id, 'tool/call', { callId: 'x1', name: 'local_say', arguments: '{"text":"wait","more":true}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'x1', isError: false, content: [] } })
    stopping()
    expect(records()).toHaveLength(1)
    event(ctx, id, 'tool/call', { callId: 'x2', name: 'local_say', arguments: '{"text":"ok"}' })
    event(ctx, id, 'tool/result', { message: { toolCallId: 'x2', isError: false, content: [] } })
    stopping()
    expect(records()).toHaveLength(1)
    // A message that joins the turn after she closed it needs closing again.
    event(ctx, id, 'user/message', woke)
    stopping()
    expect(records()).toHaveLength(2)
    // Context that does not wake never opens a turn.
    event(ctx, id, 'turn/end', {})
    event(ctx, id, 'user/message', { source: { kind: 'anima-stimulus', stimulus: 'channel-event' }, content: [] })
    stopping()
    expect(records()).toHaveLength(2)
  })
})
