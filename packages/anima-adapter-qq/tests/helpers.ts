/** Shared setup of the adapter tests: DSH tools, Anima core and life, and the QQ adapter over a fake backend. */

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
import { AnimaLife, type SessionHost } from '@anima/life'
import { expect, onTestFinished, vi } from 'vitest'
import * as qq from '../src/index.ts'
import { FakeBackend, type Ability } from './fake-backend.ts'

export const ACCOUNT = '10001'
export const OWNER = '20002'
export const FRIEND = '30003'
export const GROUP = '40004'
export const ownerKey = `qq:${ACCOUNT}:private:${OWNER}`
export const friendKey = `qq:${ACCOUNT}:private:${FRIEND}`
export const groupKey = `qq:${ACCOUNT}:group:${GROUP}`
/**
 * Her chats, as tests address them: `callAs(ctx, ownerSession, 'qq_say', …)` calls
 * from her waking session with `channel` set to that chat, and `host.inbox(ownerSession)`
 * lists the arrivals of that chat (each names its channel key).
 */
export const ownerSession = ownerKey
export const friendSession = friendKey
export const groupSession = groupKey
/** A session that is not hers. */
export const plainSession = 'plain-dsh-session'

interface FakeAgent { id: string; inbox: string[] }

export class FakeHost implements SessionHost<FakeAgent> {
  readonly sessions = new Map<string, FakeAgent>()
  async resolve(id: string) { return this.sessions.get(id) }
  async create(id: string) { this.sessions.set(id, { id, inbox: [] }); return id }
  isArchived() { return false }
  async archive() { return 'archived' as const }
  async moveAlarms() { return 0 }
  rename() {}
  async deliver(agent: FakeAgent, { text }: { text: string }) { agent.inbox.push(text) }
  async inject(agent: FakeAgent, { text }: { text: string }) { agent.inbox.push(`(inject) ${text}`) }
  cancel() {}
  async readLog() { return [] }
  selectModel() {}
  /** Arrivals in her waking session(s) from one chat, by its channel key. */
  inbox(key: string) { return [...this.sessions.values()].flatMap(agent => agent.inbox).filter(text => text.includes(` ${key}]`) && !text.includes('[醒来]')) }
  /** Every chat arrival (no waking context, no platform notices). */
  all() { return [...this.sessions.values()].flatMap(agent => agent.inbox).filter(text => !text.includes('[醒来]') && !text.includes('[通知]')) }
  /** Platform notices she got. */
  notices() { return [...this.sessions.values()].flatMap(agent => agent.inbox).filter(text => text.includes('[通知]')) }
}

export interface SetupOptions {
  /** Adapter config beyond the basics. */
  readonly qq?: Record<string, unknown>
  /** anima-life config. */
  readonly life?: Record<string, unknown>
  /** anima-core config. */
  readonly core?: Record<string, unknown>
  /** Abilities the backend lacks. */
  readonly without?: readonly Ability[]
  /** Account the backend is logged in as (default: hers). */
  readonly loggedInAs?: string
  /** Wait until the account's chats are published (default true). */
  readonly ready?: boolean
}

/** The adapter over a fake backend, with friends Sam (owner) and Cat and one group. */
export async function setup(options: SetupOptions = {}) {
  const backend = new FakeBackend(options.loggedInAs ?? ACCOUNT, options.without)
  backend.friendList = [{ userId: OWNER, name: 'sam' }, { userId: FRIEND, name: 'Cat' }]
  backend.groupList = [{ groupId: GROUP, name: 'Test group' }]
  const dataDir = mkdtempSync(join(tmpdir(), 'anima-qq-'))
  onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const saved: { name?: string; bytes: number; mediaType: string }[] = []
  ctx.provide('attachments')
  ctx.set('attachments', { saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
    saved.push({ name: input.name, bytes: input.data.length, mediaType: input.mediaType })
    return { attachmentId: `att${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
  } })
  ctx.provide('llm')
  ctx.set('llm', { resolveModelInfo: async (_provider: string, model: string) => ({ inputModalities: model === 'blind' ? ['text'] : ['text', 'image'] }) })
  await ctx.plugin(animaCore, { dataDir, clock: { speed: 1, start: '2026-11-10T10:00' }, ...options.core })
  const host = new FakeHost()
  await ctx.plugin(AnimaLife, { host: host as unknown as SessionHost<Agent>, config: { conversation: { settleSeconds: 0 }, platforms: { noticeAfterSeconds: 0 }, ...options.life } })
  const config = qq.resolveQqConfig({ backend: { url: 'ws://fake' }, account: ACCOUNT, owner: OWNER, ownerName: 'Sam', ...options.qq })
  const fiber = await ctx.plugin({ name: 'anima-adapter-qq', inject: qq.inject, apply: (child: Context) => qq.attach(child, config, backend) })
  if (options.ready !== false) {
    await vi.waitFor(() => expect(ctx.anima.statusLines().join('\n')).toMatch(/QQ: connected to fake QQ backend as 10001 \(Anima\)/))
    await vi.waitFor(() => expect(ctx.anima.channelInfo(groupKey)).toBeDefined())
  }
  // What she reports for the log kept outside the persona.
  const recorded: { type: string; online?: boolean; reason?: string }[] = []
  ctx.on('anima/record', (record) => { recorded.push(record as never) })
  return { ctx, host, backend, fiber, dataDir, saved, recorded }
}

const CHAT_TOOLS = new Set(['qq_say', 'qq_history', 'qq_poke'])

let calls = 0
/**
 * Call a tool as a session, on a model that can see unless `model` is 'blind'. A
 * chat's channel key as `sessionId` means her waking session, in that chat.
 */
export async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown> = {}, model = 'vision') {
  if (sessionId.startsWith('qq:')) {
    if (CHAT_TOOLS.has(name) && args.channel === undefined) args = { channel: sessionId, ...args }
    sessionId = ctx.animaLife.waking.current!
  }
  const agent = { id: sessionId, session: { requestHeader: () => ({ config: { provider: 't', model } }) } } as unknown as Agent
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model }, signal })
  try {
    const result = await executeToolFixture(ctx, { callId: ToolCallId(`q${++calls}`), name, arguments: args, agent, toolSet, signal })
    const text = result.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
    return { isError: result.isError, text, content: result.content }
  } finally {
    toolSet.dispose()
  }
}

/** A fresh message id. */
export const nextId = () => String(++calls)
