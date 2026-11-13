import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as animaCore from '../src/index.ts'
import * as persona from '../src/persona.ts'
import { tempDataDir } from './helpers.ts'

async function mintAgentScope(ctx: Context, id: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: id as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt', 'anima'] }))
  return { scope, key }
}

describe('persona tool hiding', () => {
  it('hides working_directory and anima_ping in her session only', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir: tempDataDir() })
    ctx.tools.register(defineTool({
      name: 'working_directory',
      description: 'cd',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { return { ok: true } },
    }))
    const { scope, key } = await mintAgentScope(ctx, 'anima-self-x')
    const fiber = await scope.ctx.plugin(persona, { kind: 'self' })
    const names = () => ctx.tools.schemas(key).map(tool => tool.name)
    expect(names()).not.toContain('working_directory')
    expect(names()).not.toContain(animaCore.PING_TOOL)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining(['working_directory', animaCore.PING_TOOL]))
    await fiber.dispose()
    expect(names()).toContain('working_directory')
  })

  it('skips names that are not registered', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(animaCore, { conversationGeneration: 1, dataDir: tempDataDir() })
    const { scope } = await mintAgentScope(ctx, 'anima-self-y')
    await expect(scope.ctx.plugin(persona, { kind: 'self', hideTools: ['no_such_tool'] })).resolves.toBeDefined()
  })
})
