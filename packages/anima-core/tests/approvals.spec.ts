import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, parseOwnerReply } from '../src/approvals.ts'
import { decide, GateCode, QuotaBook } from '../src/gate.ts'
import type { GateCall, GateMoment } from '../src/gate.ts'
import type { BehaviorMeta, SessionInfo } from '../src/types.ts'
import { callAs, provideSessions, registerEcho, setupCore, textOf } from './helpers.ts'

const qqChat: SessionInfo = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'group', id: '9' }, channelKey: 'qq:1:group:9' }
const self: SessionInfo = { kind: 'self' }
const say: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['conversation'] }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['conversation'] }
const open: BehaviorMeta = { effect: 'initiate', sessions: ['self'], target: args => args.channel as string }
const now = Date.UTC(2026, 10, 10, 10)
const moment = (extra: Partial<GateMoment> = {}): GateMoment => ({ mode: 'day', overBudget: false, initiatesUsed: 0, mayInitiate: () => true, ...extra })
const call = (name: string, meta: BehaviorMeta, session: SessionInfo, args: Record<string, unknown> = {}): GateCall => ({ name, meta, session, now, args })

describe('parseOwnerReply', () => {
  it('reads whole-message reply commands only', () => {
    expect(parseOwnerReply('yes a3')).toEqual({ verb: 'yes', id: 'a3' })
    expect(parseOwnerReply(' No A12 ')).toEqual({ verb: 'no', id: 'a12' })
    expect(parseOwnerReply('同意 a4')).toEqual({ verb: 'yes', id: 'a4' })
    expect(parseOwnerReply('cancel o2')).toEqual({ verb: 'cancel', id: 'o2' })
    expect(parseOwnerReply('yes')).toBeUndefined()
    expect(parseOwnerReply('yes a3 please hurry')).toBeUndefined()
    expect(parseOwnerReply('maybe a3')).toBeUndefined()
  })
})

describe('ApprovalBroker', () => {
  it('resolves by answer, timeout, abort, or missing line', async () => {
    vi.useFakeTimers()
    try {
      let seq = 0
      const broker = new ApprovalBroker(() => ++seq, 1000)
      const sent: string[] = []
      const line = { name: 'test', send: async (text: string) => { sent.push(text) } }
      const first = broker.request(line, 'post a dynamic')
      await vi.advanceTimersByTimeAsync(0)
      expect(sent[0]).toContain('[Anima approval a1] post a dynamic')
      expect(sent[0]).toContain('"yes a1"')
      expect(broker.answer('a1', true)).toBe(true)
      expect(await first).toBe('approved')
      expect(broker.answer('a1', true)).toBe(false)

      const second = broker.request(line, 'x')
      await vi.advanceTimersByTimeAsync(0)
      broker.answer('A2', false)
      expect(await second).toBe('denied')

      const third = broker.request(line, 'y')
      await vi.advanceTimersByTimeAsync(1001)
      expect(await third).toBe('timeout')

      const abort = new AbortController()
      const fourth = broker.request(line, 'z', { signal: abort.signal })
      abort.abort()
      expect(await fourth).toBe('denied')

      expect(await broker.request(undefined, 'w')).toBe('unavailable')
      const failing = { name: 'down', send: async () => { throw new Error('offline') } }
      expect(await broker.request(failing, 'v')).toBe('unavailable')
      expect(broker.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('gate: allowlist and approvals', () => {
  const book = new QuotaBook()
  it('refuses platform behaviors in a channel off the allowlist', () => {
    const verdict = decide(call('qq_say', say, qqChat), { quotas: [], allow: [] }, book, moment({ channelAllowed: () => false }))
    expect(verdict).toMatchObject({ allowed: false, code: GateCode.notAllowlisted })
    expect(decide(call('memory_remember', remember, qqChat), { quotas: [], allow: [] }, book, moment({ channelAllowed: () => false })).allowed).toBe(true)
    expect(decide(call('qq_say', say, qqChat), { quotas: [], allow: [] }, book, moment({ channelAllowed: () => undefined })).allowed).toBe(true)
  })
  it('refuses initiating toward a channel off the allowlist', () => {
    const allowed = (key: string) => key === 'qq:1:private:7'
    expect(decide(call('open_conversation', open, self, { channel: 'qq:1:group:9' }), { quotas: [], allow: [] }, book, moment({ channelAllowed: allowed }))).toMatchObject({ code: GateCode.notAllowlisted })
    expect(decide(call('open_conversation', open, self, { channel: 'qq:1:private:7' }), { quotas: [], allow: [] }, book, moment({ channelAllowed: allowed })).allowed).toBe(true)
    // A key nobody published is refused first (before consent and approval), listing the real channels.
    const unknown = decide(call('open_conversation', open, self, { channel: 'qq:owner:private:owner' }), { quotas: [], allow: [], approve: [{ behavior: 'open_conversation' }] }, book,
      moment({ channelAllowed: allowed, mayInitiate: () => false, ownerLine: true, channelKnown: () => false, knownChannels: () => ['qq:1:private:7'] }))
    expect(unknown).toEqual({ allowed: false, code: GateCode.unknownChannel, hint: 'no channel "qq:owner:private:owner". Channels you can reach: qq:1:private:7.' })
  })
  it('takes an allowed, known key on to consent and then approval', () => {
    const policy = { quotas: [], allow: [], approve: [{ behavior: 'open_conversation' }] }
    const known = { channelAllowed: () => true, channelKnown: () => true, ownerLine: true }
    const target = { channel: 'qq:1:private:7' }
    expect(decide(call('open_conversation', open, self, target), policy, book, moment({ ...known, mayInitiate: () => false }))).toMatchObject({ code: GateCode.noConsent })
    expect(decide(call('open_conversation', open, self, target), policy, book, moment({ ...known, mayInitiate: () => true }))).toMatchObject({ allowed: true, approval: expect.any(String) })
  })
  it('asks for approval only when an owner line exists, after the other checks', () => {
    const post: BehaviorMeta = { effect: 'public', sessions: ['self'] }
    expect(decide(call('core_post', post, self), { quotas: [], allow: [] }, book, moment())).toMatchObject({ code: GateCode.needsApproval })
    expect(decide(call('core_post', post, self), { quotas: [], allow: [] }, book, moment({ ownerLine: true }))).toMatchObject({ allowed: true, approval: expect.stringContaining('public') })
    expect(decide(call('core_post', post, self), { quotas: [], allow: [{ behavior: 'core_post' }] }, book, moment({ ownerLine: true }))).toEqual({ allowed: true })
    // Forced approval for any effect class.
    expect(decide(call('open_conversation', open, self, { channel: 'x' }), { quotas: [], allow: [], approve: [{ behavior: 'open_conversation' }] }, book, moment({ ownerLine: true }))).toMatchObject({ allowed: true, approval: expect.stringContaining('approve every open_conversation') })
    // A night refusal comes first.
    expect(decide(call('core_post', post, self), { quotas: [], allow: [], allowedEffects: { day: [], night: ['internal'] } }, book, moment({ ownerLine: true, mode: 'night' }))).toMatchObject({ code: GateCode.night })
  })
  it('counts per-channel quotas against the target channel', () => {
    const wake: BehaviorMeta = { effect: 'internal', sessions: ['group-triage'], target: args => args.channel as string }
    const triage: SessionInfo = { kind: 'group-triage' }
    const quotas = [{ behavior: 'group_wake', per: 'channel' as const, limit: 1, windowMinutes: 60 }]
    const books = new QuotaBook()
    const a = call('group_wake', wake, triage, { channel: 'qq:1:group:9' })
    expect(decide(a, { quotas, allow: [] }, books).allowed).toBe(true)
    books.record(a, quotas)
    expect(decide(a, { quotas, allow: [] }, books)).toMatchObject({ code: GateCode.overQuota })
    expect(decide(call('group_wake', wake, triage, { channel: 'qq:1:group:8' }), { quotas, allow: [] }, books).allowed).toBe(true)
  })
})

describe('service: owner line', () => {
  it('awaits the owner in pre-execute and consumes reply commands', async () => {
    const ctx = await setupCore({ approve: [{ behavior: 'core_note' }], approvals: { timeoutSeconds: 30 } })
    provideSessions(ctx, { s1: { kind: 'self' } })
    registerEcho(ctx, 'core_note', { effect: 'internal', sessions: ['self'] })
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test line', send: async (text) => { sent.push(text) } })

    const pending = callAs(ctx, 's1', 'core_note', { text: 'hi' })
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]).toContain('core_note')
    const id = /approval (a\d+)/.exec(sent[0]!)![1]!
    expect(ctx.anima.statusText()).toContain(`Pending approvals: ${id}`)
    expect(ctx.anima.handleOwnerReply('hello there')).toBeUndefined()
    expect(ctx.anima.handleOwnerReply(`yes ${id}`)).toBe(`Allowed ${id}.`)
    expect((await pending).isError).toBe(false)

    const refused = callAs(ctx, 's1', 'core_note', { text: 'again' })
    await vi.waitFor(() => expect(sent.length).toBe(2))
    const id2 = /approval (a\d+)/.exec(sent[1]!)![1]!
    expect(id2).not.toBe(id)
    expect(ctx.anima.handleOwnerReply(`no ${id2}`)).toBe(`Denied ${id2}.`)
    const result = await refused
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('anima/denied')
    expect(ctx.anima.handleOwnerReply('cancel o9')).toBe('No pending request o9.')
  })

  it('denies an unknown target with the reachable keys, without asking the owner', async () => {
    const ctx = await setupCore({ approve: [{ behavior: 'core_open' }] })
    provideSessions(ctx, { s1: { kind: 'self' } })
    const known = ['qq:1:private:7', 'qq:1:group:9']
    ctx.anima.provideChannels(key => known.includes(key) ? { isOwner: key === 'qq:1:private:7' } : undefined, () => known)
    ctx.anima.restrictChannels('qq', key => key === 'qq:1:private:7')
    registerEcho(ctx, 'core_open', { effect: 'initiate', sessions: ['self'], target: args => args.text as string })
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test', send: async (text) => { sent.push(text) } })
    expect(textOf(await callAs(ctx, 's1', 'core_open', { text: 'qq:list' }))).toBe('Error: anima/unknown-channel: no channel "qq:list". Channels you can reach: qq:1:private:7.')
    expect(textOf(await callAs(ctx, 's1', 'core_open', { text: 'qq:1:group:9' }))).toContain('anima/not-allowlisted')
    expect(sent).toEqual([])
    expect(ctx.anima.todayLedger().initiates).toBe(0)
  })

  it('refuses approval-class calls without an owner line', async () => {
    const ctx = await setupCore({ approve: [{ behavior: 'core_note' }] })
    provideSessions(ctx, { s1: { kind: 'self' } })
    registerEcho(ctx, 'core_note', { effect: 'internal', sessions: ['self'] })
    expect(textOf(await callAs(ctx, 's1', 'core_note'))).toContain('anima/needs-approval')
  })

  it('applies a platform allowlist to its behaviors', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { g: qqChat })
    registerEcho(ctx, 'qq_say', say)
    const off = ctx.anima.restrictChannels('qq', key => key !== 'qq:1:group:9')
    expect(textOf(await callAs(ctx, 'g', 'qq_say'))).toContain('anima/not-allowlisted')
    expect(ctx.anima.channelAllowed('qq:1:group:9')).toBe(false)
    expect(ctx.anima.channelAllowed('local:owner:private:owner')).toBeUndefined()
    off()
    expect((await callAs(ctx, 'g', 'qq_say')).isError).toBe(false)
  })

  it('counts an initiate only when the behavior succeeds', async () => {
    const ctx = await setupCore()
    provideSessions(ctx, { s1: { kind: 'self' } })
    let fail = true
    ctx.anima.registerBehavior(defineTool({
      name: 'core_open', description: 'test', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { if (fail) throw new Error('no such channel'); return { ok: true } },
    }), { effect: 'initiate', sessions: ['self'] })
    expect((await callAs(ctx, 's1', 'core_open')).isError).toBe(true)
    expect(ctx.anima.todayLedger().initiates).toBe(0)
    fail = false
    expect((await callAs(ctx, 's1', 'core_open')).isError).toBe(false)
    expect(ctx.anima.todayLedger().initiates).toBe(1)
  })
})
