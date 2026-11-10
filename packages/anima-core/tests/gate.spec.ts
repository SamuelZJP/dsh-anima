import { describe, expect, it } from 'vitest'
import { decide, GateCode, QuotaBook, visibleIn } from '../src/gate.ts'
import type { Policy, GateCall } from '../src/gate.ts'
import type { BehaviorMeta, SessionInfo } from '../src/types.ts'

const local = { platform: 'local', account: 'owner', kind: 'private', id: 'owner' }
const qq = { platform: 'qq', account: '1', kind: 'private', id: '2' }
const localChat: SessionInfo = { kind: 'conversation', channel: local, channelKey: 'local:owner:private:owner' }
const qqChat: SessionInfo = { kind: 'conversation', channel: qq, channelKey: 'qq:1:private:2' }
const self: SessionInfo = { kind: 'self' }

const say: BehaviorMeta = { platform: 'local', effect: 'express', sessions: ['conversation'] }
const browse: BehaviorMeta = { platform: 'local', effect: 'observe', sessions: ['conversation', 'self'] }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['conversation', 'self'] }
const post: BehaviorMeta = { platform: 'local', effect: 'public', sessions: ['self'] }
const open: BehaviorMeta = { effect: 'initiate', sessions: ['self'] }

const open_policy: Policy = { quotas: [], allow: [] }
const T0 = Date.UTC(2026, 10, 9, 12)

function call(name: string, meta: BehaviorMeta, session: SessionInfo | undefined, now = T0): GateCall {
  return { name, meta, session, now }
}

describe('visibleIn', () => {
  it('hides every behavior outside Anima sessions', () => {
    expect(visibleIn(remember, undefined)).toBe(false)
  })
  it('shows a conversation only its own platform', () => {
    expect(visibleIn(say, localChat)).toBe(true)
    expect(visibleIn(say, qqChat)).toBe(false)
    expect(visibleIn(remember, qqChat)).toBe(true)
  })
  it('shows Self only platform observe behaviors', () => {
    expect(visibleIn(browse, self)).toBe(true)
    expect(visibleIn(post, self)).toBe(false)
    expect(visibleIn(remember, self)).toBe(true)
  })
  it('respects the session kinds', () => {
    expect(visibleIn(say, self)).toBe(false)
    expect(visibleIn(open, localChat)).toBe(false)
  })
})

describe('decide', () => {
  const book = new QuotaBook()
  const cases: [string, GateCall, Policy, string | undefined][] = [
    ['allows a fitting call', call('local_say', say, localChat), open_policy, undefined],
    ['refuses outside Anima sessions', call('local_say', say, undefined), open_policy, GateCode.notAnimaSession],
    ['refuses the wrong session kind', call('local_say', say, self), open_policy, GateCode.wrongSession],
    ['refuses initiate from a conversation', call('open_conversation', open, localChat), open_policy, GateCode.wrongSession],
    ['refuses another platform', call('local_say', say, qqChat), open_policy, GateCode.wrongPlatform],
    ['refuses a platform public behavior from Self', call('local_post', post, self), open_policy, GateCode.wrongPlatform],
    ['refuses public without an owner rule', call('local_post', { ...post, sessions: ['self'], effect: 'public', platform: undefined } as BehaviorMeta, self), open_policy, GateCode.needsApproval],
    ['allows public with an owner rule', call('core_post', { effect: 'public', sessions: ['self'] }, self), { quotas: [], allow: [{ behavior: 'core_post' }] }, undefined],
    ['refuses irreversible without a rule', call('core_delete', { effect: 'irreversible', sessions: ['self'] }, self), open_policy, GateCode.needsApproval],
  ]
  for (const [title, input, policy, code] of cases) {
    it(title, () => {
      const verdict = decide(input, policy, book)
      if (code === undefined) expect(verdict).toEqual({ allowed: true })
      else expect(verdict).toMatchObject({ allowed: false, code })
    })
  }

  it('gives a hint she can act on', () => {
    const verdict = decide(call('local_say', say, self), open_policy, book)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.hint).toContain('conversation')
  })
})

describe('quotas', () => {
  const policy: Policy = { quotas: [{ effect: 'express', per: 'channel', limit: 2, windowMinutes: 10 }], allow: [] }

  it('refuses the call over the limit and frees it after the window', () => {
    const book = new QuotaBook()
    for (const minute of [0, 1]) {
      const c = call('local_say', say, localChat, T0 + minute * 60_000)
      expect(decide(c, policy, book).allowed).toBe(true)
      book.record(c, policy.quotas)
    }
    const third = decide(call('local_say', say, localChat, T0 + 2 * 60_000), policy, book)
    expect(third).toMatchObject({ allowed: false, code: GateCode.overQuota })
    if (!third.allowed) expect(third.hint).toContain('next slot in about 8 min')
    // The first call ages out at minute 10.
    expect(decide(call('local_say', say, localChat, T0 + 10 * 60_000 + 1), policy, book).allowed).toBe(true)
  })

  it('keeps one counter per channel', () => {
    const book = new QuotaBook()
    const other: SessionInfo = { kind: 'conversation', channel: { ...local, id: 'friend' }, channelKey: 'local:owner:private:friend' }
    for (let i = 0; i < 2; i++) book.record(call('local_say', say, localChat), policy.quotas)
    expect(decide(call('local_say', say, localChat), policy, book).allowed).toBe(false)
    expect(decide(call('local_say', say, other), policy, book).allowed).toBe(true)
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
    book.record(call('local_say', say, localChat), policy.quotas)
    expect(book.usage(policy.quotas, T0)).toEqual(['express: 2 per 10 min per channel — channel:local:owner:private:owner 1'])
  })
})

describe('Phase 2 gate checks', () => {
  const policy: Policy = { quotas: [], allow: [], allowedEffects: { day: ['observe', 'internal', 'express', 'initiate'], night: ['observe', 'internal'] }, initiatePerDay: 3 }
  const openConversation: BehaviorMeta = { effect: 'initiate', sessions: ['self'], target: args => args.channel as string }
  const act: BehaviorMeta = { effect: 'internal', sessions: ['triage'], modes: ['day'] }
  const triage: SessionInfo = { kind: 'triage' }
  const day = { mode: 'day' as const, overBudget: false, initiatesUsed: 0, mayInitiate: (key: string) => key === 'local:owner:private:owner' }
  const book = new QuotaBook()
  const withArgs = (c: GateCall, args: Record<string, unknown>): GateCall => ({ ...c, args })
  const toOwner = withArgs(call('open_conversation', openConversation, self), { channel: 'local:owner:private:owner' })

  it('allows initiating with the owner by day within budget', () => {
    expect(decide(toOwner, policy, book, day)).toEqual({ allowed: true })
  })

  it('refuses the fourth conversation of the day', () => {
    expect(decide(toOwner, policy, book, { ...day, initiatesUsed: 3 })).toMatchObject({ allowed: false, code: GateCode.overQuota })
  })

  it('refuses initiating in quiet hours', () => {
    const verdict = decide(toOwner, policy, book, { ...day, quiet: 'it is quiet hours' })
    expect(verdict).toMatchObject({ allowed: false, code: GateCode.quietHours })
  })

  it('refuses initiating without consent', () => {
    const stranger = withArgs(call('open_conversation', openConversation, self), { channel: 'qq:1:private:99' })
    expect(decide(stranger, policy, book, day)).toMatchObject({ allowed: false, code: GateCode.noConsent })
  })

  it('allows only observe and internal at night, and day-only behaviors by day', () => {
    const night = { ...day, mode: 'night' as const }
    expect(decide(toOwner, policy, book, night)).toMatchObject({ allowed: false, code: GateCode.night })
    expect(decide(call('heartbeat_act', act, triage), policy, book, night)).toMatchObject({ allowed: false, code: GateCode.night })
    expect(decide(call('heartbeat_act', act, triage), policy, book, day).allowed).toBe(true)
    expect(decide(call('rest', { effect: 'internal', sessions: ['triage'] }, triage), policy, book, night).allowed).toBe(true)
    expect(visibleIn(act, triage, 'night')).toBe(false)
    expect(visibleIn(act, triage, 'day')).toBe(true)
  })

  it('lets only internal behaviors run past the token budget', () => {
    const spent = { ...day, overBudget: true }
    expect(decide(call('local_say', say, localChat), policy, book, spent)).toMatchObject({ allowed: false, code: GateCode.overBudget })
    expect(decide(call('rest', remember, self), policy, book, spent).allowed).toBe(true)
  })

  it('applies argument constraints', () => {
    const schedule: BehaviorMeta = { effect: 'internal', sessions: ['self'], constraint: args => args.target === 'this_session' ? undefined : 'use this_session' }
    expect(decide(withArgs(call('schedule_create', schedule, self), { target: 'new' }), policy, book, day)).toMatchObject({ allowed: false, code: GateCode.notAllowed, hint: 'use this_session' })
    expect(decide(withArgs(call('schedule_create', schedule, self), { target: 'this_session' }), policy, book, day).allowed).toBe(true)
  })
})
