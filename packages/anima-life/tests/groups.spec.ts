import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AnimaLife, conversationSessionId, groupTriageSessionId, IntentTracker, Outbox, selfSessionId, type ModelChoice, type PublishedChannel, type SessionHost, type StimulusEvent } from '../src/index.ts'

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
  await ctx.plugin(animaCore, { dataDir, ...core })
  const clock = { now: new Date(start).getTime() }
  ctx.anima.setClock(() => clock.now)
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { groupTriage: { windowSeconds: 0.05, maxBatch: 3, timeoutSeconds: 0.3, ...life.groupTriage as object }, outbox: { delaySeconds: 0.2, ...life.outbox as object } } })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner, group]) } })
  ctx.anima.registerBehavior(defineTool({
    name: 'local_say', description: 'say', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute(args, exec) {
      await ctx.animaLife.holdOutgoing(exec.agent!.id, args.text)
      sent.push(args.text)
      return { ok: true }
    },
  }), { platform: 'local', effect: 'express', sessions: ['conversation'] })
  const sent: string[] = []
  const stimuli: StimulusEvent[] = []
  ctx.on('anima/stimulus', event => { stimuli.push(event) })
  return { ctx, host, clock, sent, stimuli }
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

function command(ctx: Context, input: string) {
  return ctx.anima.dispatchCommand({ rawInput: ` ${input}` } as unknown as CommandInvocation)
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
    expect(triage.inbox[0]).toContain('[group batch b1]')
    expect(triage.inbox[0]).toContain('Bob [qq 2001, msg')
    expect(triage.inbox[0]).toContain('anyone up for hotpot?')
    expect(ctx.anima.describeSession(triageSession)).toEqual({ kind: 'group-triage' })

    const pass = await callAs(ctx, triageSession, 'group_pass', { batch: 'b1', remember: true })
    expect(pass).toMatchObject({ isError: false, text: 'Batch settled: remember.' })
    expect(host.sessions.has(groupSession)).toBe(false)
    expect(stimuli.map(s => s.delivery)).toEqual(['record', 'record'])
    expect(stimuli[0]!.sessionId).toBe(groupSession)
    expect((await callAs(ctx, triageSession, 'group_pass', { batch: 'b1', remember: false })).text).toContain('anima/batch-settled')
    expect(ctx.anima.statusText()).toContain(`${groupKey} today: wakes 0 direct + 0 triage; batches 1 (remember 1, ignore 0, fallback 0)`)
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

  it('wakes at once when she is addressed or the owner speaks, flushing the buffer as context', async () => {
    const { ctx, host } = await setup({ groupTriage: { windowSeconds: 60 } })
    await chatter(ctx, 'chatter')
    await chatter(ctx, '@Anima what do you think?', { addressed: true })
    const inbox = host.sessions.get(groupSession)!.inbox
    expect(inbox).toHaveLength(2)
    expect(inbox[0]).toMatch(/^\(inject\) .*chatter$/)
    expect(inbox[1]).toContain('what do you think?')
    expect(ctx.animaLife.triage.open()).toEqual([])
    await ctx.animaLife.deliver({ type: 'message', channel: group, sender: { platformUserId: '1', displayName: 'Sam', isOwner: true }, text: 'hi all', ts: 0 })
    expect(inbox).toHaveLength(3)
    expect(host.sessions.has(triageSession)).toBe(false)
    expect(ctx.anima.statusText()).toContain('wakes 2 direct + 0 triage')
  })

  it('skips the model at night and while paused: batches are remembered', async () => {
    const { ctx, host } = await setup({}, {}, '2026-11-10T02:00')
    await chatter(ctx, 'late chatter')
    await vi.waitFor(() => expect(ctx.animaLife.triage.batch('b1')).toMatchObject({ decision: 'remember', by: 'skipped' }))
    expect(host.sessions.has(triageSession)).toBe(false)
  })

  it('caps triage wakes per group through the gate', async () => {
    const { ctx, host } = await setup({}, { quotas: [{ behavior: 'group_wake', per: 'channel', limit: 1, windowMinutes: 60 }] })
    await chatter(ctx, 'one')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    expect((await callAs(ctx, triageSession, 'group_wake', { batch: 'b1', reason: 'r' })).isError).toBe(false)
    await chatter(ctx, 'two')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(2))
    const refused = await callAs(ctx, triageSession, 'group_wake', { batch: 'b2', reason: 'r' })
    expect(refused.text).toContain('anima/over-quota')
    expect(ctx.animaLife.triage.batch('b2')?.decision).toBeUndefined()
  })

  it('refuses stimuli for channels off the allowlist', async () => {
    const { ctx } = await setup()
    ctx.anima.restrictChannels('qq', key => key !== groupKey)
    await expect(chatter(ctx, 'hi')).rejects.toThrow('anima/not-allowlisted')
  })

  it('delivers channel events only into existing sessions, without waking', async () => {
    const { ctx, host } = await setup()
    await ctx.animaLife.deliver({ type: 'channel-event', channel: group, text: 'Bob recalled a message (msg 7).', ts: 0 })
    expect(host.sessions.has(groupSession)).toBe(false)
    await chatter(ctx, 'hey Anima', { addressed: true })
    await ctx.animaLife.deliver({ type: 'channel-event', channel: group, text: 'Bob recalled a message (msg 7).', ts: 0 })
    expect(host.sessions.get(groupSession)!.inbox[1]).toMatch(/^\(inject\) .*\[event\] Bob recalled a message/)
  })
})

describe('outbox', () => {
  it('holds only messages that answer an intent, and the owner can cancel them', async () => {
    const { ctx, sent, host } = await setup()
    const ownerSession = conversationSessionId('anima', 'local:owner:private:owner')
    // An ordinary reply goes out at once.
    expect((await callAs(ctx, ownerSession, 'local_say', { text: 'reply' })).isError).toBe(false)
    expect(sent).toEqual(['reply'])

    // Self opens a conversation; the conversation claims the intent.
    expect((await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: 'local:owner:private:owner', intent: 'say hi' })).isError).toBe(false)
    event(ctx, ownerSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i1' } })
    const held = callAs(ctx, ownerSession, 'local_say', { text: 'good morning!' })
    await vi.waitFor(() => expect(ctx.animaLife.outbox.list()).toHaveLength(1))
    expect((await command(ctx, 'outbox')).text).toContain('o1 → Owner (local)')
    expect(sent).toEqual(['reply'])
    expect(await held).toMatchObject({ isError: false })
    expect(sent).toEqual(['reply', 'good morning!'])

    // A second intent, cancelled from the owner line.
    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: 'local:owner:private:owner', intent: 'again' })
    event(ctx, ownerSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i2' } })
    const cancelled = callAs(ctx, ownerSession, 'local_say', { text: 'second' })
    await vi.waitFor(() => expect(ctx.animaLife.outbox.list()).toHaveLength(1))
    expect(ctx.anima.handleOwnerReply('cancel o2')).toBe('Cancelled o2; it will not be sent.')
    const result = await cancelled
    expect(result.isError).toBe(true)
    expect(result.text).toContain('anima/outbox-cancelled')
    expect(sent).toEqual(['reply', 'good morning!'])
    expect(ctx.anima.handleOwnerReply('cancel o2')).toContain('No message o2')
    expect(host.sessions.size).toBeGreaterThan(0)
  })

  it('cancels when paused during the wait, and notifies the owner for other channels', async () => {
    const { ctx, sent } = await setup({ outbox: { notifyOwner: true } }, { initiate: { consent: { owner: true, channels: [groupKey] } } })
    const lines: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test', send: async (text) => { lines.push(text) } })
    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: groupKey, intent: 'hello group' })
    event(ctx, groupSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i1' } })
    const held = ctx.animaLife.holdOutgoing(groupSession, 'hi everyone')
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines[0]).toContain('[Anima outbox o1] In 0.2 s she sends to Test group: "hi everyone". Reply "cancel o1"')
    await command(ctx, 'pause')
    await expect(held).rejects.toThrow('anima/outbox-cancelled')
    expect(sent).toEqual([])
  })

  it('reports a cancelled say as a cancelled intent', () => {
    const tracker = new IntentTracker({ pending: [], active: [], awaitingReply: [] }, name => name === 'local_say')
    tracker.open({ id: 'i1', sessionId: 'c', channelKey: 'k', display: 'Owner', intent: 'hi', at: 0 })
    tracker.onUserMessage('c', 'i1')
    tracker.onToolCall('c', 'x', 'local_say')
    expect(tracker.onToolResult('c', 'x', true, 'Error: anima/outbox-cancelled: …')).toMatchObject({ kind: 'cancelled' })
  })

  it('sends at once with a zero delay', async () => {
    const outbox = new Outbox(() => 1, 0)
    expect(await outbox.hold({ sessionId: 's', channelKey: 'k', display: 'd', text: 't', intentId: 'i1' })).toBe('send')
  })
})
