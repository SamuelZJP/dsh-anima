import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { AnimaLife, conversationSessionId, selfSessionId, type SessionHost } from '@anima/life'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as local from '../src/index.ts'

const ownerSession = conversationSessionId('anima', 'local:owner:private:owner')

class RecordingHost implements SessionHost {
  readonly delivered: { id: string; text: string }[] = []
  readonly existing = new Set<string>()
  async resolve(id: string) { return this.existing.has(id) ? { id } : undefined }
  async create(id: string) { this.existing.add(id); return id }
  isArchived() { return false }
  rename() {}
  async deliver(agent: { id: string }, text: string) { this.delivered.push({ id: agent.id, text }) }
  async inject() {}
  selectModel() {}
  isBusy() { return false }
}

async function setup(config: Partial<local.Config> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-local-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const host = new RecordingHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  const fiber = await ctx.plugin(local, { ownerName: 'Sam', ...config })
  return { ctx, host, dataDir, fiber }
}

async function say(ctx: Context, sessionId: string, text: string) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    return await executeToolFixture(ctx, { callId: ToolCallId(`say-${text}`), name: local.SAY_TOOL, arguments: { text }, agent, toolSet, signal })
  } finally {
    toolSet.dispose()
  }
}

describe('local_say', () => {
  it('appends to the outbox in the owner conversation', async () => {
    const { ctx, dataDir } = await setup()
    const result = await say(ctx, ownerSession, 'hi Sam')
    expect(result.isError).toBe(false)
    const lines = readFileSync(local.outboxPath(dataDir), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toEqual([expect.objectContaining({ sessionId: ownerSession, channel: 'local:owner:private:owner', text: 'hi Sam' })])
  })

  it('is refused by the gate in the Self session', async () => {
    const { ctx } = await setup()
    const result = await say(ctx, selfSessionId('anima'), 'hello?')
    expect(result.isError).toBe(true)
  })

  it('is registered with local express metadata and removed on unload', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.anima.behavior(local.SAY_TOOL)).toMatchObject({ platform: 'local', effect: 'express', sessions: ['conversation'] })
    await fiber.dispose()
    expect(ctx.tools.get(local.SAY_TOOL)).toBeUndefined()
    expect(ctx.anima.hasSubcommand('chat')).toBe(false)
    expect(ctx.anima.describeSession(ownerSession)).toBeUndefined()
  })
})

describe('/anima chat', () => {
  function chat(ctx: Context, rawInput: string) {
    return ctx.anima.dispatchCommand({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation)
  }

  it('delivers an owner message to the owner conversation', async () => {
    const { ctx, host } = await setup()
    const result = await chat(ctx, 'chat good morning')
    expect(result.kind).toBe('success')
    expect(host.delivered).toEqual([{ id: ownerSession, text: expect.stringMatching(/^\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[本地 私聊「Owner」\] Sam（主人） 对你说: good morning\n在这里回应：用 local_say 说话（只有对方看得到），或用 end_turn 结束不说。只写文字不算回应。$/) }])
  })

  it('needs text', async () => {
    const { ctx } = await setup()
    expect(await chat(ctx, 'chat')).toMatchObject({ kind: 'error' })
  })
})

describe('/anima chat --as / --in (dev test channels)', () => {
  function chat(ctx: Context, rawInput: string) {
    return ctx.anima.dispatchCommand({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation)
  }
  const aliceSession = conversationSessionId('anima', 'local:owner:private:alice')
  const groupSession = conversationSessionId('anima', 'local:owner:group:test')

  it('parses flags in any order', () => {
    expect(local.parseChat('--in group:test --as bob hi all')).toEqual({ as: 'bob', group: 'test', text: 'hi all' })
    expect(local.parseChat('hello --as bob')).toEqual({ as: undefined, group: undefined, text: 'hello --as bob' })
    expect(local.parseChat('--as owner hi')).toMatchObject({ error: expect.stringContaining('leave out --as') })
    expect(local.parseChat('--in test hi')).toMatchObject({ error: expect.stringContaining('group:<id>') })
    expect(local.parseChat('--as bob')).toMatchObject({ error: expect.stringContaining('Usage') })
  })

  it('speaks as another person in their own private chat', async () => {
    const { ctx, host } = await setup()
    expect(await chat(ctx, 'chat --as alice hi there')).toMatchObject({ kind: 'success' })
    expect(host.delivered).toEqual([{ id: aliceSession, text: expect.stringMatching(/\[本地 私聊「Alice」\] Alice 对你说: hi there\n在这里回应：/) }])
    expect(ctx.anima.describeSession(aliceSession)).toMatchObject({ kind: 'conversation', channelKey: 'local:owner:private:alice' })
    expect(ctx.anima.channelInfo('local:owner:private:alice')).toMatchObject({ isOwner: false, display: 'Alice (local)' })
    expect((await say(ctx, aliceSession, 'hi Alice')).isError).toBe(false)
  })

  it('wakes a simulated group only when she is addressed', async () => {
    const { ctx, host } = await setup()
    const quiet = await chat(ctx, 'chat --as bob --in group:test hotpot tonight?')
    expect(quiet).toMatchObject({ kind: 'success', text: expect.stringContaining('into group triage') })
    expect(host.delivered).toEqual([])
    await chat(ctx, 'chat --as bob --in group:test @Anima are you coming?')
    expect(host.delivered).toEqual([{ id: groupSession, text: expect.stringContaining('[本地 群「group test」] Bob [local bob] 叫你（群里所有人都会看到你的回答）: @Anima are you coming?') }])
  })

  it('remembers test channels across a reload', async () => {
    const { ctx, fiber } = await setup()
    await chat(ctx, 'chat --as alice hi')
    await fiber.dispose()
    expect(ctx.anima.describeSession(aliceSession)).toBeUndefined()
    await ctx.plugin(local, { ownerName: 'Sam' })
    expect(ctx.anima.describeSession(aliceSession)).toMatchObject({ kind: 'conversation' })
  })
})

function command(ctx: Context, rawInput: string) {
  return ctx.anima.dispatchCommand({ rawInput, agent: { id: 'x' }, attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation)
}

describe('local owner line (dev)', () => {
  it('is off by default', async () => {
    const { ctx } = await setup()
    expect(ctx.anima.ownerLine).toBeUndefined()
  })

  it('asks approvals in owner-line.jsonl and takes "yes <id>" from /anima chat without reaching her', async () => {
    const { ctx, host, dataDir } = await setup({ ownerLine: true })
    expect(ctx.anima.ownerLine?.name).toMatch(/local owner line/)
    const answer = ctx.anima.requestApproval('She wants to call open_conversation.')
    await new Promise(resolve => setTimeout(resolve, 10))
    const asked = readFileSync(join(dataDir, 'local', 'owner-line.jsonl'), 'utf8')
    expect(asked).toMatch(/\[Anima approval a1\] She wants to call open_conversation/)
    expect(await command(ctx, ' chat yes a1')).toEqual({ kind: 'success', text: 'Allowed a1.' })
    expect(await answer).toBe('approved')
    expect(host.delivered).toEqual([])
  })
})

describe('activity: wakes', () => {
  it('records each delivery that wakes her', async () => {
    const { ctx } = await setup()
    await command(ctx, ' chat hello there')
    const wakes = ctx.anima.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'wake')
    expect(wakes).toEqual([expect.objectContaining({ stimulus: 'message', session: 'conversation', sessionId: ownerSession, channel: 'local:owner:private:owner' })])
    const outbox = await ctx.anima.ownerView('outbox') as { held: unknown[]; delaySeconds: number }
    expect(outbox.held).toEqual([])
    const status = await ctx.anima.ownerView('status') as { parts: { life: { sessions: { conversations: unknown[] } } } }
    expect(status.parts.life.sessions.conversations).toHaveLength(1)
  })
})
