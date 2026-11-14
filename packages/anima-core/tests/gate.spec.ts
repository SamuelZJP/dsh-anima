import { describe, expect, it } from 'vitest'
import { bodyCheck, GateCode, visibleIn } from '../src/gate.ts'
import type { BodyCall, BodyMoment } from '../src/gate.ts'
import type { BehaviorMeta, SessionInfo } from '../src/types.ts'

const local = { platform: 'local', account: 'owner', kind: 'private', id: 'owner' }
const qq = { platform: 'qq', account: '1', kind: 'private', id: '2' }
const localChat: SessionInfo = { kind: 'conversation', channel: local, channelKey: 'local:owner:private:owner' }
const qqChat: SessionInfo = { kind: 'conversation', channel: qq, channelKey: 'qq:1:private:2' }
const self: SessionInfo = { kind: 'self' }
const triage: SessionInfo = { kind: 'triage' }

const say: BehaviorMeta = { platform: 'local', effect: 'express', sessions: ['conversation'] }
const browse: BehaviorMeta = { platform: 'local', effect: 'observe', sessions: ['conversation', 'self'] }
const remember: BehaviorMeta = { effect: 'internal', sessions: ['conversation', 'self'] }
const post: BehaviorMeta = { platform: 'local', effect: 'public', sessions: ['self'] }
const open: BehaviorMeta = { effect: 'initiate', sessions: ['self'], target: args => args.channel as string }

const day: BodyMoment = { mode: 'day', allowedEffects: { day: ['observe', 'internal', 'express', 'initiate', 'public'], night: ['observe', 'internal'] } }

function call(name: string, meta: BehaviorMeta, session: SessionInfo | undefined, args: Record<string, unknown> = {}): BodyCall {
  return { name, meta, session, args }
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

describe('bodyCheck', () => {
  const cases: [string, BodyCall, string | undefined][] = [
    ['allows a fitting call', call('local_say', say, localChat), undefined],
    ['refuses outside Anima sessions', call('local_say', say, undefined), GateCode.notAnimaSession],
    ['refuses the wrong session kind', call('local_say', say, self), GateCode.wrongSession],
    ['refuses initiate from a conversation', call('open_conversation', open, localChat), GateCode.wrongSession],
    ['refuses another platform', call('local_say', say, qqChat), GateCode.wrongPlatform],
    ['refuses a platform public behavior from Self', call('local_post', post, self), GateCode.wrongPlatform],
    ['has no safety rule: a public behavior is the outside\'s business', call('core_post', { effect: 'public', sessions: ['self'] }, self), undefined],
  ]
  for (const [title, input, code] of cases) {
    it(title, () => {
      const verdict = bodyCheck(input, day)
      if (code === undefined) expect(verdict).toEqual({ allowed: true })
      else expect(verdict).toMatchObject({ allowed: false, code })
    })
  }

  it('gives a hint she can act on', () => {
    const verdict = bodyCheck(call('local_say', say, self), day)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.hint).toContain('聊天')
  })

  it('allows only observe and internal while she sleeps, and day-only behaviors by day', () => {
    const act: BehaviorMeta = { effect: 'internal', sessions: ['triage'], modes: ['day'] }
    const night: BodyMoment = { ...day, mode: 'night' }
    expect(bodyCheck(call('open_conversation', open, self, { channel: 'x' }), night)).toMatchObject({ allowed: false, code: GateCode.night })
    expect(bodyCheck(call('heartbeat_act', act, triage), night)).toMatchObject({ allowed: false, code: GateCode.night })
    expect(bodyCheck(call('heartbeat_act', act, triage), day).allowed).toBe(true)
    expect(bodyCheck(call('rest', { effect: 'internal', sessions: ['triage'] }, triage), night).allowed).toBe(true)
    expect(visibleIn(act, triage, 'night')).toBe(false)
    expect(visibleIn(act, triage, 'day')).toBe(true)
  })

  it('refuses a target that does not exist, listing what does', () => {
    const moment: BodyMoment = { ...day, channelKnown: key => key === 'qq:1:private:2', knownChannels: () => ['qq:1:private:2'] }
    const verdict = bodyCheck(call('open_conversation', open, self, { channel: 'qq:1:private:9' }), moment)
    expect(verdict).toMatchObject({ allowed: false, code: GateCode.unknownChannel, hint: expect.stringContaining('qq:1:private:2') })
    expect(bodyCheck(call('open_conversation', open, self, { channel: 'qq:1:private:2' }), moment).allowed).toBe(true)
  })

  it('applies argument constraints', () => {
    const schedule: BehaviorMeta = { effect: 'internal', sessions: ['self'], constraint: args => args.target === 'this_session' ? undefined : 'use this_session' }
    expect(bodyCheck(call('schedule_create', schedule, self, { target: 'new' }), day)).toMatchObject({ allowed: false, code: GateCode.notAllowed, hint: 'use this_session' })
    expect(bodyCheck(call('schedule_create', schedule, self, { target: 'this_session' }), day).allowed).toBe(true)
  })
})
