import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'
import * as animaCore from '../src/index.ts'
import { tempDataDir } from './helpers.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir: tempDataDir() })
  return ctx
}

function ping(ctx: Context, args: Record<string, unknown>) {
  return executeToolFixture(ctx, {
    callId: ToolCallId('ping'),
    name: animaCore.PING_TOOL,
    arguments: args,
    signal: new AbortController().signal,
  })
}

it('registers anima_ping', async () => {
  const ctx = await setup()
  expect(ctx.tools.get(animaCore.PING_TOOL)).toBeDefined()
})

it('answers pong and echoes the message', async () => {
  const ctx = await setup()
  const result = await ping(ctx, { message: 'hello' })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: 'pong: hello' }])
})

it('answers plain pong without a message', async () => {
  const ctx = await setup()
  const result = await ping(ctx, {})
  expect(result.content).toEqual([{ type: 'text', text: 'pong' }])
})

it('unregisters the tool when the plugin is disposed', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const fiber = await ctx.plugin(animaCore, { dataDir: tempDataDir() })
  expect(ctx.tools.get(animaCore.PING_TOOL)).toBeDefined()
  await fiber.dispose()
  expect(ctx.tools.get(animaCore.PING_TOOL)).toBeUndefined()
})
