// R2 spike: checks the DSH APIs the day session relies on (docs/ROADMAP.md, R2), as a plugin
// row loaded by absolute path from a --patch overlay with every Anima row disabled. It talks to
// DSH only, through two throwaway sessions A and B on a bare preset `spike-day`, and writes
// <out>/summary.json (one entry per check, then "finished") and <out>/events.jsonl.
//
//   S1  steer into an idle agent starts a turn
//   S2  steer while a tool runs joins the same turn at the next step
//   S3  inject into an idle agent starts no turn; it joins the next turn before the waking message
//   S4  plain archive is refused while an alarm targets the session
//   S5  schedule.edit moves the alarm to session B; then the plain archive of A succeeds
//   S6  a steer into archived A runs no model request (DSH ends the turn as blocked)
//   S7  the moved alarm fires into B and starts a turn there
//   S8  archive with stopActivity deletes B's remaining alarm
//   S9  the full event log of archived A reads back (sessionPersistence), versus its surface
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The repo root has no DSH libraries of its own; anima-life's are the pinned version.
const lib = pkg => new URL(`../../packages/anima-life/node_modules/@deepseek-ai/${pkg}/lib/index.js`, import.meta.url).href
const { createUserMessage } = await import(lib('dsh-llm'))
const { defineTool } = await import(lib('dsh-tools'))

export const name = 'anima-r2-spike'
// Cordis needs `tools` declared; the other services are read with ctx.get when the run starts.
export const inject = ['tools']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

export function apply(ctx, config = {}) {
  const { out, cwd } = config
  const A = `${config.sessionId}-a`
  const B = `${config.sessionId}-b`
  mkdirSync(out, { recursive: true })
  const summary = { sessions: { A, B }, checks: {} }
  const save = () => writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  const check = (id, value) => {
    summary.checks[id] = value
    save()
    ctx.logger.info(`[r2-spike] ${id}: ${JSON.stringify(value)}`)
  }

  // ---- event capture for A and B ----
  const events = []
  ctx.on('session/event', (session, event) => {
    if (session.id !== A && session.id !== B) return
    const data = event.data ?? {}
    const row = {
      s: session.id === A ? 'A' : 'B', seq: event.seq, type: event.type, turn: event.turn,
      ...data.source?.kind === undefined ? {} : { source: data.source.kind },
      ...data.source?.tag === undefined ? {} : { tag: data.source.tag },
      ...event.type === 'tool/call' ? { tool: data.name } : {},
      ...event.type === 'turn/end' ? { reason: data.reason?.kind } : {},
    }
    events.push(row)
    appendFileSync(join(out, 'events.jsonl'), `${JSON.stringify(row)}\n`)
  })
  const of = s => events.filter(e => e.s === s)
  const mark = s => of(s).at(-1)?.seq ?? -1
  const after = (s, seq) => of(s).filter(e => e.seq > seq)
  const label = e => `${e.seq}:${e.type}${e.tag ? `(${e.tag})` : ''}${e.source && !e.tag ? `(${e.source})` : ''}${e.tool ? `(${e.tool})` : ''}${e.reason ? `(${e.reason})` : ''}`
  // Session events carry no turn number: a message is in a turn when it lies between that
  // turn's turn/start and turn/end. True when exactly one turn ran and every tagged message is inside it.
  const oneTurn = (rows, tags) => {
    const starts = rows.filter(e => e.type === 'turn/start')
    const end = rows.find(e => e.type === 'turn/end')
    if (starts.length !== 1 || end === undefined) return false
    return tags.every((tag) => {
      const m = rows.find(e => e.type === 'user/message' && e.tag === tag)
      return m !== undefined && m.seq > starts[0].seq && m.seq < end.seq
    })
  }
  const until = async (test, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return true
      await pause(250)
    }
    return test()
  }

  // ---- a waiting tool in A, ended early by the spike (as life will end `wait`) ----
  let endWait
  ctx.tools.register(defineTool({
    name: 'spike_wait',
    description: 'Wait up to `seconds` seconds. Returns early when something arrives.',
    parameters: { seconds: { type: 'number', required: true, description: 'Seconds to wait, at most 120.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { why: { type: 'string', required: true, description: 'timeout or arrived.' } } },
      render: (_args, value) => [{ type: 'text', text: value.why }],
    },
    execute: async args => new Promise((resolve) => {
      const timer = setTimeout(() => { endWait = undefined; resolve({ why: 'timeout' }) }, Math.min(120, Number(args.seconds) || 60) * 1000)
      endWait = () => { clearTimeout(timer); endWait = undefined; resolve({ why: 'arrived' }) }
    }),
  }), { when: ({ agent }) => agent.id === A })

  const message = (text, tag) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'anima-spike', tag, form: 'notice', summary: tag } })

  async function run() {
    const need = id => {
      const service = ctx.get(id)
      if (service === undefined) throw new Error(`service ${id} is missing`)
      return service
    }
    const controller = need('sessionController')
    const registry = need('workspaceRegistry')
    const sessions = need('sessions')
    const schedule = need('schedule')
    const persistence = need('sessionPersistence')
    const query = ctx.get('sessionQuery')
    const open = async (id) => {
      const created = await controller.create({ sessionId: id, cwd, agentPreset: 'spike-day' })
      if (created.sessionId !== id) throw new Error(`asked for ${id}, DSH created ${created.sessionId}`)
      const resolved = await controller.resolveAgent(id)
      if (!('agent' in resolved)) throw new Error(`resolve ${id}: ${resolved.error.code}`)
      return resolved.agent
    }
    const archive = async (id, options) => {
      try {
        await registry.archiveSession(id, options)
        return { ok: true, archived: registry.archivedSessionIds.includes(id) }
      } catch (error) {
        return { ok: false, error: errorText(error), activity: error?.activity }
      }
    }

    const a = await open(A)

    // S1 + S2
    let from = mark('A')
    a.steer(message('This is a tool test. Call spike_wait with seconds 90 now. When it returns, answer any new message in one short sentence. Do not call spike_wait again.', 'first'))
    await sessions.flush(a.session)
    const waiting = await until(() => after('A', from).some(e => e.type === 'tool/call' && e.tool === 'spike_wait'), 120_000)
    check('S1 steer into idle starts a turn', { pass: waiting && after('A', from).some(e => e.type === 'turn/start'), waitCalled: waiting })
    if (!waiting) throw new Error('spike_wait was never called; S2 cannot run')
    await pause(2000)
    a.steer(message('[stimulus] Alice says: hello, are you there?', 'second'))
    endWait?.()
    await until(() => after('A', from).some(e => e.type === 'turn/end'), 180_000)
    let rows = after('A', from)
    const result = rows.find(e => e.type === 'tool/result')
    const second = rows.find(e => e.type === 'user/message' && e.tag === 'second')
    check('S2 steer during a tool joins the same turn', {
      pass: second !== undefined && result !== undefined && second.seq > result.seq && oneTurn(rows, ['first', 'second']),
      order: rows.map(label),
    })

    // S3
    from = mark('A')
    a.inject(message('[context] A platform event; nothing to answer.', 'inject'))
    await sessions.flush(a.session)
    await pause(6000)
    const noTurn = !after('A', from).some(e => e.type === 'turn/start')
    a.steer(message('[stimulus] Bob says: say hi in one word.', 'after-inject'))
    await until(() => after('A', from).some(e => e.type === 'turn/end'), 120_000)
    rows = after('A', from)
    const injected = rows.find(e => e.type === 'user/message' && e.tag === 'inject')
    const woke = rows.find(e => e.type === 'user/message' && e.tag === 'after-inject')
    check('S3 inject starts no turn and joins the next one first', {
      pass: noTurn && injected !== undefined && woke !== undefined && injected.seq < woke.seq && oneTurn(rows, ['inject', 'after-inject']),
      noTurnFromInject: noTurn, order: rows.map(label),
    })

    // S4
    const alarm = await schedule.create({ title: 'spike alarm', prompt: 'Spike alarm rang. Reply with the word OK.', timing: { kind: 'after', after_seconds: 45 }, target: { kind: 'session', sessionId: A } })
    const refused = await archive(A)
    check('S4 plain archive refused while an alarm targets the session', { pass: !refused.ok && /active/.test(refused.error ?? ''), result: refused, alarm: alarm.id })

    // S5
    await open(B)
    const moved = await schedule.edit({ id: alarm.id, action: 'update', patch: { target: { kind: 'session', sessionId: B } } })
    const viewed = await schedule.view({ id: alarm.id })
    const archivedA = await archive(A)
    check('S5 alarm moved to B, then A archives', {
      pass: viewed.target?.kind === 'session' && viewed.target.sessionId === B && archivedA.ok && archivedA.archived,
      edit: moved.code ?? 'updated', target: viewed.target, archive: archivedA,
    })

    // S6
    from = mark('A')
    a.steer(message('[stimulus] Carol says: are you still there?', 'archived'))
    try { await sessions.flush(a.session) } catch {}
    const resolvedAgain = await controller.resolveAgent(A)
    await pause(8000)
    rows = after('A', from)
    check('S6 steer into archived runs no model request', {
      pass: !rows.some(e => e.type === 'request/header' || e.type === 'assistant/message'),
      resolveAfterArchive: 'agent' in resolvedAgain ? 'agent' : resolvedAgain.error.code, order: rows.map(label),
    })

    // S7
    from = mark('B')
    const fired = await until(() => after('B', from).some(e => e.type === 'turn/end'), 120_000)
    rows = after('B', from)
    check('S7 moved alarm fires into B and starts a turn', {
      pass: fired && rows.some(e => e.type === 'user/message' && e.source === 'schedule') && rows.some(e => e.type === 'turn/start'),
      order: rows.map(label),
    })

    // S8
    const second2 = await schedule.create({ title: 'spike alarm 2', prompt: 'Should never ring.', timing: { kind: 'after', after_seconds: 3600 }, target: { kind: 'session', sessionId: B } })
    const archivedB = await archive(B, { stopActivity: true })
    const gone = await schedule.view({ id: second2.id })
    check('S8 stopActivity archive deletes the alarm', { pass: archivedB.ok && archivedB.archived && gone.code === 'schedule_not_found', archive: archivedB, view: gone.code ?? gone.status })

    // S9 (flush first: a read sees only the committed log)
    try { await sessions.flush(a.session) } catch {}
    const handle = await persistence.open(A, 'read')
    let logged
    try {
      const { events: all } = await handle.read(0, undefined)
      const counts = {}
      for (const e of all) counts[e.type] = (counts[e.type] ?? 0) + 1
      const tags = all.filter(e => e.type === 'user/message').map(e => e.data?.source?.tag ?? e.data?.source?.kind)
      logged = { header: handle.header.agentPreset, events: all.length, counts, userMessages: tags }
    } finally {
      await handle.close()
    }
    const surface = query === undefined ? undefined : (await query.readSurface(A)).events.length
    check('S9 archived log reads back in full', {
      // The message steered after archiving may never become a user/message (the step is rejected); reported, not required.
      pass: ['first', 'second', 'inject', 'after-inject'].every(tag => logged.userMessages.includes(tag)),
      archivedSteerLogged: logged.userMessages.includes('archived'),
      log: logged, surfaceEvents: surface, capturedEvents: of('A').length,
    })
  }

  ctx.effect(() => {
    const timer = setTimeout(() => {
      run()
        .then(() => { summary.finished = 'ok'; save() })
        .catch((error) => { summary.finished = `error: ${errorText(error)}`; summary.stack = error?.stack; save() })
    }, config.delayMs ?? 8000)
    return () => clearTimeout(timer)
  }, 'r2-spike')
}
