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
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-local-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir })
  const host = new RecordingHost()
  await ctx.plugin(AnimaLife, host as unknown as SessionHost<Agent>)
  const fiber = await ctx.plugin(local, { ownerName: 'Sam' })
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
    expect(ctx.anima.behavior(local.SAY_TOOL)).toEqual({ platform: 'local', effect: 'express', sessions: ['conversation'] })
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
    expect(host.delivered).toEqual([{ id: ownerSession, text: '[local private "Owner (local)"] Sam (owner): good morning' }])
  })

  it('needs text', async () => {
    const { ctx } = await setup()
    expect(await chat(ctx, 'chat')).toMatchObject({ kind: 'error' })
  })
})
