import type { BehaviorMeta, SessionInfo } from '@anima/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_QUOTAS } from '../src/config.ts'
import { decide, GuardCode, QuotaBook } from '../src/gate.ts'
import type { GateCall, GateMoment, Policy } from '../src/gate.ts'

/** A chat, by its channel key: the call comes from her waking session with `channel` set to it. */
const localChat = 'demo:owner:private:owner'
const qqChat = 'qq:1:private:2'
const self: SessionInfo = { kind: 'waking', current: true }
const target = (args: Readonly<Record<string, unknown>>) => args.channel as string | undefined

const say: BehaviorMeta = { platform: 'demo', effect: 'express', sessions: ['waking'], target }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['waking'] }

const openPolicy: Policy = { quotas: [], allow: [] }
const T0 = Date.UTC(2026, 10, 9, 12)

function call(name: string, meta: BehaviorMeta, where: SessionInfo | string | undefined, now = T0): GateCall {
  if (typeof where === 'string') return { name, meta, session: self, now, args: { channel: where } }
  return { name, meta, session: where, now }
}

describe('decide', () => {
  const book = new QuotaBook()
  it('allows a fitting call', () => {
    expect(decide(call('demo_say', say, localChat), openPolicy, book)).toEqual({ allowed: true })
  })
  it('refuses public without an owner rule, and allows it with one', () => {
    const post: BehaviorMeta = { effect: 'public', sessions: ['waking'] }
    expect(decide(call('core_post', post, self), openPolicy, book)).toMatchObject({ allowed: false, code: GuardCode.needsApproval })
    expect(decide(call('core_post', post, self), { quotas: [], allow: [{ behavior: 'core_post' }] }, book)).toEqual({ allowed: true })
  })
  it('refuses irreversible without a rule', () => {
    expect(decide(call('core_delete', { effect: 'irreversible', sessions: ['waking'] }, self), openPolicy, book)).toMatchObject({ allowed: false, code: GuardCode.needsApproval })
  })
  it('says a refusal comes from outside', () => {
    const verdict = decide(call('core_delete', { effect: 'irreversible', sessions: ['waking'] }, self), openPolicy, book)
    if (!verdict.allowed) expect(verdict.hint.startsWith('（外面拦住了你，不是你自己的身体）')).toBe(true)
  })
})

describe('quotas', () => {
  const policy: Policy = { quotas: [{ effect: 'express', per: 'channel', limit: 2, windowMinutes: 10 }], allow: [] }

  it('refuses the call over the limit and frees it after the window', () => {
    const book = new QuotaBook()
    for (const minute of [0, 1]) {
      const c = call('demo_say', say, localChat, T0 + minute * 60_000)
      expect(decide(c, policy, book).allowed).toBe(true)
      book.record(c, policy.quotas)
    }
    const third = decide(call('demo_say', say, localChat, T0 + 2 * 60_000), policy, book)
    expect(third).toMatchObject({ allowed: false, code: GuardCode.overQuota })
    if (!third.allowed) expect(third.hint).toContain('大约 8 分钟后才行')
    expect(decide(call('demo_say', say, localChat, T0 + 10 * 60_000 + 1), policy, book).allowed).toBe(true)
  })

  it('keeps one counter per channel', () => {
    const book = new QuotaBook()
    const other = 'demo:owner:private:friend'
    for (let i = 0; i < 2; i++) book.record(call('demo_say', say, localChat), policy.quotas)
    expect(decide(call('demo_say', say, localChat), policy, book).allowed).toBe(false)
    expect(decide(call('demo_say', say, other), policy, book).allowed).toBe(true)
  })

  it('counts only matching effects and weighs cost', () => {
    const book = new QuotaBook()
    const global: Policy = { quotas: [{ per: 'global', limit: 3, windowMinutes: 60 }], allow: [] }
    const costly: BehaviorMeta = { ...remember, cost: 2 }
    book.record(call('memory_x', costly, self), global.quotas)
    expect(decide(call('memory_x', costly, self), global, book).allowed).toBe(false)
    expect(decide(call('memory_y', remember, self), global, book).allowed).toBe(true)
    expect(decide(call('memory_x', costly, self), policy, book).allowed).toBe(true)
  })

  it('reports usage per rule', () => {
    const book = new QuotaBook()
    book.record(call('demo_say', say, localChat), policy.quotas)
    expect(book.usage(policy.quotas, T0)).toEqual(['express: 2 per 10 min per channel — channel:demo:owner:private:owner 1'])
  })

  it('gives qq_poke and qq_react their own per-channel keys by default', () => {
    const book = new QuotaBook()
    const poke: BehaviorMeta = { platform: 'qq', effect: 'express', sessions: ['waking'], target }
    const at = (name: string, n: number): GateCall => ({ name, meta: poke, session: self, now: T0 + n, args: { channel: qqChat } })
    for (let i = 0; i < 3; i++) {
      expect(decide(at('qq_poke', i), { quotas: DEFAULT_QUOTAS, allow: [] }, book).allowed).toBe(true)
      book.record(at('qq_poke', i), DEFAULT_QUOTAS)
    }
    expect(decide(at('qq_poke', 4), { quotas: DEFAULT_QUOTAS, allow: [] }, book)).toMatchObject({ allowed: false, code: GuardCode.overQuota })
    expect(decide(at('qq_react', 5), { quotas: DEFAULT_QUOTAS, allow: [] }, book).allowed).toBe(true)
  })

  it('has no self_note quota: her self-model\'s pace is physiology, inside the persona', () => {
    expect(DEFAULT_QUOTAS.some(rule => rule.behavior === 'self_note')).toBe(false)
  })
})

describe('conversations she starts', () => {
  const policy: Policy = { quotas: [], allow: [], initiatePerDay: 3 }
  const openConversation: BehaviorMeta = { effect: 'initiate', sessions: ['waking'], target: args => args.channel as string }
  const day: GateMoment = { overBudget: false, initiatesUsed: 0, mayInitiate: key => key === 'demo:owner:private:owner' }
  const book = new QuotaBook()
  const to = (channel: string): GateCall => ({ ...call('open_conversation', openConversation, self), args: { channel } })

  it('allows starting one with the owner within budget', () => {
    expect(decide(to('demo:owner:private:owner'), policy, book, day)).toEqual({ allowed: true })
  })
  it('refuses the fourth of the day', () => {
    expect(decide(to('demo:owner:private:owner'), policy, book, { ...day, initiatesUsed: 3 })).toMatchObject({ allowed: false, code: GuardCode.overQuota })
  })
  it('refuses in quiet hours', () => {
    expect(decide(to('demo:owner:private:owner'), policy, book, { ...day, quiet: 'quiet' })).toMatchObject({ allowed: false, code: GuardCode.quietHours })
  })
  it('refuses without consent', () => {
    expect(decide(to('qq:1:private:99'), policy, book, day)).toMatchObject({ allowed: false, code: GuardCode.noConsent })
  })
  it('lets only internal behaviors run past the token budget', () => {
    const spent = { ...day, overBudget: true }
    expect(decide(call('demo_say', say, localChat), policy, book, spent)).toMatchObject({ allowed: false, code: GuardCode.overBudget })
    expect(decide(call('rest', remember, self), policy, book, spent).allowed).toBe(true)
  })
})

describe('approve rules', () => {
  const book = new QuotaBook()
  const openConversation: BehaviorMeta = { effect: 'initiate', sessions: ['waking'], target: args => args.channel as string }
  const owner = 'qq:1:private:2'
  const friend = 'qq:1:private:3'
  const moment: GateMoment = { overBudget: false, initiatesUsed: 0, mayInitiate: () => true, ownerLine: true, ownerChannel: key => key === owner }
  const policy: Policy = { quotas: [], allow: [], approve: [{ behavior: 'open_conversation', targets: 'others' }] }
  const to = (channel: string): GateCall => ({ name: 'open_conversation', meta: openConversation, session: self, now: T0, args: { channel } })

  it('with targets: others, lets calls toward the owner through', () => {
    expect(decide(to(owner), policy, book, moment)).toEqual({ allowed: true })
  })
  it('asks the owner before a call toward anyone else', () => {
    expect(decide(to(friend), policy, book, moment)).toMatchObject({ allowed: true, approval: expect.stringContaining('someone other than the owner') })
  })
  it('refuses it without an owner line', () => {
    expect(decide(to(friend), policy, book, { ...moment, ownerLine: false })).toMatchObject({ allowed: false, code: GuardCode.needsApproval })
  })
  it('keeps targets: all approving every call', () => {
    expect(decide(to(owner), { ...policy, approve: [{ behavior: 'open_conversation' }] }, book, moment)).toMatchObject({ allowed: true, approval: expect.any(String) })
  })
})
