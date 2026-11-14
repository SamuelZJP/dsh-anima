import { mkdtempSync, rmSync } from 'node:fs'
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
import type { AdmitRefusal, AdmitRequest } from '@anima/core'
import { AnimaLife, conversationSessionId, groupTriageSessionId, describeOutcome, IntentTracker, type ModelChoice, type PublishedChannel, type SessionHost, type StimulusEvent } from '../src/index.ts'

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

const group: PublishedChannel = { platform: 'qq', account: '10', kind: 'group', id: '42', display: 'Test group' }
const groupKey = 'qq:10:group:42'
const groupSession = conversationSessionId('anima', groupKey)
const owner: PublishedChannel = { platform: 'local', account: 'owner', kind: 'private', id: 'owner', display: 'Owner (local)', isOwner: true }
const bob = { platformUserId: '2001', displayName: 'Bob', isOwner: false }
const day = '2026-11-10'
const triageSession = groupTriageSessionId('anima', day)

async function setup(life: Record<string, unknown> = {}, core: Record<string, unknown> = {}, start = '2026-11-10T10:00') {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-groups-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, ...core })
  const clock = { now: new Date(start).getTime() }
  ctx.anima.setClock(() => clock.now)
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0, ...life.conversation as object }, groupTriage: { windowSeconds: 0.05, maxBatch: 3, timeoutSeconds: 0.3, ...life.groupTriage as object } } })
  // A stand-in for the outside: it sees every admission and refuses what a test tells it to.
  const outside: { refuse: (request: AdmitRequest) => AdmitRefusal | undefined } = { refuse: () => undefined }
  const admits: AdmitRequest[] = []
  ctx.on('anima/admit', (request) => { admits.push(request); return outside.refuse(request) })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner, group]) } })
  ctx.anima.registerBehavior(defineTool({
    name: 'local_say', description: 'say', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute(args) {
      sent.push(args.text)
      return { ok: true }
    },
  }), { platform: 'local', effect: 'express', sessions: ['conversation'] })
  const sent: string[] = []
  const stimuli: StimulusEvent[] = []
  ctx.on('anima/stimulus', event => { stimuli.push(event) })
  return { ctx, host, clock, sent, stimuli, outside, admits }
}

let calls = 0
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`g${++calls}`), name, arguments: args, agent, toolSet, signal })
    const block = result.content[0] as { text?: string } | undefined
    return { isError: result.isError, text: block?.text ?? '' }
  } finally {
    toolSet.dispose()
  }
}

function event(ctx: Context, sessionId: string, type: string, data: unknown) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

function chatter(ctx: Context, text: string, extra: Record<string, unknown> = {}) {
  return ctx.animaLife.deliver({ type: 'message', channel: group, sender: bob, text, ts: ctx.anima.clock.now(), messageId: String(++calls), ...extra })
}

describe('group triage', () => {
  it('batches chatter after the window and lets her pass with memory', async () => {
    const { ctx, host, stimuli } = await setup()
    await chatter(ctx, 'anyone up for hotpot?')
    await chatter(ctx, 'me!')
    expect(host.sessions.has(groupSession)).toBe(false)
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    const triage = host.sessions.get(triageSession)!
    expect(triage.preset).toBe('anima-group-triage')
    expect(triage.models[0]).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(triage.inbox[0]).toContain('[群聊批次 b1]')
    expect(triage.inbox[0]).toContain('Bob [qq 2001, msg')
    expect(triage.inbox[0]).toContain('anyone up for hotpot?')
    expect(ctx.anima.describeSession(triageSession)).toEqual({ kind: 'group-triage' })

    const pass = await callAs(ctx, triageSession, 'group_pass', { batch: 'b1', remember: true })
    expect(pass).toMatchObject({ isError: false, text: 'Batch settled: remember.' })
    expect(host.sessions.has(groupSession)).toBe(false)
    expect(stimuli.map(s => s.delivery)).toEqual(['record', 'record'])
    expect(stimuli[0]!.sessionId).toBe(groupSession)
    expect((await callAs(ctx, triageSession, 'group_pass', { batch: 'b1', remember: false })).text).toContain('anima/batch-settled')
    expect(ctx.anima.statusLines().join('\n')).toContain(`${groupKey} today: wakes 0 direct + 0 triage; batches 1 (remember 1, ignore 0, fallback 0)`)
  })

  it('wakes the group with earlier messages as context when she chooses to', async () => {
    const { ctx, host, stimuli } = await setup()
    await chatter(ctx, 'a')
    await chatter(ctx, 'b')
    await chatter(ctx, 'c') // maxBatch 3 closes at once
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    expect((await callAs(ctx, triageSession, 'group_wake', { batch: 'b1', reason: 'hotpot!' })).isError).toBe(false)
    await vi.waitFor(() => expect(host.sessions.get(groupSession)?.inbox.length).toBe(3))
    const inbox = host.sessions.get(groupSession)!.inbox
    expect(inbox[0]).toMatch(/^\(inject\) .*Bob \[qq 2001, msg \d+\]: a$/)
    expect(inbox[1]).toMatch(/^\(inject\) /)
    expect(inbox[2]).not.toMatch(/^\(inject\)/)
    expect(inbox[2]).toContain('（没有人叫你；是你在扫视群聊时决定来看看，你的理由：hotpot!。）')
    expect(stimuli.map(s => s.delivery)).toEqual(['context', 'context', 'wake'])
  })

  it('ignores without recording, and remembers on timeout or turn end', async () => {
    const { ctx, host, stimuli } = await setup()
    await chatter(ctx, 'x')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    await callAs(ctx, triageSession, 'group_pass', { batch: 'b1', remember: false })
    expect(stimuli).toEqual([])

    await chatter(ctx, 'y')
    await vi.waitFor(() => expect(ctx.animaLife.triage.batch('b2')?.decision).toBe('remember'), { timeout: 2000 })
    expect(ctx.animaLife.triage.batch('b2')?.by).toBe('timeout')

    await chatter(ctx, 'z')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(3))
    event(ctx, triageSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'b3' } })
    event(ctx, triageSession, 'turn/end', {})
    expect(ctx.animaLife.triage.batch('b3')).toMatchObject({ decision: 'remember', by: 'turn-end' })
    expect(stimuli.map(s => s.stimulus.type === 'message' ? s.stimulus.text : '')).toEqual(['y', 'z'])
  })

  it('wakes when she is addressed or the owner speaks, with the buffer in the same burst', async () => {
    const { ctx, host } = await setup({ groupTriage: { windowSeconds: 60 } })
    await chatter(ctx, 'chatter')
    await chatter(ctx, '@Anima what do you think?', { addressed: true })
    const inbox = host.sessions.get(groupSession)!.inbox
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatch(/2 条消息（Bob 2 条）：\n.* chatter\n.*叫你: @Anima what do you think\?\n（群里所有人都会看到你的回答。）\n在这里回应/)
    expect(ctx.animaLife.triage.open()).toEqual([])
    await ctx.animaLife.deliver({ type: 'message', channel: group, sender: { platformUserId: '1', displayName: 'Sam', isOwner: true }, text: 'hi all', ts: 0 })
    expect(inbox).toHaveLength(2)
    expect(host.sessions.has(triageSession)).toBe(false)
    expect(ctx.anima.statusLines().join('\n')).toContain('wakes 2 direct + 0 triage')
  })

  it('skips the model at night and while paused: batches are remembered', async () => {
    const { ctx, host } = await setup({}, {}, '2026-11-10T02:00')
    await chatter(ctx, 'late chatter')
    await vi.waitFor(() => expect(ctx.animaLife.triage.batch('b1')).toMatchObject({ decision: 'remember', by: 'skipped' }))
    expect(host.sessions.has(triageSession)).toBe(false)
  })

  it('delivers channel events only into existing sessions, without waking', async () => {
    const { ctx, host } = await setup()
    await ctx.animaLife.deliver({ type: 'channel-event', channel: group, text: 'Bob recalled a message (msg 7).', ts: 0 })
    expect(host.sessions.has(groupSession)).toBe(false)
    await chatter(ctx, 'hey Anima', { addressed: true })
    await ctx.animaLife.deliver({ type: 'channel-event', channel: group, text: 'Bob recalled a message (msg 7).', ts: 0 })
    expect(host.sessions.get(groupSession)!.inbox[1]).toMatch(/^\(inject\) .*\[事件\] Bob recalled a message/)
  })
})

describe('intent outcomes of a held say', () => {
  it('reports a cancelled say as a cancelled intent', () => {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, name => name === 'local_say')
    tracker.open({ id: 'i1', sessionId: 'c', channelKey: 'k', display: 'Owner', intent: 'hi', at: 0 })
    tracker.onUserMessage('c', 'i1')
    tracker.onToolCall('c', 'x', 'local_say')
    expect(tracker.onToolResult('c', 'x', true, 'Error: anima/outbox-cancelled: …')).toMatchObject({ kind: 'cancelled' })
  })

  it('reports an expired say as an expired intent', () => {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, name => name === 'qq_say')
    tracker.open({ id: 'i1', sessionId: 'c', channelKey: 'k', display: 'Owner', intent: 'hi', at: 0 })
    tracker.onUserMessage('c', 'i1')
    tracker.onToolCall('c', 'x', 'qq_say')
    const outcome = tracker.onToolResult('c', 'x', true, 'Error: anima/outbox-expired: …')
    expect(outcome).toMatchObject({ kind: 'expired' })
    expect(describeOutcome(outcome!)).toContain('expired — the platform stayed offline')
  })
})

describe('message timing (DESIGN §6, Phase 8)', () => {
  const sam = { platformUserId: 'owner', displayName: 'Sam', isOwner: true }
  const ownerSession = conversationSessionId('anima', 'local:owner:private:owner')
  const dm = (ctx: Context, text: string) => ctx.animaLife.deliver({ type: 'message', channel: owner, sender: sam, text, ts: ctx.anima.clock.now() })

  async function withQqSay(life: Record<string, unknown> = {}, core: Record<string, unknown> = {}) {
    const env = await setup(life, core)
    env.ctx.anima.registerBehavior(defineTool({
      name: 'qq_say', description: 'say', parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
      async execute() { return { ok: true } },
    }), { platform: 'qq', effect: 'express', sessions: ['conversation'] })
    // She speaks in the group: its attention window opens.
    const spoke = (callId: string) => {
      event(env.ctx, groupSession, 'tool/call', { callId, name: 'qq_say', arguments: '{"text":"hi"}' })
      event(env.ctx, groupSession, 'tool/result', { message: { toolCallId: callId, isError: false, content: [] } })
    }
    const gate = () => env.admits.filter(r => r.kind === 'wake' && r.name === 'group_attention')
    return { ...env, spoke, gate }
  }

  it('waits for a private chat to settle, then wakes once with the whole burst', async () => {
    const { ctx, host, stimuli } = await setup({ conversation: { settleSeconds: 0.08 } })
    expect(await dm(ctx, '在吗')).toBe(ownerSession)
    await new Promise(resolve => setTimeout(resolve, 40))
    await dm(ctx, '问你个事')
    await dm(ctx, '明天有空吗')
    expect(host.sessions.has(ownerSession)).toBe(false)
    await vi.waitFor(() => expect(host.sessions.get(ownerSession)?.inbox.length).toBe(1))
    const inbox = host.sessions.get(ownerSession)!.inbox
    expect(inbox[0]).toMatch(/^\[.*\] \[.*\] Sam（主人）发来 3 条：\n  \d\d:\d\d 在吗\n  \d\d:\d\d 问你个事\n  \d\d:\d\d 明天有空吗\n在这里回应：用 local_say 说话/)
    // The transcript still gets each message on its own.
    expect(stimuli.map(s => [s.stimulus.type, s.delivery])).toEqual([['message', 'context'], ['message', 'context'], ['message', 'wake']])
  })

  it('never delays an intent', async () => {
    const { ctx, host } = await setup({ conversation: { settleSeconds: 30 } })
    const { intentId, sessionId } = await ctx.animaLife.openIntent('local:owner:private:owner', 'say good morning')
    expect(intentId).toBe('i1')
    expect(host.sessions.get(sessionId)!.inbox[0]).toContain('i1')
  })

  it('wakes a group directly in the attention window after she spoke, counted by the gate', async () => {
    const { ctx, host, spoke, gate } = await withQqSay({ conversation: { settleSeconds: 0.03 } })
    spoke('s1')
    await chatter(ctx, '哈哈对')
    await chatter(ctx, '你也去吗')
    await vi.waitFor(() => expect(host.sessions.get(groupSession)?.inbox.length).toBe(1))
    expect(host.sessions.get(groupSession)!.inbox[0]).toMatch(/哈哈对\n.*你也去吗\n（你刚在这个群里说过话，所以这些直接到了你这里。）/)
    expect(host.sessions.has(triageSession)).toBe(false)
    expect(gate()).toEqual([{ kind: 'wake', name: 'group_attention', channelKey: groupKey }])
    expect(ctx.anima.statusLines().join('\n')).toContain(`${groupKey} today: wakes 0 direct + 0 triage + 1 attention;`)
  })

  it('sends chatter to triage when the outside refuses the wake, or the window is off', async () => {
    const { ctx, host, spoke, gate, outside } = await withQqSay({ conversation: { settleSeconds: 0.02 } })
    let wakes = 0
    outside.refuse = request => request.kind === 'wake' && ++wakes > 1 ? { code: 'anima/over-quota', reason: 'over-quota' } : undefined
    spoke('s1')
    await chatter(ctx, 'one')
    await vi.waitFor(() => expect(host.sessions.get(groupSession)?.inbox.length).toBe(1))
    await chatter(ctx, 'two')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    expect(host.sessions.get(triageSession)!.inbox[0]).toContain('two')
    expect(gate()).toHaveLength(2)

    const off = await withQqSay({ groupTriage: { attentionSeconds: 0 } })
    off.spoke('s2')
    await chatter(off.ctx, 'three')
    expect(off.host.sessions.has(groupSession)).toBe(false)
    expect(off.gate()).toEqual([])
  })

  it('an @ in a settling group joins the waiting burst and settles with it', async () => {
    const { ctx, host, spoke, gate } = await withQqSay({ conversation: { settleSeconds: 0.05 } })
    spoke('s1')
    await chatter(ctx, 'first')
    await chatter(ctx, '@her second', { addressed: true })
    expect(host.sessions.has(groupSession)).toBe(false)
    await vi.waitFor(() => expect(host.sessions.get(groupSession)?.inbox.length).toBe(1))
    expect(host.sessions.get(groupSession)!.inbox[0]).toMatch(/first\n.*叫你: @her second\n（群里所有人都会看到你的回答。）\n在这里回应：用 qq_say 说话（群里所有人都看得到）/)
    // An addressed burst needs no attention admission.
    expect(gate()).toEqual([])
  })
})
