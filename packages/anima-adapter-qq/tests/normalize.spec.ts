import { describe, expect, it } from 'vitest'
import { normalizeMessage, outgoing, renderSegments, resolveQqConfig } from '../src/index.ts'

const ctx = { selfId: '10001', herName: 'Anima', name: (id: string) => (id === '2002' ? 'Bob' : undefined) }

describe('rendering QQ segments', () => {
  it('renders text, mentions, replies and media placeholders', () => {
    const rendered = renderSegments([
      { type: 'reply', messageId: '77' },
      { type: 'mention', userId: '10001' },
      { type: 'text', text: ' look ' },
      { type: 'image', sticker: false, file: 'x.jpg', summary: '[动画表情]' },
      { type: 'mention', userId: '2002' },
      { type: 'mention', userId: 'all' },
      { type: 'face' },
      { type: 'voice' },
      { type: 'other', name: 'weird' },
    ], ctx)
    expect(rendered).toEqual({ text: '@Anima look [image: 动画表情]@Bob@all[emoji][voice message][weird]', mentionsHer: true, replyTo: '77' })
    expect(renderSegments([{ type: 'mention', userId: 'all' }], ctx).mentionsHer).toBe(false)
    expect(renderSegments([{ type: 'image', sticker: false }], ctx).text).toBe('[image]')
    expect(renderSegments([{ type: 'forward', content: [{ name: 'a', segments: [] }] }], ctx).text).toBe('[forwarded messages: 1 messages]')
    expect(renderSegments([], ctx).text).toBe('[empty message]')
  })

  it('builds outgoing segments with reply and mentions', () => {
    expect(outgoing('hello', { replyTo: '9', mention: ['2002'] })).toEqual([
      { type: 'reply', messageId: '9' },
      { type: 'mention', userId: '2002' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'hello' },
    ])
    expect(outgoing('x')).toEqual([{ type: 'text', text: 'x' }])
  })

  it('normalizes a message for her', () => {
    const group = normalizeMessage({
      kind: 'group', chatId: '300', userId: '2002', displayName: 'Bob', messageId: '55', time: 1_700_000_000_000,
      segments: [{ type: 'mention', userId: '10001' }, { type: 'text', text: ' hi' }],
    }, ctx)
    expect(group).toEqual({ kind: 'group', chatId: '300', userId: '2002', displayName: 'Bob', messageId: '55', text: '@Anima hi', mentionsHer: true, time: 1_700_000_000_000 })
  })
})

describe('config', () => {
  it('validates config, normalizes ids, and fails loud on keys that moved', () => {
    const config = resolveQqConfig({ backend: { url: 'ws://127.0.0.1:3001' }, account: 10001, owner: '20002' })
    expect(config.account).toBe('10001')
    expect(config.owner).toBe('20002')
    expect(config.backend).toMatchObject({ protocol: 'onebot11', url: 'ws://127.0.0.1:3001', callTimeoutSeconds: 10, heartbeatGrace: 2.5 })
    expect(() => resolveQqConfig({ backend: { url: 'ws://127.0.0.1:3001' }, account: 10001, owner: '20002', allow: { users: [30003] } })).toThrow(/anima\/config-moved: allow moved to the anima-guard row/)
    expect(() => resolveQqConfig({ url: 'ws://127.0.0.1:3001', accessToken: 'x', account: 10001, owner: 20002 })).toThrow(/anima\/config-moved: url, accessToken moved into backend/)
    expect(() => resolveQqConfig({ account: 1, owner: 2 })).toThrow('anima/config-invalid')
    expect(() => resolveQqConfig({ backend: { url: 'http://x' }, account: 10001, owner: 20002 })).toThrow('anima/config-invalid')
    expect(() => resolveQqConfig({ backend: { protocol: 'satori', url: 'ws://x' }, account: 10001, owner: 20002 })).toThrow('anima/config-invalid')
    expect(() => resolveQqConfig({ backend: { url: 'ws://x' }, account: 10001, owner: 10001 })).toThrow('same QQ number')
  })
})
