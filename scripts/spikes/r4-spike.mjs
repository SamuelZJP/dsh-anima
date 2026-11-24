// R4 spike: can a close view's perception run as a subagent of her waking session
// (docs/ROADMAP.md, R4)? A plugin row loaded by absolute path from a --patch overlay with every
// Anima row disabled (scripts/spikes/r4-overlay.mjs). It talks to DSH only: one throwaway parent
// session P on a bare preset `spike-waking`, and writes <out>/summary.json and <out>/events.jsonl.
//
//   V1  a tool running in P starts a spawn subagent on preset `spike-viewing` with a text and an
//       image in its prompt, on a chosen model, delivery 'caller'; the tool awaits its result
//   V2  the child saw the image: its answer names the two colours of the test picture
//   V3  P gets no message from the child (caller delivery); P's turn goes on after the tool result
//   V4  the child ran no tool, and P's own tool (scoped to P by `when`) was not offered to it
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const lib = pkg => new URL(`../../packages/anima-life/node_modules/@deepseek-ai/${pkg}/lib/index.js`, import.meta.url).href
const { createUserMessage } = await import(lib('dsh-llm'))
const { defineTool } = await import(lib('dsh-tools'))

export const name = 'anima-r4-spike'
export const inject = ['tools']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

/** A 96x64 PNG: left half red, right half blue. */
function testPng() {
  const w = 96, h = 64
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      if (x < w / 2) { raw[o] = 230; raw[o + 1] = 20; raw[o + 2] = 20 } else { raw[o] = 20; raw[o + 1] = 40; raw[o + 2] = 230 }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export function apply(ctx, config = {}) {
  const { out, cwd, model } = config
  const P = `${config.sessionId}-p`
  mkdirSync(out, { recursive: true })
  const summary = { parent: P, checks: {} }
  const save = () => writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  const check = (id, value) => { summary.checks[id] = value; save(); ctx.logger.info(`[r4-spike] ${id}: ${JSON.stringify(value)}`) }

  const events = []
  let childId
  ctx.on('session/event', (session, event) => {
    const who = session.id === P ? 'P' : session.id === childId ? 'C' : undefined
    if (who === undefined) return
    const data = event.data ?? {}
    const row = {
      s: who, seq: event.seq, type: event.type,
      ...data.source?.kind === undefined ? {} : { source: data.source.kind },
      ...event.type === 'tool/call' ? { tool: data.name } : {},
      ...event.type === 'turn/end' ? { reason: data.reason?.kind } : {},
      ...event.type === 'request/header' ? { tools: (data.header?.tools ?? []).map(t => t.name), model: data.header?.config?.model } : {},
    }
    events.push(row)
    appendFileSync(join(out, 'events.jsonl'), `${JSON.stringify(row)}\n`)
  })
  const of = s => events.filter(e => e.s === s)

  let viewDone
  const viewResult = new Promise(resolve => { viewDone = resolve })
  ctx.tools.register(defineTool({
    name: 'spike_view',
    description: 'Look closely at a picture. Returns what you saw.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { saw: { type: 'string', required: true, description: 'What was seen.' } } },
      render: (_args, value) => [{ type: 'text', text: value.saw }],
    },
    execute: async (_args, exec) => {
      const started = Date.now()
      try {
        const subagents = ctx.get('subagents')
        const attachments = ctx.get('attachments')
        if (subagents === undefined || attachments === undefined) throw new Error(`missing service: subagents ${subagents !== undefined}, attachments ${attachments !== undefined}`)
        const ref = await attachments.saveImage({ data: testPng(), mediaType: 'image/png', name: 'r4-spike.png' })
        const activation = await subagents.startActivation({
          provider: 'spawn', label: 'spike view', delivery: 'caller', signal: exec.signal,
          request: {
            parent: exec.agent, signal: exec.signal, agentPreset: 'spike-viewing',
            ...model === undefined ? {} : { agentOptions: { provider: model.provider, model: model.model } },
            prompt: [
              { type: 'text', text: 'Look at this picture and name its colours, left to right, in one short English sentence. Use no tools.' },
              { type: 'image', attachment: ref },
            ],
          },
        })
        childId = activation.childId
        const result = await activation.result
        const text = result.output.filter(b => b.type === 'text').map(b => b.text).join('').trim()
        viewDone({ ok: true, childId, stopReason: result.stopReason, diagnostic: result.diagnostic, text, ms: Date.now() - started })
        return { saw: text || '(nothing)' }
      } catch (error) {
        viewDone({ ok: false, error: errorText(error), ms: Date.now() - started })
        throw error
      }
    },
  }), { when: ({ agent }) => agent.id === P })

  const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'anima-spike', form: 'notice', summary: 'spike' } })

  async function run() {
    const controller = ctx.get('sessionController')
    const sessions = ctx.get('sessions')
    const created = await controller.create({ sessionId: P, cwd, agentPreset: 'spike-waking' })
    if (created.sessionId !== P) throw new Error(`asked for ${P}, DSH created ${created.sessionId}`)
    const resolved = await controller.resolveAgent(P)
    if (!('agent' in resolved)) throw new Error(`resolve ${P}: ${resolved.error.code}`)
    const p = resolved.agent
    p.steer(message('This is a tool test. Call spike_view once now. When it returns, repeat what it saw in one sentence and stop.'))
    await sessions.flush(p.session)

    const view = await Promise.race([viewResult, pause(240_000).then(() => ({ ok: false, error: 'spike_view never finished' }))])
    check('V1 subagent from a tool, caller delivery', { pass: view.ok === true && view.stopReason === 'completed', ...view })
    const colours = /red/i.test(view.text ?? '') && /blue/i.test(view.text ?? '')
    check('V2 the child saw the image', { pass: colours, text: view.text })

    const end = Date.now() + 120_000
    while (Date.now() < end && !of('P').some(e => e.type === 'turn/end')) await pause(500)
    const pRows = of('P')
    const result = pRows.find(e => e.type === 'tool/result')
    // DSH's own working-directory line is a user/message with source runtime-context; it is not from the child.
    const userMessages = pRows.filter(e => e.type === 'user/message' && e.source !== 'runtime-context')
    check('V3 parent gets no child message; its turn goes on', {
      pass: userMessages.length === 1 && result !== undefined && pRows.some(e => e.type === 'assistant/message' && e.seq > result.seq),
      parent: pRows.map(e => `${e.seq}:${e.type}${e.source ? `(${e.source})` : ''}${e.tool ? `(${e.tool})` : ''}${e.reason ? `(${e.reason})` : ''}`),
    })
    const cRows = of('C')
    const headers = cRows.filter(e => e.type === 'request/header')
    check('V4 the child ran no tool and was not offered spike_view', {
      pass: !cRows.some(e => e.type === 'tool/call') && !headers.some(h => (h.tools ?? []).includes('spike_view')),
      childTools: headers[0]?.tools, childModel: headers[0]?.model, child: cRows.map(e => `${e.seq}:${e.type}${e.tool ? `(${e.tool})` : ''}`),
    })
  }

  ctx.effect(() => {
    let stopped = false
    void (async () => {
      await pause(3000)
      if (stopped) return
      try { await run() } catch (error) { check('error', { error: errorText(error), stack: error?.stack }) }
      summary.finished = new Date().toISOString()
      summary.pass = Object.values(summary.checks).every(c => c.pass === true)
      save()
      ctx.logger.info(`[r4-spike] finished: ${summary.pass ? 'all pass' : 'some failed'}`)
    })()
    return () => { stopped = true }
  }, 'r4-spike.run')
}
