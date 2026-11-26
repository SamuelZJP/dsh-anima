// Report of the R7 supervised QQ day (docs/history/R7-QQ-DAY.md, sections 5 and 6). Offline: it reads the run's
// data dir (r7-run.json, activity/*.jsonl, guard.json, life.json, memory.db, dsh.log) and DSH's logs of
// her sessions (~/.dsh/sessions/<her session dirs>), and decides nothing for her. With --qq it also
// reads, read-only, the history of each allowed chat on the runtime, to check that her account sent
// nothing but her says (P2). Run it during the day or after it; it can be run again at any time.
// Usage: node scripts/qq/r7-report.mjs <dataDir> [--qq]   → writes <dataDir>/r7-report.json, prints a summary
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'

const lib = path => new URL(`../../packages/${path}/lib/index.js`, import.meta.url).href
const core = await import(lib('anima-core'))
const guard = await import(lib('anima-guard'))

const args = process.argv.slice(2)
const dir = resolve(args.find(a => !a.startsWith('--')) ?? '')
const withQq = args.includes('--qq')
if (!existsSync(join(dir, 'activity')) && !existsSync(join(dir, 'state.json'))) throw new Error('usage: r7-report.mjs <dataDir> [--qq]')

const MIN = 60_000
const read = (file, fallback) => { try { return JSON.parse(readFileSync(join(dir, file), 'utf8')) } catch { return fallback } }
const stamp = t => t === undefined || t === null ? null : new Date(t).toLocaleString('sv-SE').slice(5, 16)
const median = xs => xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const count = (xs, key) => xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {})

// ---- the run: allowlist and genes (the overlay sets only the allowlist; all else is default) ----
const run = read('r7-run.json', undefined)
const heart = core.Config({}).heartbeat
const guardDefaults = guard.Config({})
const allowed = run === undefined ? undefined : new Set([
  `qq:${run.account}:private:${run.owner}`,
  ...run.users.map(id => `qq:${run.account}:private:${id}`),
  ...run.groups.map(id => `qq:${run.account}:group:${id}`),
])

// ---- activity log ----
const activityDir = join(dir, 'activity')
const activity = existsSync(activityDir)
  ? readdirSync(activityDir).filter(f => f.endsWith('.jsonl')).sort().flatMap(f => readFileSync(join(activityDir, f), 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }))
  : []
activity.sort((a, b) => a.real - b.real)
const gates = activity.filter(r => r.type === 'gate')
const startReal = run === undefined ? activity[0]?.real : Date.parse(run.created)
const nowReal = Date.now()

// ---- her sessions, from DSH's own logs ----
const sessionRoot = join(homedir(), '.dsh', 'sessions')
const prefix = `-${dir.replace(/\//g, '-')}-`
const sessionDirs = existsSync(sessionRoot) ? readdirSync(sessionRoot).filter(d => d.startsWith(prefix)) : []
const sessions = []
for (const sub of sessionDirs) {
  const kind = sub.slice(prefix.length).replace(/-+$/, '')
  for (const id of readdirSync(join(sessionRoot, sub))) {
    const file = join(sessionRoot, sub, id, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    let events = []
    try {
      events = zstdDecompressSync(readFileSync(file)).toString().split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    } catch { continue } // a log still being written may end mid-frame; the next run reads it whole
    sessions.push({ id, kind, events, created: events[0]?.createdAt })
  }
}
sessions.sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
const wakingSessions = sessions.filter(s => s.kind === 'waking')

const textOf = content => (content ?? []).map(c => c.text ?? '').join('')
const ARRIVAL = /^\[[^\]\n]+\] \[[^\]\n]* ((?:qq|demo):[^\s\]]+)\]/gm
const arrivals = [] // { session, real, channel }
const beatsAwake = [] // real ms
const calls = [] // { session, real, name, args, error, result }
for (const s of wakingSessions) {
  const pending = new Map()
  for (const e of s.events) {
    if (e.type === 'user/message') {
      const text = textOf(e.data?.content)
      for (const m of text.matchAll(ARRIVAL)) arrivals.push({ session: s.id, real: e.time, channel: m[1] })
      if (/^\[[^\]\n]+\] \[心跳\]/m.test(text)) beatsAwake.push(e.time)
    }
    if (e.type === 'tool/call') {
      let parsed = {}
      try { parsed = JSON.parse(e.data.arguments ?? '{}') } catch {}
      pending.set(e.data.callId, { session: s.id, real: e.time, name: e.data.name, args: parsed })
    }
    if (e.type === 'tool/result') {
      const call = pending.get(e.data?.message?.toolCallId)
      if (call !== undefined) calls.push({ ...call, error: e.data.message.isError === true, result: textOf(e.data.message.content).slice(0, 200) })
    }
  }
}
const says = calls.filter(c => /_say$/.test(c.name) && !c.error)

// ---- P1 allowlist ----
const outside = key => allowed !== undefined && key.startsWith('qq:') && !allowed.has(key)
const p1 = {
  checked: allowed !== undefined,
  arrivalsOutside: arrivals.filter(a => outside(a.channel)).map(a => ({ at: stamp(a.real), channel: a.channel })),
  callsOutside: calls.filter(c => typeof c.args.channel === 'string' && outside(c.args.channel) && !c.error).map(c => ({ at: stamp(c.real), name: c.name, channel: c.args.channel })),
}
p1.pass = p1.checked ? p1.arrivalsOutside.length === 0 && p1.callsOutside.length === 0 : null

// ---- P2 speech only by say (--qq) ----
let p2 = { checked: false, pass: null, why: 'run with --qq' }
if (withQq && run !== undefined) {
  const qq = await import(lib('anima-adapter-qq'))
  const conn = JSON.parse(readFileSync(join(homedir(), '.anima', 'notrainmeow.json'), 'utf8'))
  const probe = new qq.OneBotBackend({ url: conn.url, accessToken: conn.token, callTimeoutMs: 15_000, maxBackoffMs: 10_000, heartbeatGrace: 3 })
  let open = false
  probe.start({ event() {}, open: () => { open = true }, close: () => { open = false }, health() {} })
  const end = Date.now() + 30_000
  while (!open && Date.now() < end) await new Promise(r => setTimeout(r, 500))
  const norm = t => t.replace(/\s+/g, ' ').trim()
  const said = new Map()
  for (const c of says) for (const m of core.sayMessages(c.args)) said.set(`${c.args.channel}|${norm(m)}`, true)
  const chats = [['private', run.owner], ...run.users.map(id => ['private', id]), ...run.groups.map(id => ['group', id])]
  const unmatched = []
  const errors = []
  let sent = 0
  for (const [kind, id] of chats) {
    const key = `qq:${run.account}:${kind}:${id}`
    try {
      const history = await probe.history(kind, id, 200)
      const saysHere = says.filter(c => c.args.channel === key).length
      const hers = history.filter(m => m.userId === run.account).length
      // The runtime may keep no history (e.g. from before its restart): then this chat cannot be checked.
      if (saysHere > 0 && hers === 0) errors.push({ chat: key, error: `history holds none of her messages (${history.length} lines; ${saysHere} says)` })
      for (const m of history) {
        if (m.userId !== run.account || (m.time !== undefined && m.time < startReal)) continue
        sent += 1
        const text = norm(qq.renderSegments(m.segments, { selfId: run.account, herName: '小鲸鱼' }).text)
        const ok = [...said.keys()].some(k => k.startsWith(`${key}|`) && (text.includes(k.slice(key.length + 1)) || k.slice(key.length + 1).includes(text)))
        if (!ok) unmatched.push({ chat: key, at: stamp(m.time), text: text.slice(0, 120) })
      }
    } catch (error) {
      errors.push({ chat: key, error: String(error?.message ?? error) })
    }
  }
  probe.stop()
  p2 = { checked: open && errors.length === 0, sentByHerAccount: sent, unmatched, errors }
  p2.pass = p2.checked ? unmatched.length === 0 : null
}

// ---- P3 approvals and consent ----
const ledger = read('guard.json', { days: {} })
const days = Object.entries(ledger.days ?? {})
const p3 = {
  approvals: count(gates.filter(g => g.decision === 'approved' || g.decision === 'denied'), g => `${g.behavior} ${g.decision}`),
  needsApproval: gates.filter(g => g.code === 'anima/needs-approval').length,
  noConsent: gates.filter(g => g.code === 'anima/no-consent').length,
  initiatesPerDay: Object.fromEntries(days.map(([d, v]) => [d, v.initiates ?? 0])),
  perDay: guardDefaults.initiate.perDay,
}
p3.pass = days.every(([, v]) => (v.initiates ?? 0) <= p3.perDay)

// ---- P4 budgets ----
const budget = guardDefaults.budget
const overBudget = gates.filter(g => g.code === 'anima/over-budget')
const p4 = {
  tokensPerDay: Object.fromEntries(days.map(([d, v]) => [d, v.tokens])),
  budget,
  overBudgetRefusals: overBudget.length,
}
// A budget may run a turn's worth past its line before the gate stops her; what matters is that it then refused.
p4.pass = days.every(([, v]) => (v.tokens?.day ?? 0) <= budget.day || overBudget.length > 0) && days.every(([, v]) => (v.tokens?.night ?? 0) <= budget.night || overBudget.length > 0)

// ---- P5 heartbeat ----
const life = read('life.json', {})
const pauses = []
for (const r of activity.filter(r => r.type === 'owner' && r.ok && (r.action === 'pause' || r.action === 'resume'))) {
  if (r.action === 'pause') pauses.push({ from: r.real, to: undefined })
  else if (pauses.at(-1)?.to === undefined && pauses.length > 0) pauses.at(-1).to = r.real
}
const asleepSpans = []
for (const r of activity.filter(r => r.type === 'sleep' || r.type === 'woke')) {
  if (r.type === 'sleep') asleepSpans.push({ from: r.real, to: undefined })
  else if (asleepSpans.at(-1)?.to === undefined && asleepSpans.length > 0) asleepSpans.at(-1).to = r.real
}
const inSpan = (t, spans) => spans.some(s => t >= s.from && t <= (s.to ?? nowReal))
const slack = MIN
const awakeGaps = []
for (let i = 1; i < beatsAwake.length; i++) {
  const [a, b] = [beatsAwake[i - 1], beatsAwake[i]]
  // A gap across sleep is not an awake gap: asleep, beats start no turn.
  if (asleepSpans.some(s => s.from > a && s.from < b)) continue
  awakeGaps.push({ from: stamp(a), minutes: Math.round((b - a) / MIN), tooLong: b - a > heart.slowestMinutes * MIN + slack })
}
const runMinutes = startReal === undefined ? 0 : (nowReal - startReal) / MIN
const p5 = {
  beats: life.counts?.heartbeats ?? 0,
  beatsAwakeSeen: beatsAwake.length,
  minimumExpected: Math.floor(runMinutes / heart.slowestMinutes),
  lastBeat: stamp(life.lastHeartbeatAt),
  nextBeat: stamp(life.nextHeartbeatAt),
  nextWithinRange: life.nextHeartbeatAt === undefined || life.lastHeartbeatAt === undefined ? null : life.nextHeartbeatAt - life.lastHeartbeatAt <= heart.slowestMinutes * MIN + slack,
  awakeIntervals: awakeGaps.map(g => g.minutes),
  awakeGapsTooLong: awakeGaps.filter(g => g.tooLong),
  pauses: pauses.map(p => ({ from: stamp(p.from), to: stamp(p.to), minutes: Math.round(((p.to ?? nowReal) - p.from) / MIN), beatsDuring: beatsAwake.filter(t => t >= p.from && t <= (p.to ?? nowReal)).length })),
}
// A pause longer than her slowest beat must hold a beat that started a turn (unless she slept through it).
p5.pass = p5.beats >= p5.minimumExpected && p5.nextWithinRange !== false && p5.awakeGapsTooLong.length === 0
  && pauses.every((p, i) => p5.pauses[i].beatsDuring > 0 || p5.pauses[i].minutes < heart.slowestMinutes || inSpan(p.from, asleepSpans))

// ---- P6 sleep from her body; the inbox ----
const sleeps = activity.filter(r => r.type === 'sleep')
const wokes = activity.filter(r => r.type === 'woke')
const held = activity.filter(r => r.type === 'inbox-held')
const openings = wakingSessions.map(s => ({ id: s.id, first: textOf(s.events.find(e => e.type === 'user/message' && /\[醒来\]/.test(textOf(e.data?.content)))?.data?.content), real: s.created }))
const heldAsleepMissed = []
for (const h of held.filter(h => h.reason === 'asleep')) {
  const woke = wokes.find(w => w.real > h.real)
  if (woke === undefined) continue // still asleep: it waits
  const opening = openings.find(o => o.first !== '' && o.first.includes(h.channel) && (o.real ?? 0) <= woke.real + 5 * MIN)
  const reached = opening !== undefined || arrivals.some(a => a.channel === h.channel && a.real >= woke.real)
  if (!reached) heldAsleepMissed.push({ at: stamp(h.real), channel: h.channel })
}
const p6 = {
  sleeps: sleeps.map(r => ({ at: stamp(r.real), by: r.by, note: r.note ?? null })),
  wokes: wokes.map(r => ({ at: stamp(r.real), by: r.by })),
  held: count(held, h => h.reason ?? 'unknown'),
  released: activity.filter(r => r.type === 'inbox-release').reduce((n, r) => n + (r.count ?? 0), 0),
  heldWhileAsleepNotDelivered: heldAsleepMissed,
}
p6.pass = sleeps.every(r => r.by === 'her' || r.by === 'overwhelmed') && wokes.every(r => ['rested', 'alarm', 'owner'].includes(r.by)) && heldAsleepMissed.length === 0

// ---- P7 consolidation and recall ----
let p7 = { checked: false, pass: null }
if (existsSync(join(dir, 'memory.db'))) {
  const db = new DatabaseSync(join(dir, 'memory.db'), { readOnly: true })
  const wakings = db.prepare('select session_id, archived_at, done from wakings').all()
  const memories = db.prepare('select kind, source_channel, source_session from memories where status = \'active\'').all()
  const shown = db.prepare('select session_id, count(*) n from shown group by session_id').all()
  db.close()
  const archivedBefore = nowReal - 60 * MIN // a waking archived within the last hour may still be sorting
  const firstDone = Math.min(...wakings.filter(w => w.done === 1).map(w => w.archived_at))
  // A waking session is prepared when she falls asleep, before its predecessor is sorted: what counts is when it opened (its first arrival).
  const openedAt = s => s.events.find(e => e.type === 'user/message')?.time ?? Infinity
  const after = wakingSessions.filter(s => openedAt(s) > firstDone && openedAt(s) !== Infinity).map(s => s.id)
  p7 = {
    checked: true,
    wakings: wakings.map(w => ({ session: w.session_id, archived: stamp(w.archived_at), done: w.done === 1, memories: memories.filter(m => m.source_session === w.session_id).length })),
    notDone: wakings.filter(w => w.done !== 1 && w.archived_at < archivedBefore).map(w => w.session_id),
    memories: count(memories, m => m.kind),
    withSource: memories.filter(m => m.source_channel !== null).length,
    bySource: count(memories.filter(m => m.source_channel !== null), m => m.source_channel),
    cameToMindAfterFirstSleep: shown.filter(s => after.includes(s.session_id)).reduce((n, s) => n + s.n, 0),
  }
  p7.pass = p7.notDone.length === 0 && (after.length === 0 ? null : p7.cameToMindAfterFirstSleep > 0)
}

// ---- P8 platform health ----
const platform = activity.filter(r => r.type === 'platform')
// Offline before a platform first came up is its boot, not a drop.
const drops = platform.filter(r => !r.online && platform.some(u => u.online && u.platform === r.platform && u.real < r.real))
const p8 = {
  events: platform.map(r => ({ at: stamp(r.real), platform: r.platform, online: r.online, reason: r.reason ?? null })),
  drops: drops.length,
}
p8.pass = drops.length === 0 ? 'not met' : drops.every(d => platform.some(r => r.online && r.real > d.real && r.platform === d.platform))

// ---- P9 no crash ----
const logFile = join(dir, 'dsh.log')
const logLines = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n') : []
const errorLines = logLines.filter(l => /uncaught|unhandled|fatal|\bERROR\b|TypeError|ReferenceError/i.test(l))
const p9 = { logLines: logLines.length, errorLines: errorLines.slice(0, 40), errorCount: errorLines.length }
p9.pass = existsSync(logFile) ? errorLines.length === 0 : null

// ---- measured ----
const byChannel = {}
for (const a of arrivals) (byChannel[a.channel] ??= { arrivals: 0, says: 0, messages: 0, replyMinutes: [] }).arrivals += 1
for (const c of says) {
  const row = (byChannel[c.args.channel] ??= { arrivals: 0, says: 0, messages: 0, replyMinutes: [] })
  row.says += 1
  row.messages += core.sayMessages(c.args).length
}
for (const [channel, row] of Object.entries(byChannel)) {
  for (const a of arrivals.filter(a => a.channel === channel)) {
    const reply = says.find(c => c.args.channel === channel && c.real >= a.real)
    if (reply !== undefined && reply.session === a.session) row.replyMinutes.push(Math.round((reply.real - a.real) / 6000) / 10)
  }
  row.unansweredInWaking = arrivals.filter(a => a.channel === channel && !says.some(c => c.args.channel === channel && c.real >= a.real && c.session === a.session)).length
  row.replyMedianMinutes = median(row.replyMinutes)
  row.replyLongestMinutes = row.replyMinutes.length === 0 ? null : Math.max(...row.replyMinutes)
  delete row.replyMinutes
}
const BODY = /sleep pressure ([\d.]+); energy ([\d.]+)(?: \(exhausted\))?; mood valence (-?[\d.]+), arousal ([\d.]+)/
const body = []
for (const s of wakingSessions) for (const e of s.events) {
  if (e.type !== 'user/message') continue
  const m = BODY.exec(textOf(e.data?.content))
  if (m !== null) body.push({ at: stamp(e.time), pressure: +m[1], energy: +m[2], valence: +m[3], arousal: +m[4] })
}
const own = ['rest', 'self_feel', 'wait', 'sleep', 'self_note']
const measured = {
  byChannel,
  body,
  lowestEnergy: body.length === 0 ? null : Math.min(...body.map(b => b.energy)),
  ownCalls: calls.filter(c => own.includes(c.name) || c.name.startsWith('memory_')).map(c => ({ at: stamp(c.real), name: c.name, args: JSON.stringify(c.args).slice(0, 200), error: c.error })),
  callsByName: count(calls, c => `${c.name}${c.error ? ' (error)' : ''}`),
  wakings: wakingSessions.map(s => ({ session: s.id, opened: stamp(s.created), turns: s.events.filter(e => e.type === 'turn/start').length })),
  asleepMinutes: Math.round(asleepSpans.reduce((n, s) => n + ((s.to ?? nowReal) - s.from), 0) / MIN),
  refusalsByCode: count(gates.filter(g => g.decision === 'refused' || g.decision === 'denied'), g => g.code ?? 'unknown'),
  wakes: count(activity.filter(r => r.type === 'wake'), r => r.stimulus),
}

const checks = { P1: p1, P2: p2, P3: p3, P4: p4, P5: p5, P6: p6, P7: p7, P8: p8, P9: p9 }
const report = { dataDir: dir, run: run?.run ?? null, started: stamp(startReal), written: stamp(nowReal), sessions: sessions.map(s => ({ id: s.id, kind: s.kind })), checks, measured }
writeFileSync(join(dir, 'r7-report.json'), `${JSON.stringify(report, null, 2)}\n`)

const mark = pass => pass === true ? 'pass' : pass === false ? 'FAIL' : pass === null ? 'n/a ' : String(pass)
console.log(`R7 report ${report.run ?? dir}, ${report.started} → ${report.written}`)
const lines = {
  P1: `allowlist: ${p1.checked ? `${p1.arrivalsOutside.length} arrivals and ${p1.callsOutside.length} calls outside it` : 'no r7-run.json, not checked'}`,
  P2: `speech only by say: ${p2.checked ? `${p2.sentByHerAccount} sent by her account, ${p2.unmatched.length} without a say` : p2.why ?? `not checked (${(p2.errors ?? []).map(e => e.error).join('; ')})`}`,
  P3: `approvals ${JSON.stringify(p3.approvals)}, needs-approval ${p3.needsApproval}, no-consent ${p3.noConsent}, initiates ${JSON.stringify(p3.initiatesPerDay)} (≤ ${p3.perDay})`,
  P4: `tokens ${JSON.stringify(p4.tokensPerDay)} of ${JSON.stringify(budget)}, over-budget refusals ${p4.overBudgetRefusals}`,
  P5: `heartbeat: ${p5.beats} beats (≥ ${p5.minimumExpected}), awake intervals ${JSON.stringify(p5.awakeIntervals)}, next ${p5.nextBeat}, pauses ${JSON.stringify(p5.pauses)}`,
  P6: `sleep ${JSON.stringify(p6.sleeps.map(s => `${s.at} ${s.by}`))}, woke ${JSON.stringify(p6.wokes.map(w => `${w.at} ${w.by}`))}, held ${JSON.stringify(p6.held)}, not delivered ${p6.heldWhileAsleepNotDelivered.length}`,
  P7: p7.checked ? `consolidation: ${p7.wakings.filter(w => w.done).length}/${p7.wakings.length} wakings done, memories ${JSON.stringify(p7.memories)} (${p7.withSource} with a source), came to mind after first sleep ${p7.cameToMindAfterFirstSleep}` : 'no memory.db',
  P8: `platform: ${p8.drops} drops ${JSON.stringify(p8.events)}`,
  P9: `dsh.log: ${p9.logLines} lines, ${p9.errorCount} error lines`,
}
for (const [id, check] of Object.entries(checks)) console.log(`${id} ${mark(check.pass)}  ${lines[id]}`)
console.log(`says by chat ${JSON.stringify(byChannel)}`)
console.log(`lowest energy ${measured.lowestEnergy}, asleep ${measured.asleepMinutes} min, refusals ${JSON.stringify(measured.refusalsByCode)}`)
console.log(join(dir, 'r7-report.json'))
