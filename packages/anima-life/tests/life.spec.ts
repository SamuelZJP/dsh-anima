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
import { AnimaLife, conversationSessionId, route, selfSessionId, SessionRouter, stimulusText } from '../src/index.ts'
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
    expect(host.sessions.get(selfSessionId('anima'))!.inbox).toEqual(['[notice] The owner says: how are you?'])
  })

  it('withdraws the resolver and subcommand on unload', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(ctx.anima.describeSession(selfSessionId('anima'))).toBeUndefined()
    expect(ctx.anima.hasSubcommand('self')).toBe(false)
  })
})
