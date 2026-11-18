// R3 supervised check on the real QQ backend (docs/ROADMAP.md, R3), a plugin row loaded by absolute
// path from the overlay that scripts/qq/r3-overlay.mjs writes. It sends nothing and never decides
// what she says: the owner writes to her on QQ (a text, then a picture), she answers on her own, and
// this row records what happened in <dataDir>/r3-check.json:
//   connected  her adapter is connected to the OneBot v11 runtime as her account, and the account is online
//   receive    the owner's message reached her owner conversation
//   send       her qq_say there went out (a message id from the runtime)
//   history    the runtime's history of the owner chat, read through a second, read-only OneBotBackend
//   image      the owner's picture got a placeholder id, and its bytes come back through the backend
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const lib = new URL('../../packages/anima-adapter-qq/lib/', import.meta.url)
const { OneBotBackend, renderSegments, sniffImage } = await import(new URL('index.js', lib).href)
const { fetchCapped } = await import(new URL('media.js', lib).href)

export const name = 'anima-r3-check'
export const inject = ['anima', 'animaLife']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

export function apply(ctx, config) {
  const core = ctx.anima
  const dir = core.config.dataDir
  const ownerKey = `qq:${config.account}:private:${config.owner}`
  const report = { characterId: core.config.characterId, started: new Date().toISOString(), steps: {}, arrivals: [], calls: [] }
  const save = () => writeFileSync(join(dir, 'r3-check.json'), `${JSON.stringify(report, null, 2)}\n`)
  const step = (id, value) => { report.steps[id] = value; save(); ctx.logger.info(`[r3-check] ${id}: ${JSON.stringify(value)}`) }

  // ---- what reaches her owner conversation, and what she does there ----
  const pending = new Map()
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info?.kind !== 'conversation' || info.channelKey !== ownerKey) return
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const text = (data.content ?? data.message?.content ?? []).map?.(b => b.text ?? '').join('') ?? String(data.text ?? '')
      report.arrivals.push({ at: new Date().toISOString(), text: text.slice(0, 400) })
      save()
    } else if (event.type === 'tool/call') {
      pending.set(data.callId, data.name)
    } else if (event.type === 'tool/result') {
      const toolName = pending.get(data.message?.toolCallId)
      if (toolName === undefined) return
      const text = (data.message?.content ?? []).map(b => b.text ?? '').join('')
      report.calls.push({ at: new Date().toISOString(), name: toolName, error: data.message?.isError === true, text: text.slice(0, 300) })
      save()
    }
  })

  // ---- a second, read-only connection for history and image bytes ----
  const probe = new OneBotBackend({ url: config.url, accessToken: config.accessToken, callTimeoutMs: 15_000, maxBackoffMs: 10_000, heartbeatGrace: 3 })
  let probeOpen = false
  ctx.effect(() => {
    probe.start({ event() {}, open: () => { probeOpen = true }, close: () => { probeOpen = false }, health() {} })
    return () => probe.stop()
  }, 'r3-check.probe')

  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'r3-check.stop')
  const until = async (test, ms) => {
    const end = Date.now() + ms
    while (!stopped && Date.now() < end) { if (await test()) return true; await pause(1000) }
    return test()
  }
  const qqLines = () => core.statusLines().filter(line => line.startsWith('QQ'))
  const mediaEntries = () => {
    try { return JSON.parse(readFileSync(join(dir, 'qq', 'media.json'), 'utf8')).entries.filter(e => e.chat === ownerKey && e.kind !== 'forward') } catch { return [] }
  }

  void (async () => {
    const connected = await until(() => qqLines().some(line => line.includes(`connected to OneBot v11 at ${config.url} as ${config.account}`) && line.includes('account online')), 60_000)
    step('connected', { ok: connected, status: qqLines() })
    ctx.logger.info('[r3-check] ready: write to her on QQ (a text, then a picture).')

    const received = await until(() => report.arrivals.length > 0, 30 * 60_000)
    step('receive', { ok: received, first: report.arrivals[0]?.text })

    const sent = await until(() => report.calls.some(c => c.name === 'qq_say' && !c.error), 10 * 60_000)
    step('send', { ok: sent, say: report.calls.find(c => c.name === 'qq_say' && !c.error)?.text, errors: report.calls.filter(c => c.error) })

    try {
      await until(() => probeOpen, 30_000)
      const messages = await probe.history('private', config.owner, 10)
      const lines = messages.map(m => `${m.userId === config.account ? 'her' : m.userId === config.owner ? 'owner' : m.userId} [msg ${m.messageId}]: ${renderSegments(m.segments, { selfId: config.account, herName: core.config.name }).text}`)
      step('history', { ok: messages.length > 0, count: messages.length, lines })
    } catch (error) {
      step('history', { ok: false, error: errorText(error) })
    }

    const gotImage = await until(() => mediaEntries().length > 0, 20 * 60_000)
    if (!gotImage) {
      step('image', { ok: false, why: 'no picture from the owner reached her' })
    } else {
      const entry = mediaEntries()[0]
      const result = { id: entry.id, kind: entry.kind, summary: entry.summary, hasUrl: entry.url !== undefined, hasFile: entry.file !== undefined }
      if (entry.url !== undefined) {
        try {
          const bytes = await fetchCapped(entry.url, 10 * 1024 * 1024, 20_000)
          result.url = { bytes: bytes.byteLength, type: sniffImage(bytes) ?? 'unknown' }
        } catch (error) { result.url = { error: errorText(error) } }
      }
      if (entry.file !== undefined) {
        try {
          const got = await probe.image(entry.file)
          const bytes = got.bytes ?? (got.url === undefined ? undefined : await fetchCapped(got.url, 10 * 1024 * 1024, 20_000))
          result.backend = bytes === undefined ? { error: 'no bytes and no URL' } : { bytes: bytes.byteLength, type: sniffImage(bytes) ?? 'unknown', via: got.bytes === undefined ? 'url' : 'base64' }
        } catch (error) { result.backend = { error: errorText(error) } }
      }
      result.ok = [result.url, result.backend].some(r => r?.bytes > 0 && r.type !== 'unknown')
      result.looks = report.calls.filter(c => c.name === 'qq_look')
      step('image', result)
    }
    report.finished = new Date().toISOString()
    report.ok = ['connected', 'receive', 'send', 'history', 'image'].every(id => report.steps[id]?.ok === true)
    save()
    ctx.logger.info(`[r3-check] finished: ${report.ok ? 'all checks passed' : 'some checks failed'}`)
  })()
}
