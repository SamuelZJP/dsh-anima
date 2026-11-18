import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as animaCore from '@anima/core'
import * as animaMemory from '@anima/memory'
import { AnimaLife, conversationSessionId, groupTriageSessionId, selfSessionId, triageSessionId, type ModelChoice, type PublishedChannel, type SessionHost } from '@anima/life'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as animaGuard from '../src/index.ts'
import { Outbox } from '../src/index.ts'
import { callAs, invoke, textOf } from './helpers.ts'

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
const owner: PublishedChannel = { platform: 'demo', account: 'owner', kind: 'private', id: 'owner', display: 'Owner (demo)', isOwner: true }
const ownerKey = 'demo:owner:private:owner'
const ownerSession = conversationSessionId('anima', ownerKey)
const bob = { platformUserId: '2001', displayName: 'Bob', isOwner: false }
const triageSession = groupTriageSessionId('anima', '2026-11-10')

async function setup(guard: Partial<animaGuard.Config> = {}, start = '2026-11-10T10:00') {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-guard-life-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir })
  const clock = { now: new Date(start).getTime() }
  ctx.anima.setClock(() => clock.now)
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 }, groupTriage: { windowSeconds: 0.05, maxBatch: 3, timeoutSeconds: 0.3 } } })
  // The QQ test chats are on the allowlist; the allowlist itself is tested in allowlist.spec.ts.
  await ctx.plugin(animaGuard, { outbox: { delaySeconds: 0.2, notifyOwner: false, offlineHoldMinutes: 30 }, allowlist: { qq: { open: true, users: [], groups: [] } }, ...guard })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner, group]) } })
  const sent: string[] = []
  ctx.anima.registerBehavior(defineTool({
    name: 'demo_say', description: 'say', parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute(args) { sent.push(args.text); return { ok: true } },
  }), { platform: 'demo', effect: 'express', sessions: ['conversation'] })
  return { ctx, host, clock, sent }
}

function event(ctx: Context, sessionId: string, type: string, data: unknown) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

function chatter(ctx: Context, text: string) {
  return ctx.animaLife.deliver({ type: 'message', channel: group, sender: bob, text, ts: ctx.anima.clock.now() })
}

describe('outbox: a message she started waits outside the persona', () => {
  it('holds only messages that answer an intent, and the owner can cancel them', async () => {
    const { ctx, sent } = await setup()
    // An ordinary reply goes out at once.
    expect((await callAs(ctx, ownerSession, 'demo_say', { text: 'reply' })).isError).toBe(false)
    expect(sent).toEqual(['reply'])

    expect((await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: ownerKey, intent: 'say hi' })).isError).toBe(false)
    event(ctx, ownerSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i1' } })
    const held = callAs(ctx, ownerSession, 'demo_say', { text: 'good morning!' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()).toHaveLength(1))
    expect((await invoke(ctx, 'outbox')).text).toContain('o1 → Owner (demo)')
    expect(sent).toEqual(['reply'])
    expect((await held).isError).toBe(false)
    expect(sent).toEqual(['reply', 'good morning!'])

    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: ownerKey, intent: 'again' })
    event(ctx, ownerSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i2' } })
    const cancelled = callAs(ctx, ownerSession, 'demo_say', { text: 'second' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()).toHaveLength(1))
    expect(ctx.bail('anima/owner-message', 'cancel o2')).toBe('Cancelled o2; it will not be sent.')
    const result = await cancelled
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('anima/outbox-cancelled')
    expect(sent).toEqual(['reply', 'good morning!'])
  })

  it('cancels when paused during the wait, and notifies the owner for other channels', async () => {
    const { ctx, sent } = await setup({ outbox: { delaySeconds: 0.2, notifyOwner: true, offlineHoldMinutes: 30 }, initiate: { perDay: 3, quietHours: [], consent: { owner: true, channels: [groupKey] } } })
    ctx.anima.registerBehavior(defineTool({
      name: 'qq_say', description: 'say', parameters: { text: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
      async execute(args) { sent.push(args.text); return { ok: true } },
    }), { platform: 'qq', effect: 'express', sessions: ['conversation'] })
    const lines: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test', send: async (text) => { lines.push(text) } })
    const typing: string[] = []
    ctx.on('anima/outgoing-held', held => { typing.push(held.channelKey) })
    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: groupKey, intent: 'hello group' })
    event(ctx, groupSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i1' } })
    const held = callAs(ctx, groupSession, 'qq_say', { text: 'hi everyone' })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines[0]).toContain('[Anima outbox o1] In 0.2 s she sends to Test group: "hi everyone". Reply "cancel o1"')
    expect(typing).toEqual([groupKey])
    await invoke(ctx, 'pause')
    expect(textOf(await held)).toContain('anima/outbox-cancelled')
    expect(sent).toEqual([])
  })

  it('tells her intent arrival about the hold, and her report about the budgets', async () => {
    const { ctx, host } = await setup()
    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: ownerKey, intent: 'wish him a good morning' })
    expect(host.sessions.get(ownerSession)!.inbox[0]).toContain('你发出的消息会先在发件箱里等 0.2 秒，主人在这期间可以取消。')
    expect(ctx.animaGuard.todayCounts().initiates).toBe(1)
    await ctx.animaLife.beat()
    expect(host.sessions.get(triageSessionId('anima', '2026-11-10'))!.inbox[0]).toContain('conversations you may still start today: 2 of 3')
  })
})

describe('outbox through a disconnect', () => {
  it('holds her message while its platform is offline and sends it when the platform is back', async () => {
    const { ctx, sent } = await setup({ outbox: { delaySeconds: 0.05, notifyOwner: false, offlineHoldMinutes: 1 } })
    await callAs(ctx, selfSessionId('anima'), 'open_conversation', { channel: ownerKey, intent: 'hi' })
    event(ctx, ownerSession, 'user/message', { source: { kind: 'anima-stimulus', ref: 'i1' } })
    ctx.animaLife.platformStatus('demo', false, 'test drop')
    const said = callAs(ctx, ownerSession, 'demo_say', { text: 'still here' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()[0]?.offlineSince).toBeDefined())
    expect(sent).toEqual([])
    ctx.animaLife.platformStatus('demo', true)
    expect((await said).isError).toBe(false)
    expect(sent).toEqual(['still here'])
  })
})

describe('outbox unit', () => {
  it('sends at once with a zero delay', async () => {
    const outbox = new Outbox(() => 1, 0)
    expect(await outbox.hold({ sessionId: 's', channelKey: 'k', display: 'd', text: 't', intentId: 'i1' })).toBe('send')
  })

  it('waits past the delay while offline, then sends on release', async () => {
    let online = false
    const outbox = new Outbox(() => 1, 10, 60_000)
    const held = outbox.hold({ sessionId: 's', channelKey: 'qq:1:private:2', display: 'd', text: 't', intentId: 'i1' }, { online: () => online })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(outbox.list()[0]?.offlineSince).toBeDefined()
    expect(outbox.release('demo')).toBe(0)
    online = true
    expect(outbox.release('qq')).toBe(1)
    expect(await held).toBe('send')
  })

  it('expires after the offline hold, and holds even with a zero delay', async () => {
    const outbox = new Outbox(() => 1, 0, 20)
    const held = outbox.hold({ sessionId: 's', channelKey: 'qq:1:private:2', display: 'd', text: 't', intentId: 'i1' }, { online: () => false })
    expect(outbox.list()).toHaveLength(1)
    expect(await held).toBe('expired')
    expect(outbox.counts.expired).toBe(1)
  })
})

describe('pause and quotas reach her life loop through anima/admit', () => {
  it('holds messages in her inbox while paused, and wakes Self on resume', async () => {
    const { ctx, host } = await setup()
    await invoke(ctx, 'pause')
    await ctx.animaLife.deliver({ type: 'message', channel: owner, sender: { platformUserId: 'owner', displayName: 'Sam', isOwner: true }, text: 'hi', ts: ctx.anima.clock.now() })
    expect(host.sessions.has(ownerSession)).toBe(false)
    expect(ctx.animaLife.inbox.peek(ownerKey)).toEqual([expect.objectContaining({ text: 'hi', reason: 'paused' })])
    expect((await invoke(ctx, 'inbox')).text).toContain('[paused]: hi')
    await invoke(ctx, 'resume')
    await vi.waitFor(() => expect(host.sessions.get(selfSessionId('anima'))?.inbox.length).toBe(1))
    expect(host.sessions.get(selfSessionId('anima'))!.inbox[0]).toContain('[继续] 主人让你继续了。')
  })

  it('caps triage wakes per group', async () => {
    const { ctx, host } = await setup({ quotas: [{ behavior: 'group_wake', per: 'channel', limit: 1, windowMinutes: 60 }] })
    await chatter(ctx, 'one')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(1))
    expect((await callAs(ctx, triageSession, 'group_wake', { batch: 'b1', reason: 'r' })).isError).toBe(false)
    await chatter(ctx, 'two')
    await vi.waitFor(() => expect(host.sessions.get(triageSession)?.inbox.length).toBe(2))
    expect(textOf(await callAs(ctx, triageSession, 'group_wake', { batch: 'b2', reason: 'r' }))).toContain('anima/over-quota')
    expect(ctx.animaLife.triage.batch('b2')?.decision).toBeUndefined()
  })

  it('refuses a second conversation past the daily limit', async () => {
    const { ctx } = await setup({ initiate: { perDay: 1, quietHours: [], consent: { owner: true, channels: [] } } })
    const selfId = selfSessionId('anima')
    expect((await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'a' })).isError).toBe(false)
    expect(textOf(await callAs(ctx, selfId, 'open_conversation', { channel: ownerKey, intent: 'b' }))).toMatch(/^Error: anima\/over-quota: /)
  })
})

describe('/anima self', () => {
  it('delivers owner text to the Self session, naming the channels she can reach', async () => {
    const { ctx, host } = await setup()
    expect(await invoke(ctx, 'self how are you?')).toMatchObject({ kind: 'success' })
    expect(host.sessions.get(selfSessionId('anima'))!.inbox[0]).toContain('The owner says: how are you?\nChannels you can reach: Owner (demo): "demo:owner:private:owner"; Test group: "qq:10:group:42".')
  })
})

describe('memory management from outside', () => {
  it('lets the owner list and delete memories of every scope, and goes away with the memory plugin', async () => {
    const { ctx } = await setup()
    const fiber = await ctx.plugin(animaMemory, {})
    ctx.animaMemory.store.remember({ kind: 'fact', scope: 'private:test:alice', text: 'Alice likes tea.', now: ctx.anima.clock.now() })
    expect(await invoke(ctx, 'memory list')).toMatchObject({ kind: 'success', text: expect.stringContaining('Alice likes tea.') })
    expect(await invoke(ctx, 'memory forget m1')).toMatchObject({ kind: 'success', text: 'Deleted m1.' })
    expect(await invoke(ctx, 'memory list')).toMatchObject({ text: 'No memories.' })
    await fiber.dispose()
    expect(await invoke(ctx, 'memory list')).toMatchObject({ kind: 'error' })
    await expect(ctx.animaGuard.ownerView('memory')).rejects.toThrow(/anima\/unknown-view/)
  })
})
