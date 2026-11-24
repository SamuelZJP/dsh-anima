import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as animaCore from '@anima/core'
import { SAY_META, SAY_PARAMETERS, sayMessages } from '@anima/core'
import * as animaMemory from '@anima/memory'
import { AnimaLife, type ArchiveResult, type ModelChoice, type PublishedChannel, type SessionHost } from '@anima/life'
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
  readonly sessions = new Map<string, FakeAgent>()
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string) { this.sessions.set(id, { id, inbox: [], models: [] }); return id }
  isArchived() { return false }
  async archive(): Promise<ArchiveResult> { return 'archived' }
  async moveAlarms() { return 0 }
  rename() {}
  async deliver(agent: FakeAgent, { text }: { text: string }) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, { text }: { text: string }) { agent.inbox.push(`(inject) ${text}`) }
  cancel() {}
  async readLog() { return [] }
  selectModel(agent: FakeAgent, choice: ModelChoice) { agent.models.push(choice) }
  /** Every arrival, the waking context excluded. */
  all() { return [...this.sessions.values()].flatMap(agent => agent.inbox).filter(text => !text.includes('[醒来]')) }
}

const owner: PublishedChannel = { platform: 'demo', account: 'me', kind: 'private', id: 'owner', display: 'Sam', isOwner: true }
const ownerKey = 'demo:me:private:owner'
const alice: PublishedChannel = { platform: 'demo', account: 'me', kind: 'private', id: 'alice', display: 'Alice' }
const aliceKey = 'demo:me:private:alice'
const sam = { platformUserId: 'owner', displayName: 'Sam', isOwner: true }
const MIN = 60_000

async function setup(guard: Partial<animaGuard.Config> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-guard-life-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const clock = { now: new Date('2026-11-10T10:00').getTime() }
  ctx.anima.setClock(() => clock.now)
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  await ctx.plugin(animaGuard, {
    outbox: { delaySeconds: 0.2, notifyOwner: false, offlineHoldMinutes: 30 },
    allowlist: { demo: { open: true, users: [], groups: [] } },
    initiate: { replyWindowMinutes: 30, perDay: 3, quietHours: [], consent: { owner: true, channels: [] } },
    ...guard,
  })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner, alice]) } })
  const sent: { channel: string; text: string }[] = []
  ctx.anima.registerBehavior(defineTool({
    name: 'demo_say', description: 'say', parameters: { ...SAY_PARAMETERS },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute(args) { for (const text of sayMessages(args)) sent.push({ channel: args.channel, text }); return { ok: true } },
  }), { platform: 'demo', effect: 'express', sessions: ['waking'], ...SAY_META })
  await new Promise(resolve => setTimeout(resolve, 5))
  return { ctx, host, clock, sent, waking: () => ctx.animaLife.waking.current! }
}

describe('speaking first: a rule outside her, from facts her life reports', () => {
  it('holds a say where nobody wrote to her lately; a reply goes out at once', async () => {
    const { ctx, clock, sent, waking } = await setup()
    // Sam wrote just now: her answer is a reply.
    await ctx.animaLife.deliver({ type: 'message', channel: owner, sender: sam, text: '在吗', ts: clock.now })
    expect(ctx.animaGuard.speakingFirst(ownerKey)).toBe(false)
    expect((await callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: '在的' })).isError).toBe(false)
    expect(sent).toEqual([{ channel: ownerKey, text: '在的' }])
    expect(ctx.animaGuard.outbox.list()).toEqual([])
    expect(ctx.animaGuard.todayCounts().initiates).toBe(0)
    // An hour later, nobody wrote and she did not speak there: a say starts a conversation.
    clock.now += 60 * MIN
    expect(ctx.animaGuard.speakingFirst(ownerKey)).toBe(true)
    const started = callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: '你下班了吗' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()).toHaveLength(1))
    expect(sent).toHaveLength(1)
    expect((await started).isError).toBe(false)
    expect(sent.at(-1)).toEqual({ channel: ownerKey, text: '你下班了吗' })
    expect(ctx.animaGuard.todayCounts().initiates).toBe(1)
    // A second say right after is part of that conversation, not a new one.
    expect(ctx.animaGuard.speakingFirst(ownerKey)).toBe(false)
  })

  it('lets the owner cancel a held message', async () => {
    const { ctx, clock, sent, waking } = await setup({ outbox: { delaySeconds: 5, notifyOwner: false, offlineHoldMinutes: 30 } })
    clock.now += 60 * MIN
    const started = callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: 'hi' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()).toHaveLength(1))
    const id = ctx.animaGuard.outbox.list()[0]!.id
    expect(ctx.bail('anima/owner-message', `cancel ${id}`)).toBe(`Cancelled ${id}; it will not be sent.`)
    expect(textOf(await started)).toMatch(/^Error: anima\/outbox-cancelled: （外面拦住了你/)
    expect(sent).toEqual([])
    expect(ctx.animaGuard.todayCounts().initiates).toBe(0)
  })

  it('needs consent to speak first: only on the owner\'s chats by default', async () => {
    const { ctx, waking, sent } = await setup()
    expect(textOf(await callAs(ctx, waking(), 'demo_say', { channel: aliceKey, text: 'hey' }))).toMatch(/^Error: anima\/no-consent: /)
    // Once Alice wrote, answering her is not speaking first.
    await ctx.animaLife.deliver({ type: 'message', channel: alice, sender: { platformUserId: 'alice', displayName: 'Alice', isOwner: false }, text: 'hey', ts: ctx.anima.clock.now() })
    expect((await callAs(ctx, waking(), 'demo_say', { channel: aliceKey, text: 'hey!' })).isError).toBe(false)
    expect(sent).toEqual([{ channel: aliceKey, text: 'hey!' }])
  })

  it('refuses a conversation past the daily limit', async () => {
    const { ctx, clock, waking } = await setup({ outbox: { delaySeconds: 0, notifyOwner: false, offlineHoldMinutes: 30 }, initiate: { replyWindowMinutes: 30, perDay: 1, quietHours: [], consent: { owner: true, channels: [] } } })
    expect((await callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: 'a' })).isError).toBe(false)
    clock.now += 60 * MIN
    expect(textOf(await callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: 'b' }))).toMatch(/^Error: anima\/over-quota: /)
  })

  it('holds her first message while its platform is offline and sends it when the platform is back', async () => {
    const { ctx, clock, sent, waking } = await setup({ outbox: { delaySeconds: 0.05, notifyOwner: false, offlineHoldMinutes: 30 } })
    clock.now += 60 * MIN
    ctx.animaLife.platformStatus('demo', false, 'test')
    const said = callAs(ctx, waking(), 'demo_say', { channel: ownerKey, text: 'still here' })
    await vi.waitFor(() => expect(ctx.animaGuard.outbox.list()[0]?.offlineSince).toBeDefined())
    expect(sent).toEqual([])
    ctx.animaLife.platformStatus('demo', true)
    expect((await said).isError).toBe(false)
    expect(sent).toEqual([{ channel: ownerKey, text: 'still here' }])
  })
})

describe('outbox unit', () => {
  it('sends at once with a zero delay', async () => {
    const outbox = new Outbox(() => 1, 0)
    expect(await outbox.hold({ sessionId: 's', channelKey: 'k', display: 'd', text: 't' })).toBe('send')
  })

  it('waits past the delay while offline, then sends on release', async () => {
    let online = false
    const outbox = new Outbox(() => 1, 10, 60_000)
    const held = outbox.hold({ sessionId: 's', channelKey: 'qq:1:private:2', display: 'd', text: 't' }, { online: () => online })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(outbox.list()[0]?.offlineSince).toBeDefined()
    expect(outbox.release('demo')).toBe(0)
    online = true
    expect(outbox.release('qq')).toBe(1)
    expect(await held).toBe('send')
  })

  it('expires after the offline hold, and holds even with a zero delay', async () => {
    const outbox = new Outbox(() => 1, 0, 20)
    const held = outbox.hold({ sessionId: 's', channelKey: 'qq:1:private:2', display: 'd', text: 't' }, { online: () => false })
    expect(outbox.list()).toHaveLength(1)
    expect(await held).toBe('expired')
    expect(outbox.counts.expired).toBe(1)
  })
})

describe('pause reaches her life through anima/admit, never her body', () => {
  it('holds messages in her inbox while paused, and tells her on resume', async () => {
    const { ctx, host, clock } = await setup()
    await invoke(ctx, 'pause')
    await ctx.animaLife.deliver({ type: 'message', channel: owner, sender: sam, text: 'hi', ts: clock.now })
    expect(host.all()).toEqual([])
    expect(ctx.animaLife.inbox.peek(ownerKey)).toEqual([expect.objectContaining({ text: 'hi', reason: 'paused' })])
    expect((await invoke(ctx, 'inbox')).text).toContain('[paused]: hi')
    await invoke(ctx, 'resume')
    await vi.waitFor(() => expect(host.all()).toHaveLength(1))
    expect(host.all()[0]).toContain('[通知] 主人让你继续了。收件箱：Sam 1 条')
  })
})

describe('/anima self', () => {
  it('delivers owner text to her waking session', async () => {
    const { ctx, host } = await setup()
    expect(await invoke(ctx, 'self how are you?')).toMatchObject({ kind: 'success', text: expect.stringContaining('Delivered to her waking session') })
    expect(host.all()[0]).toContain('[通知] The owner says: how are you?')
  })
})

describe('memory management from outside', () => {
  it('lets the owner list and delete memories from every source, and goes away with the memory plugin', async () => {
    const { ctx } = await setup()
    const fiber = await ctx.plugin(animaMemory, {})
    ctx.animaMemory.store.remember({ kind: 'fact', channelKey: 'test:me:private:alice', fromPerson: 'test:alice', fromName: 'Alice', text: 'Alice likes tea.', now: ctx.anima.clock.now() })
    expect(await invoke(ctx, 'memory list')).toMatchObject({ kind: 'success', text: expect.stringContaining('Alice likes tea.') })
    expect(await invoke(ctx, 'memory forget m1')).toMatchObject({ kind: 'success', text: 'Deleted m1.' })
    expect(await invoke(ctx, 'memory list')).toMatchObject({ text: 'No memories.' })
    await fiber.dispose()
    expect(await invoke(ctx, 'memory list')).toMatchObject({ kind: 'error' })
    await expect(ctx.animaGuard.ownerView('memory')).rejects.toThrow(/anima\/unknown-view/)
  })
})
