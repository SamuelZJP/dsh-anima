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
import { describe, expect, it, onTestFinished } from 'vitest'
import { AnimaLife, viewingSessionId, type ExtraBlock, type SessionHost } from '../src/index.ts'

interface FakeAgent { id: string; inbox: { text: string; extra: readonly ExtraBlock[] }[]; preset?: string }

class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent>()
  models: string[] = []
  onDeliver: (agent: FakeAgent) => void = () => {}
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string, spec: { agentPreset: string }) { this.sessions.set(id, { id, inbox: [], preset: spec.agentPreset }); return id }
  isArchived() { return false }
  rename() {}
  async deliver(agent: FakeAgent, text: string, _summary: string, _type: string, _ref?: string, extra: readonly ExtraBlock[] = []) {
    agent.inbox.push({ text, extra })
    queueMicrotask(() => this.onDeliver(agent))
  }
  async inject() {}
  selectModel(_agent: FakeAgent, choice: { model: string }) { this.models.push(choice.model) }
  isBusy() { return false }
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-view-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir, clock: { speed: 1, start: '2026-11-10T10:00' } })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 } } })
  return { ctx, host }
}

let n = 0
async function call(ctx: Context, sessionId: string, name: string, args: Record<string, unknown>) {
  const agent = { id: sessionId } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`v${++n}`), name, arguments: args, agent, toolSet, signal })
    return { isError: result.isError, text: (result.content[0] as { text?: string }).text ?? '' }
  } finally {
    toolSet.dispose()
  }
}

const image = { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: 10, width: 4, height: 4 } } as unknown as ExtraBlock

describe('viewing sessions (DESIGN §11)', () => {
  it('delivers text and frames to a viewing session and returns the note it writes', async () => {
    const { ctx, host } = await setup()
    const id = viewingSessionId('anima', 'bili:BV1:1')
    host.onDeliver = (agent) => { void call(ctx, agent.id, 'viewing_note', { note: 'A cat on a piano.' }) }
    const note = await ctx.animaLife.view({ key: 'bili:BV1:1', title: 'Cat', text: 'Look.', parts: [{ type: 'text', text: 'Frame 1' }, image], model: { provider: 'p', model: 'vision' }, timeoutSeconds: 5 })
    expect(note).toBe('A cat on a piano.')
    const agent = host.sessions.get(id)!
    expect(agent.preset).toBe('anima-viewing')
    expect(agent.inbox[0]!.text).toMatch(/\[细看\]\nLook\./)
    expect(agent.inbox[0]!.extra).toEqual([{ type: 'text', text: 'Frame 1' }, image])
    expect(host.models).toEqual(['vision'])
    expect(ctx.anima.describeSession(id)).toEqual({ kind: 'viewing' })
  })

  it('offers viewing_note only in viewing sessions', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, ctx.animaLife.router.selfId, 'viewing_note', { note: 'x' })
    expect(result.isError).toBe(true)
  })

  it('falls back to the last assistant text when the turn ends without a note', async () => {
    const { ctx, host } = await setup()
    host.onDeliver = (agent) => {
      const session = { id: agent.id } as never
      ctx.emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Mostly dark frames.' }] } } } as never)
      ctx.emit('session/event', session, { type: 'turn/end', data: {} } as never)
    }
    await expect(ctx.animaLife.view({ key: 'k2', title: 't', text: 'x', parts: [], timeoutSeconds: 5 })).resolves.toBe('Mostly dark frames.')
  })

  it('times out with a structured error', async () => {
    const { ctx } = await setup()
    await expect(ctx.animaLife.view({ key: 'k3', title: 't', text: 'x', parts: [], timeoutSeconds: 0.05 })).rejects.toThrow(/anima\/view-timeout/)
  })
})
