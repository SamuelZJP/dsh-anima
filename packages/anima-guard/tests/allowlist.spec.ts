import { describe, expect, it } from 'vitest'
import { onAllowlist, resolveGuardConfig } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupGuarded, textOf } from './helpers.ts'

const alice = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '30003' }, channelKey: 'qq:1:private:30003' } as const
const bob = { kind: 'conversation', channel: { platform: 'qq', account: '1', kind: 'private', id: '40004' }, channelKey: 'qq:1:private:40004' } as const

describe('the allowlist (outside the persona)', () => {
  it('lets the owner through always, a listed platform by user and group, and an unlisted platform not at all', () => {
    const list = resolveGuardConfig({ allowlist: { qq: { open: false, users: ['30003'], groups: ['50005'] } } }).allowlist
    expect(onAllowlist(list, 'qq:1:private:30003', false)).toBe(true)
    expect(onAllowlist(list, 'qq:1:group:50005', false)).toBe(true)
    expect(onAllowlist(list, 'qq:1:private:40004', false)).toBe(false)
    expect(onAllowlist(list, 'qq:1:group:30003', false)).toBe(false)
    expect(onAllowlist(list, 'wechat:1:private:30003', false)).toBe(false)
    expect(onAllowlist(list, 'wechat:1:private:owner', true)).toBe(true)
  })

  it('lets only the owner\'s own channels through by default', () => {
    const list = resolveGuardConfig({}).allowlist
    expect(onAllowlist(list, 'demo:owner:private:alice', false)).toBe(false)
    expect(onAllowlist(list, 'qq:1:private:30003', false)).toBe(false)
    expect(onAllowlist(list, 'qq:1:private:10001', true)).toBe(true)
  })

  it('drops a stimulus from a chat not on the list before it reaches her, and logs it', async () => {
    const ctx = await setupGuarded({ allowlist: { qq: { open: false, users: ['30003'], groups: [] } } })
    expect(ctx.anima.admit({ kind: 'reach', channelKey: bob.channelKey })).toMatchObject({ code: 'anima/not-allowlisted', drop: true })
    expect(ctx.anima.admit({ kind: 'reach', channelKey: alice.channelKey })).toBeUndefined()
    expect(ctx.animaGuard.activity.read(ctx.anima.dayKey()).filter(r => r.type === 'gate' && r.code === 'anima/not-allowlisted')).toHaveLength(1)
  })

  it('refuses contact with a chat not on the list, from outside, but never an internal call', async () => {
    const ctx = await setupGuarded({ allowlist: { qq: { open: false, users: ['30003'], groups: [] } } })
    provideSessions(ctx, { a: alice, b: bob })
    registerEcho(ctx, 'qq_say', { platform: 'qq', effect: 'express', sessions: ['conversation'] })
    registerEcho(ctx, 'end_turn', { effect: 'internal', sessions: ['conversation'], closes: true })
    expect((await callAs(ctx, 'a', 'qq_say')).isError).toBe(false)
    expect(textOf(await callAs(ctx, 'b', 'qq_say'))).toMatch(/^Error: anima\/not-allowlisted: （外面拦住了你/)
    expect((await callAs(ctx, 'b', 'end_turn')).isError).toBe(false)
  })
})
