import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { onTestFinished } from 'vitest'
import * as animaCore from '../src/index.ts'
import type { BehaviorMeta, SessionInfo } from '../src/index.ts'

/** A fresh temporary data directory, removed after the test. */
export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-test-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Root context with system prompt, tools and anima-core. */
export async function setupCore(config: Partial<animaCore.Config> = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir: tempDataDir(), ...config })
  return ctx
}

/** A minimal stand-in Agent; the tool pipeline only reads `id` here. */
export function fakeAgent(id: string): Agent {
  return { id } as unknown as Agent
}

/** Install a session resolver from a fixed table. */
export function provideSessions(ctx: Context, table: Record<string, SessionInfo>): void {
  ctx.anima.provideSessions(id => table[id])
}

/** Register a behavior that echoes its text. */
export function registerEcho(ctx: Context, name: string, meta: BehaviorMeta): void {
  ctx.anima.registerBehavior(defineTool({
    name,
    description: 'test behavior',
    parameters: { text: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute() { return { ok: true } },
  }), meta)
}

let calls = 0

/** Run a tool call as the given session through the real pipeline, with step admission. */
export async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  const agent = fakeAgent(sessionId)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
  try {
    return await executeToolFixture(ctx, { callId: ToolCallId(`call-${++calls}`), name, arguments: args, agent, toolSet, signal })
  } finally {
    toolSet.dispose()
  }
}

/** Text of a result's first content block. */
export function textOf(result: { content: readonly { type: string }[] }): string {
  const block = result.content[0] as { type: string; text?: string } | undefined
  return block?.text ?? ''
}
