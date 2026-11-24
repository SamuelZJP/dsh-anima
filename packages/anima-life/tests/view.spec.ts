import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import { setup } from './helpers.ts'

describe('looking closely, as a subagent of her waking session', () => {
  it('sends the frames to a subagent on the viewing preset and model, and returns only its note', async () => {
    const { ctx } = await setup('2026-11-10T08:00')
    const started: Record<string, unknown>[] = []
    ctx.provide('subagents' as never)
    ctx.set('subagents' as never, {
      startActivation: async (spec: Record<string, unknown>) => {
        started.push(spec)
        return { result: Promise.resolve({ output: [{ type: 'text', text: '一只猫在窗台上晒太阳。' }], stopReason: 'completed' }), dispose: async () => {} }
      },
    } as never)
    const parent = { id: ctx.animaLife.waking.current! } as unknown as Agent
    const note = await ctx.animaLife.view({
      parent, title: 'cats', text: 'You chose to look closely.', parts: [{ type: 'text', text: 'Frame 1' }],
      model: { provider: 'p', model: 'vision' }, timeoutSeconds: 5,
    })
    expect(note).toBe('一只猫在窗台上晒太阳。')
    expect(started[0]).toMatchObject({
      provider: 'spawn', delivery: 'caller', label: 'viewing cats',
      request: { parent, agentPreset: 'anima-viewing', agentOptions: { provider: 'p', model: 'vision' }, prompt: [{ type: 'text', text: 'You chose to look closely.' }, { type: 'text', text: 'Frame 1' }] },
    })
  })

  it('fails in her words when there is no note or no subagent service', async () => {
    const { ctx } = await setup('2026-11-10T08:00')
    const parent = { id: 'x' } as unknown as Agent
    await expect(ctx.animaLife.view({ parent, title: 't', text: 'x', parts: [], timeoutSeconds: 5 })).rejects.toThrow(/anima\/no-subagents/)
    ctx.provide('subagents' as never)
    ctx.set('subagents' as never, { startActivation: async () => ({ result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'boom' }), dispose: async () => {} }) } as never)
    await expect(ctx.animaLife.view({ parent, title: 't', text: 'x', parts: [], timeoutSeconds: 5 })).rejects.toThrow(/anima\/view-no-note.*boom/)
  })
})
