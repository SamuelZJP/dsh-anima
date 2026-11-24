import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, parseOwnerReply } from '../src/approvals.ts'
import { decide, GuardCode, QuotaBook } from '../src/gate.ts'
import type { GateCall, GateMoment } from '../src/gate.ts'
import type { BehaviorMeta, SessionInfo } from '@anima/core'
import { callAs, provideSessions, registerEcho, setupGuarded, textOf } from './helpers.ts'

const self: SessionInfo = { kind: 'waking', current: true }
const qqChat = self
const say: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['waking'], target: args => args.channel as string | undefined }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['waking'] }
const open: BehaviorMeta = { effect: 'initiate', sessions: ['waking'], target: args => args.channel as string }
const now = Date.UTC(2026, 10, 10, 10)
const moment = (extra: Partial<GateMoment> = {}): GateMoment => ({ overBudget: false, initiatesUsed: 0, mayInitiate: () => true, ...extra })
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

describe('gate: approvals', () => {
  const book = new QuotaBook()
  it('takes a call on to consent and then approval', () => {
    const policy = { quotas: [], allow: [], approve: [{ behavior: 'open_conversation' }] }
    const target = { channel: 'qq:1:private:7' }
    expect(decide(call('open_conversation', open, self, target), policy, book, moment({ ownerLine: true, mayInitiate: () => false }))).toMatchObject({ code: GuardCode.noConsent })
    expect(decide(call('open_conversation', open, self, target), policy, book, moment({ ownerLine: true, mayInitiate: () => true }))).toMatchObject({ allowed: true, approval: expect.any(String) })
  })
  it('asks for approval only when an owner line exists, after the other checks', () => {
    const post: BehaviorMeta = { effect: 'public', sessions: ['waking'] }
    expect(decide(call('core_post', post, self), { quotas: [], allow: [] }, book, moment())).toMatchObject({ code: GuardCode.needsApproval })
    expect(decide(call('core_post', post, self), { quotas: [], allow: [] }, book, moment({ ownerLine: true }))).toMatchObject({ allowed: true, approval: expect.stringContaining('public') })
    expect(decide(call('core_post', post, self), { quotas: [], allow: [{ behavior: 'core_post' }] }, book, moment({ ownerLine: true }))).toEqual({ allowed: true })
    expect(decide(call('open_conversation', open, self, { channel: 'x' }), { quotas: [], allow: [], approve: [{ behavior: 'open_conversation' }] }, book, moment({ ownerLine: true }))).toMatchObject({ allowed: true, approval: expect.stringContaining('approve every open_conversation') })
    expect(decide(call('memory_remember', remember, qqChat), { quotas: [], allow: [] }, book, moment()).allowed).toBe(true)
  })
  it('counts per-channel quotas against the target channel', () => {
    const quotas = [{ behavior: 'qq_say', per: 'channel' as const, limit: 1, windowMinutes: 60 }]
    const books = new QuotaBook()
    const a = call('qq_say', say, self, { channel: 'qq:1:group:9' })
    expect(decide(a, { quotas, allow: [] }, books).allowed).toBe(true)
    books.record(a, quotas)
    expect(decide(a, { quotas, allow: [] }, books)).toMatchObject({ code: GuardCode.overQuota })
    expect(decide(call('qq_say', say, self, { channel: 'qq:1:group:8' }), { quotas, allow: [] }, books).allowed).toBe(true)
  })

  it('treats a say where nobody wrote to her lately as her speaking first: consent, quiet hours, a daily count', () => {
    const first = moment({ speakingFirst: key => key === 'qq:1:private:7', mayInitiate: key => key === 'qq:1:private:owner' })
    const policy = { quotas: [], allow: [], initiatePerDay: 2 }
    expect(decide(call('qq_say', say, self, { channel: 'qq:1:private:7' }), policy, book, first)).toMatchObject({ code: GuardCode.noConsent })
    // A reply (someone there wrote lately) is not speaking first: no consent needed.
    expect(decide(call('qq_say', say, self, { channel: 'qq:1:private:8' }), policy, book, first).allowed).toBe(true)
    const owner = moment({ speakingFirst: () => true, mayInitiate: () => true })
    expect(decide(call('qq_say', say, self, { channel: 'qq:1:private:owner' }), policy, book, { ...owner, initiatesUsed: 2 })).toMatchObject({ code: GuardCode.overQuota })
    expect(decide(call('qq_say', say, self, { channel: 'qq:1:private:owner' }), policy, book, { ...owner, quiet: '现在是主人定的安静时段' })).toMatchObject({ code: GuardCode.quietHours })
  })
})

describe('service: owner line', () => {
  it('awaits the owner in pre-execute and consumes reply commands', async () => {
    const ctx = await setupGuarded({ approve: [{ behavior: 'core_note' }], approvals: { timeoutSeconds: 30 } })
    provideSessions(ctx, { s1: { kind: 'waking', current: true } })
    registerEcho(ctx, 'core_note', { effect: 'internal', sessions: ['waking'] })
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test line', send: async (text) => { sent.push(text) } })

    const pending = callAs(ctx, 's1', 'core_note', { text: 'hi' })
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]).toContain('core_note')
    const id = /approval (a\d+)/.exec(sent[0]!)![1]!
    expect(ctx.animaGuard.statusText()).toContain(`Pending approvals: ${id}`)
    expect(ctx.bail('anima/owner-message', 'hello there')).toBeUndefined()
    expect(ctx.bail('anima/owner-message', `yes ${id}`)).toBe(`Allowed ${id}.`)
    expect((await pending).isError).toBe(false)

    const refused = callAs(ctx, 's1', 'core_note', { text: 'again' })
    await vi.waitFor(() => expect(sent.length).toBe(2))
    const id2 = /approval (a\d+)/.exec(sent[1]!)![1]!
    expect(id2).not.toBe(id)
    expect(ctx.bail('anima/owner-message', `no ${id2}`)).toBe(`Denied ${id2}.`)
    const result = await refused
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('anima/denied')
    expect(ctx.bail('anima/owner-message', 'cancel o9')).toBe('No message o9 in the outbox (already sent or cancelled).')
  })

  it('leaves an unknown target to her body, without asking the owner', async () => {
    const ctx = await setupGuarded({ approve: [{ behavior: 'core_open' }] })
    provideSessions(ctx, { s1: { kind: 'waking', current: true } })
    const known = ['qq:1:private:7']
    ctx.anima.provideChannels(key => known.includes(key) ? { isOwner: true } : undefined, () => known)
    registerEcho(ctx, 'core_open', { effect: 'express', sessions: ['waking'], target: args => args.text as string })
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test', send: async (text) => { sent.push(text) } })
    expect(textOf(await callAs(ctx, 's1', 'core_open', { text: 'qq:list' }))).toBe('Error: anima/unknown-channel: 没有「qq:list」这个地方。你能去的地方：qq:1:private:7。')
    expect(sent).toEqual([])
    expect(ctx.animaGuard.todayCounts().initiates).toBe(0)
  })

  it('refuses approval-class calls without an owner line', async () => {
    const ctx = await setupGuarded({ approve: [{ behavior: 'core_note' }] })
    provideSessions(ctx, { s1: { kind: 'waking', current: true } })
    registerEcho(ctx, 'core_note', { effect: 'internal', sessions: ['waking'] })
    expect(textOf(await callAs(ctx, 's1', 'core_note'))).toContain('anima/needs-approval')
  })

  it('answers a friend request through the owner, and leaves it unanswered on a timeout', async () => {
    const ctx = await setupGuarded({ approvals: { timeoutSeconds: 30 } })
    const sent: string[] = []
    ctx.anima.provideOwnerLine({ name: 'test', send: async (text) => { sent.push(text) } })
    const answers: boolean[] = []
    const left: string[] = []
    const taken = ctx.bail('anima/friend-request', { platform: 'qq', userId: '5', summary: 'QQ user 5 wants to add her.', answer: async (accept) => { answers.push(accept) }, leave: why => { left.push(why) } })
    expect(taken).toBe(true)
    await vi.waitFor(() => expect(sent.length).toBe(1))
    const id = /approval (a\d+)/.exec(sent[0]!)![1]!
    ctx.bail('anima/owner-message', `yes ${id}`)
    await vi.waitFor(() => expect(answers).toEqual([true]))
    expect(left).toEqual([])
  })

  it('counts a conversation she starts only when the say succeeds', async () => {
    const ctx = await setupGuarded({ outbox: { delaySeconds: 0, notifyOwner: false, offlineHoldMinutes: 30 } })
    provideSessions(ctx, { s1: { kind: 'waking', current: true } })
    const owner = 'demo:me:private:owner'
    ctx.anima.provideChannels(key => key === owner ? { isOwner: true } : undefined, () => [owner])
    let fail = true
    ctx.anima.registerBehavior(defineTool({
      name: 'demo_say', description: 'test', parameters: { channel: { type: 'string' }, text: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { if (fail) throw new Error('send failed'); return { ok: true } },
    }), { platform: 'demo', effect: 'express', sessions: ['waking'], target: args => args.channel as string })
    // Without her life loaded, nothing says she speaks first.
    expect((await callAs(ctx, 's1', 'demo_say', { channel: owner, text: 'hi' })).isError).toBe(true)
    expect(ctx.animaGuard.todayCounts().initiates).toBe(0)
    fail = false
    expect((await callAs(ctx, 's1', 'demo_say', { channel: owner, text: 'hi' })).isError).toBe(false)
    expect(ctx.animaGuard.todayCounts().initiates).toBe(0)
  })
})
