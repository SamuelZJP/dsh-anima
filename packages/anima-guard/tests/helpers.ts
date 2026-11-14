import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as animaCore from '@anima/core'
import type { BehaviorMeta, SessionInfo } from '@anima/core'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { onTestFinished } from 'vitest'
import * as animaGuard from '../src/index.ts'

/** A fresh temporary data directory, removed after the test. */
export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-guard-test-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Root context with system prompt, tools, anima-core and anima-guard, and the guard's fiber. */
export async function setupGuardedFiber(guard: Partial<animaGuard.Config> = {}, core: Record<string, unknown> = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  // A fixed daytime clock, so tests do not depend on the hour they run at.
  await ctx.plugin(animaCore, { dataDir: tempDataDir(), clock: { speed: 1, start: '2026-11-10T10:00' }, ...core })
  const fiber = await ctx.plugin(animaGuard, guard)
  return { ctx, fiber }
}

/** Root context with system prompt, tools, anima-core and anima-guard. */
export async function setupGuarded(guard: Partial<animaGuard.Config> = {}, core: Record<string, unknown> = {}): Promise<Context> {
  return (await setupGuardedFiber(guard, core)).ctx
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
    parameters: { text: { type: 'string' }, also: { type: 'array', items: { type: 'string' } }, more: { type: 'boolean' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute() { return { ok: true } },
  }), meta)
}

let calls = 0

/** Run a tool call as the given session through the real pipeline. */
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

/** Run one `/anima` invocation through the guard. */
export function invoke(ctx: Context, rawInput: string) {
  const invocation = { rawInput, agent: fakeAgent('any'), attachments: [], signal: new AbortController().signal } as unknown as CommandInvocation
  return ctx.animaGuard.dispatch(invocation)
}
