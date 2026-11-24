import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as animaCore from '@anima/core'
import { SAY_META, SAY_PARAMETERS, sayMessages, type AdmitRefusal, type AdmitRequest } from '@anima/core'
import { onTestFinished } from 'vitest'
import { AnimaLife, type ArchiveResult, type ModelChoice, type PublishedChannel, type SessionHost, type Stimulus } from '../src/index.ts'

export const at = (text: string) => new Date(text).getTime()

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anima-life-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export interface FakeAgent { id: string; inbox: string[]; models: ModelChoice[]; preset: string; title?: string }

/** In-memory host mimicking DSH: sessions, archive (refused while a turn runs or an alarm targets it), alarms. */
export class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent>()
  readonly archived = new Set<string>()
  /** Sessions DSH would refuse to archive (a turn runs). */
  readonly busy = new Set<string>()
  /** Pending alarms: id → target session. */
  readonly alarms = new Map<string, string>()
  readonly order: string[] = []

  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string, spec: { agentPreset: string }) {
    this.sessions.set(id, { id, inbox: [], models: [], preset: spec.agentPreset })
    this.order.push(id)
    return id
  }
  isArchived(id: string) { return this.archived.has(id) }
  async archive(id: string): Promise<ArchiveResult> {
    if (this.busy.has(id) || [...this.alarms.values()].includes(id)) return 'busy'
    this.archived.add(id)
    return 'archived'
  }
  async moveAlarms(from: string, to: string) {
    let n = 0
    for (const [id, target] of this.alarms) if (target === from) { this.alarms.set(id, to); n++ }
    return n
  }
  rename(agent: FakeAgent, title: string) { agent.title = title }
  async deliver(agent: FakeAgent, text: string) {
    if (this.archived.has(agent.id)) throw new Error(`delivered into archived ${agent.id}`)
    agent.inbox.push(text)
  }
  async inject(agent: FakeAgent, text: string) { agent.inbox.push(`(inject) ${text}`) }
  selectModel(agent: FakeAgent, choice: ModelChoice) { agent.models.push(choice) }
}

export const OWNER: PublishedChannel = { platform: 'demo', account: 'me', kind: 'private', id: 'owner', display: 'Sam', isOwner: true }
export const ALICE: PublishedChannel = { platform: 'demo', account: 'me', kind: 'private', id: 'alice', display: 'Alice' }
export const GROUP: PublishedChannel = { platform: 'demo', account: 'me', kind: 'group', id: 'club', display: 'Book club' }
export const OWNER_KEY = 'demo:me:private:owner'
export const ALICE_KEY = 'demo:me:private:alice'
export const GROUP_KEY = 'demo:me:group:club'

const genes = { risePerHour: 0.05, fallPerHour: 0.1, fallAsleepAbove: 0.6, overwhelmAbove: 0.95, wakeBelow: 0.1 }

/** Core + life on a fake host, with the demo channels published and a demo_say. */
export async function setup(start: string, options: { life?: Record<string, unknown>; core?: Record<string, unknown>; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? tempDir()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(animaCore, { dataDir, sleep: genes, clock: { speed: 1, start }, ...options.core })
  const clock = { now: at(start) }
  ctx.anima.setClock(() => clock.now)
  const outside: { refuse: (request: AdmitRequest) => AdmitRefusal | undefined } = { refuse: () => undefined }
  ctx.on('anima/admit', request => outside.refuse(request))
  const recorded: Record<string, unknown>[] = []
  ctx.on('anima/record', (record) => { recorded.push(record as never) })
  const stimuli: { text?: string; delivery: string; type: string }[] = []
  ctx.on('anima/stimulus', ({ stimulus, delivery }) => { stimuli.push({ type: stimulus.type, delivery, ...'text' in stimulus ? { text: stimulus.text } : {} }) })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 }, ...options.life } })
  await ctx.plugin({ name: 'adapter', inject: ['animaLife'], apply: (child: Context) => { child.animaLife.publish([OWNER, ALICE, GROUP]) } })
  const sent: { channel: string; texts: string[] }[] = []
  ctx.anima.registerBehavior(defineTool({
    name: 'demo_say', description: 'say', parameters: { ...SAY_PARAMETERS },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'sent' }] },
    async execute(args) { sent.push({ channel: args.channel, texts: sayMessages(args) }); return { ok: true } },
  }), { platform: 'demo', effect: 'express', sessions: ['waking'], ...SAY_META })
  await settle()
  return { ctx, host, clock, outside, recorded, stimuli, sent, dataDir, current: () => host.sessions.get(ctx.animaLife.waking.current!)! }
}

/** Let queued microtasks and short timers run. */
export const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

let calls = 0
export async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) {
  const agent = { id: sessionId } as unknown as Agent
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`c${++calls}`), name, arguments: args, agent, toolSet, signal })
    const block = result.content[0] as { text?: string } | undefined
    return { isError: result.isError, text: block?.text ?? '', concludes: result.concludesTurn === true }
  } finally {
    toolSet.dispose()
  }
}

export function event(ctx: Context, sessionId: string, type: string, data: unknown = {}) {
  ctx.emit('session/event' as never, { id: sessionId } as never, { type, data } as never)
}

export function message(channel: PublishedChannel, text: string, ts: number, extra: Partial<Extract<Stimulus, { type: 'message' }>> = {}): Stimulus {
  const sender = channel === OWNER ? { platformUserId: 'owner', displayName: 'Sam', isOwner: true } : { platformUserId: 'alice', displayName: 'Alice', isOwner: false }
  return { type: 'message', channel, sender, text, ts, ...extra }
}
