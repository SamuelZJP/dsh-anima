import { describe, expect, it } from 'vitest'
import { onAllowlist, resolveGuardConfig } from '../src/index.ts'
import { callAs, provideSessions, registerEcho, setupGuarded, textOf, toChannel, WAKING } from './helpers.ts'

const alice = { channelKey: 'qq:1:private:30003' }
const bob = { channelKey: 'qq:1:private:40004' }

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
    provideSessions(ctx, { w: WAKING })
    ctx.anima.provideChannels(key => ({ isOwner: false, display: key }), () => [alice.channelKey, bob.channelKey])
    registerEcho(ctx, 'qq_say', { platform: 'qq', effect: 'express', sessions: ['waking'], target: toChannel })
    registerEcho(ctx, 'end_turn', { effect: 'internal', sessions: ['waking'], closes: true })
    expect((await callAs(ctx, 'w', 'qq_say', { channel: alice.channelKey })).isError).toBe(false)
    expect(textOf(await callAs(ctx, 'w', 'qq_say', { channel: bob.channelKey }))).toMatch(/^Error: anima\/not-allowlisted: （外面拦住了你/)
    expect((await callAs(ctx, 'w', 'end_turn')).isError).toBe(false)
  })
})
