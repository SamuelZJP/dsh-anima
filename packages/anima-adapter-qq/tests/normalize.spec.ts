import { describe, expect, it } from 'vitest'
import { backoff, connectUrl, normalizeMessage, outgoing, parseCQ, renderSegments, resolveQqConfig } from '../src/index.ts'

const ctx = { selfId: '10001', herName: 'Anima', name: (id: string) => (id === '2002' ? 'Bob' : undefined) }

describe('segments', () => {
  it('renders text, mentions, replies and media placeholders', () => {
    const rendered = renderSegments([
      { type: 'reply', data: { id: '77' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' look ' } },
      { type: 'image', data: { file: 'x.jpg', summary: '[动画表情]' } },
      { type: 'at', data: { qq: '2002' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'face', data: { id: '14' } },
      { type: 'record', data: {} },
      { type: 'weird', data: {} },
    ], ctx)
    expect(rendered).toEqual({ text: '@Anima look [image: 动画表情]@Bob@all[emoji][voice message][weird]', mentionsHer: true, replyTo: '77' })
    expect(renderSegments([{ type: 'at', data: { qq: 'all' } }], ctx).mentionsHer).toBe(false)
    expect(renderSegments([{ type: 'image', data: {} }], ctx).text).toBe('[image]')
    expect(renderSegments([], ctx).text).toBe('[empty message]')
  })

  it('parses CQ-code strings', () => {
    expect(parseCQ('hi [CQ:at,qq=10001] &#91;x&#93; [CQ:reply,id=5]ok')).toEqual([
      { type: 'text', data: { text: 'hi ' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' [x] ' } },
      { type: 'reply', data: { id: '5' } },
      { type: 'text', data: { text: 'ok' } },
    ])
  })

  it('builds outgoing segments with reply and mentions', () => {
    expect(outgoing('hello', { replyTo: '9', mention: ['2002'] })).toEqual([
      { type: 'reply', data: { id: '9' } },
      { type: 'at', data: { qq: '2002' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'text', data: { text: 'hello' } },
    ])
    expect(outgoing('x')).toEqual([{ type: 'text', data: { text: 'x' } }])
  })
})

describe('normalizeMessage', () => {
  it('normalizes group and private messages', () => {
    const group = normalizeMessage({
      post_type: 'message', message_type: 'group', message_id: 55, group_id: 300, user_id: 2002, time: 1_700_000_000,
      sender: { user_id: 2002, nickname: 'bobby', card: 'Bob' }, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' hi' } }],
    }, ctx)
    expect(group).toEqual({ kind: 'group', chatId: '300', userId: '2002', displayName: 'Bob', messageId: '55', text: '@Anima hi', mentionsHer: true, time: 1_700_000_000_000 })
    const dm = normalizeMessage({ post_type: 'message', message_type: 'private', message_id: 1, user_id: 3003, sender: { nickname: 'Cat' }, message: 'hello [CQ:face,id=1]' }, ctx)
    expect(dm).toMatchObject({ kind: 'private', chatId: '3003', displayName: 'Cat', text: 'hello [emoji]', mentionsHer: false })
    expect(normalizeMessage({ post_type: 'notice' }, ctx)).toBeUndefined()
    expect(normalizeMessage({ post_type: 'message', message_type: 'guild' }, ctx)).toBeUndefined()
  })
})

describe('config and transport helpers', () => {
  it('validates config and normalizes ids', () => {
    const config = resolveQqConfig({ url: 'ws://127.0.0.1:3001', account: 10001, owner: '20002', allow: { users: [30003], groups: [{ id: 40004, name: 'Test' }] } })
    expect(config.account).toBe('10001')
    expect(config.allow).toEqual({ users: [{ id: '30003' }], groups: [{ id: '40004', name: 'Test' }] })
    expect(() => resolveQqConfig({ account: 1, owner: 2 })).toThrow('anima/config-invalid')
    expect(() => resolveQqConfig({ url: 'http://x', account: 10001, owner: 20002 })).toThrow('anima/config-invalid')
    expect(() => resolveQqConfig({ url: 'ws://x', account: 10001, owner: 10001 })).toThrow('same QQ number')
  })

  it('puts the access token in the query and backs off exponentially', () => {
    expect(connectUrl('ws://127.0.0.1:3001', 's3cret')).toBe('ws://127.0.0.1:3001/?access_token=s3cret')
    expect(connectUrl('ws://127.0.0.1:3001', undefined)).toBe('ws://127.0.0.1:3001')
    expect([0, 1, 2, 3, 10].map(n => backoff(n, 1000, 60_000))).toEqual([1000, 2000, 4000, 8000, 60_000])
  })
})
