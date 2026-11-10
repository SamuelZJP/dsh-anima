import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as animaCore from '@anima/core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AnimaLife, consolidationSessionId, conversationSessionId, route, selfSessionId, SessionRouter, stimulusText, wakes } from '../src/index.ts'
import type { PublishedChannel, SessionHost, Stimulus } from '../src/index.ts'

const owner: PublishedChannel = { platform: 'local', account: 'owner', kind: 'private', id: 'owner', display: 'Owner (local)' }
const group: PublishedChannel = { platform: 'qq', account: '10', kind: 'group', id: '42', display: 'Book club' }

function message(channel: PublishedChannel, text = 'hello'): Stimulus {
  return { type: 'message', channel, sender: { platformUserId: 'u1', displayName: 'Sam', isOwner: true }, text, ts: 0 }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-life-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface FakeAgent { id: string; inbox: string[] }

/** In-memory host mimicking DSH: create mints a new id when the named session already exists. */
class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent & { preset: string; cwd: string; title?: string }>()
  readonly archived = new Set<string>()
  creates = 0

  async resolve(id: string) {
    await Promise.resolve()
    return this.sessions.get(id)
  }
  async create(id: string, spec: { agentPreset: string; cwd: string }) {
    this.creates++
    await new Promise(resolve => setTimeout(resolve, 5))
    const actual = this.sessions.has(id) ? `${id}-minted` : id
    this.sessions.set(actual, { id: actual, inbox: [], preset: spec.agentPreset, cwd: spec.cwd })
    return actual
  }
  isArchived(id: string) { return this.archived.has(id) }
  rename(agent: FakeAgent, title: string) { this.sessions.get(agent.id)!.title = title }
  async deliver(agent: FakeAgent, text: string) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, text: string) { agent.inbox.push(`(inject) ${text}`) }
  selectModel() {}
  isBusy() { return false }
}

describe('session identity', () => {
  it('is deterministic per character and channel', () => {
    const key = 'local:owner:private:owner'
    expect(conversationSessionId('anima', key)).toBe(conversationSessionId('anima', key))
    expect(conversationSessionId('anima', key)).toMatch(/^anima-c-[0-9a-f]{24}$/)
    expect(conversationSessionId('anima', key)).not.toBe(conversationSessionId('anima', 'local:owner:private:other'))
    expect(conversationSessionId('anima', key)).not.toBe(conversationSessionId('mio', key))
  })

  it('keeps Self apart from every conversation', () => {
    expect(selfSessionId('anima')).toMatch(/^anima-self-[0-9a-f]{24}$/)
    expect(selfSessionId('anima')).not.toBe(selfSessionId('mio'))
    expect(selfSessionId('anima')).not.toBe(conversationSessionId('anima', ''))
    expect(selfSessionId('anima', 1)).toBe('anima-self-9ab12293373718feef7e5704')
    expect(selfSessionId('anima', 2)).toMatch(/^anima-self-[0-9a-f]{24}$/)
    expect(selfSessionId('anima', 2)).not.toBe(selfSessionId('anima'))
    expect(route('anima', { type: 'notice', text: 'x', ts: 0 }, 2)).toEqual({ kind: 'self', sessionId: selfSessionId('anima', 2) })
  })
})

describe('route', () => {
  it('sends channel messages to that channel’s conversation', () => {
    expect(route('anima', message(group))).toEqual({
      kind: 'conversation', sessionId: conversationSessionId('anima', 'qq:10:group:42'), channel: group, channelKey: 'qq:10:group:42',
    })
  })

  it('sends notices to Self', () => {
    expect(route('anima', { type: 'notice', text: 'x', ts: 0 })).toEqual({ kind: 'self', sessionId: selfSessionId('anima') })
  })

  it('formats messages with channel and sender', () => {
    expect(stimulusText(message(owner))).toBe('[local private "Owner (local)"] Sam (owner): hello')
  })
})

describe('SessionRouter', () => {
  function setup() {
    const host = new FakeHost()
    const dataDir = tempDir()
    return { host, dataDir, router: new SessionRouter(host, { characterId: 'anima', dataDir }) }
  }

  it('creates a conversation on first message with the conversation preset', async () => {
    const { host, router, dataDir } = setup()
    const id = await router.deliver(message(owner))
    const session = host.sessions.get(id)!
    expect(session).toMatchObject({ preset: 'anima-conversation', cwd: join(dataDir, 'conversations'), title: 'Anima · Owner (local)' })
    expect(session.inbox).toEqual(['[local private "Owner (local)"] Sam (owner): hello'])
    expect(existsSync(join(dataDir, 'conversations'))).toBe(true)
  })

  it('reuses the existing session without creating again', async () => {
    const { host, router } = setup()
    const first = await router.deliver(message(owner, 'one'))
    const second = await router.deliver(message(owner, 'two'))
    expect(second).toBe(first)
    expect(host.creates).toBe(1)
    expect(host.sessions.get(first)!.inbox).toHaveLength(2)
  })

  it('creates once under concurrent deliveries to one id', async () => {
    const { host, router } = setup()
    const ids = await Promise.all([1, 2, 3, 4].map(n => router.deliver(message(owner, `m${n}`))))
    expect(new Set(ids).size).toBe(1)
    expect(host.creates).toBe(1)
    expect(host.sessions.size).toBe(1)
    expect(host.sessions.get(ids[0]!)!.inbox).toHaveLength(4)
  })

  it('creates Self with the self preset in the workspace directory', async () => {
    const { host, router, dataDir } = setup()
    const agent = await router.ensureSelf()
    expect(agent.id).toBe(selfSessionId('anima'))
    expect(host.sessions.get(agent.id)).toMatchObject({ preset: 'anima-self', cwd: join(dataDir, 'workspace'), title: 'Anima · self' })
  })

  it('refuses archived sessions', async () => {
    const { host, router } = setup()
    host.archived.add(conversationSessionId('anima', 'local:owner:private:owner'))
    await expect(router.deliver(message(owner))).rejects.toThrow(/anima\/session-archived/)
    expect(host.creates).toBe(0)
  })

  it('fails loud when DSH would mint another id', async () => {
    const { host, router } = setup()
    const id = conversationSessionId('anima', 'local:owner:private:owner')
    host.resolve = async () => undefined
    host.sessions.set(id, { id, inbox: [], preset: 'x', cwd: 'x' })
    await expect(router.deliver(message(owner))).rejects.toThrow(/anima\/session-id-mismatch/)
  })

  it('maps session ids back to channels and Self', async () => {
    const { router } = setup()
    const forget = router.know(owner)
    const id = conversationSessionId('anima', 'local:owner:private:owner')
    expect(router.describe(id)).toEqual({ kind: 'conversation', channel: owner, channelKey: 'local:owner:private:owner' })
    expect(router.describe(selfSessionId('anima'))).toEqual({ kind: 'self' })
    expect(router.describe('session-123')).toBeUndefined()
    forget()
    expect(router.describe(id)).toBeUndefined()
  })
})

describe('AnimaLife service', () => {
  async function setup() {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { dataDir: tempDir() })
    ctx.anima.setClock(() => new Date('2026-11-10T10:00').getTime())
    const host = new FakeHost()
    const fiber = await ctx.plugin(AnimaLife, host as unknown as SessionHost<Agent>)
    return { ctx, host, fiber }
  }

  it('provides the core session resolver for published channels', async () => {
    const { ctx } = await setup()
    const id = conversationSessionId('anima', 'local:owner:private:owner')
    expect(ctx.anima.describeSession(id)).toBeUndefined()
    const fiber = await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([owner]) } })
    expect(ctx.anima.describeSession(id)).toMatchObject({ kind: 'conversation', channelKey: 'local:owner:private:owner' })
    expect(ctx.anima.describeSession(selfSessionId('anima'))).toEqual({ kind: 'self' })
    await fiber.dispose()
    expect(ctx.anima.describeSession(id)).toBeUndefined()
  })

  it('delivers /anima self text to the Self session', async () => {
    const { ctx, host } = await setup()
    const invocation = { rawInput: 'self how are you?', agent: {}, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
    expect(await ctx.anima.dispatchCommand(invocation)).toMatchObject({ kind: 'success' })
    expect(host.sessions.get(selfSessionId('anima'))!.inbox).toEqual(['[Tue 2026-11-10 10:00] [notice] The owner says: how are you?'])
  })

  it('withdraws the resolver and subcommand on unload', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(ctx.anima.describeSession(selfSessionId('anima'))).toBeUndefined()
    expect(ctx.anima.hasSubcommand('self')).toBe(false)
  })

  it('routes consolidation to the day\'s consolidation session with its preset and model', async () => {
    const { ctx, host } = await setup()
    const models: string[] = []
    host.selectModel = ((_agent: unknown, choice: { model: string }) => { models.push(choice.model) }) as typeof host.selectModel
    const seen: string[] = []
    ctx.on('anima/stimulus', event => { seen.push(`${event.stimulus.type} ${event.sessionId}`) })
    const id = await ctx.animaLife.deliver({ type: 'consolidate', day: '2026-11-10', text: 'segments…', run: 'r1', ts: 0 }, { model: { provider: 'p', model: 'cheap' } })
    expect(id).toBe(consolidationSessionId('anima', '2026-11-10'))
    expect(host.sessions.get(id)).toMatchObject({ preset: 'anima-consolidation', title: 'Anima · memory 2026-11-10' })
    expect(host.sessions.get(id)!.inbox[0]).toContain('[consolidate]\nsegments…')
    expect(models).toEqual(['cheap'])
    expect(seen).toEqual([`consolidate ${id}`])
    expect(ctx.anima.describeSession(id)).toEqual({ kind: 'consolidation' })
  })

  it('injects unaddressed group messages without waking', async () => {
    const { ctx, host } = await setup()
    const bob = { platformUserId: 'b', displayName: 'Bob', isOwner: false }
    expect(wakes({ type: 'message', channel: group, sender: bob, text: 'hi', ts: 0 })).toBe(false)
    expect(wakes({ type: 'message', channel: group, sender: bob, text: 'hi', ts: 0, addressed: true })).toBe(true)
    expect(wakes({ type: 'message', channel: owner, sender: bob, text: 'hi', ts: 0 })).toBe(true)
    const id = await ctx.animaLife.deliver({ type: 'message', channel: group, sender: bob, text: 'hotpot?', ts: 0 })
    expect(host.sessions.get(id)!.inbox).toEqual([expect.stringMatching(/^\(inject\) .*Bob: hotpot\?$/)])
  })

  it('adds report lines from other plugins', async () => {
    const { ctx, host } = await setup()
    const fiber = await ctx.plugin({ name: 'reporter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.addReportLine(() => ['Memory: 3 lines pending.']) } })
    await ctx.animaLife.beat()
    const triage = [...host.sessions.values()].find(session => session.preset === 'anima-triage')!
    expect(triage.inbox[0]).toContain('Memory: 3 lines pending.')
    await fiber.dispose()
  })
})
