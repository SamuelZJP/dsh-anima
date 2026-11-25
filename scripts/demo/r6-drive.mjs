// R6 exit demo driver (docs/ROADMAP.md, R6), a plugin row loaded by absolute path from the overlay
// that scripts/demo/r6-overlay.mjs writes. On the fake demo platform it plays scripted people (the
// owner Sam, Alice and Bob privately, Bob and Carol in the book club group, who address her) and
// writes <dataDir>/r6-demo.json and r6-demo.log. It never decides what she says or does, or when she
// rests or sleeps: it only speaks as those people on her clock, and records:
//   samples     her energy, sleep pressure, mood and phase every 10 minutes on her clock
//   beats       every heartbeat: when, the interval it set, and her state then
//   calls       every behavior call in her waking sessions (rest, sleep and self_feel among them)
//   refusals    every refusal of her body at the gate; at the end, every refusal in the activity log (the guard's too)
//   sleep       how and when she fell asleep
// A busy stretch from 13:05 to 17:30 (each person writes again once she has gone quiet), then
// nobody writes; it watches until she sleeps, or 02:00 on her clock.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliverAs, demoChannel } from './demo-platform.mjs'

export const name = 'anima-r6-demo'
export const inject = ['anima', 'animaLife']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

const OWNER = demoChannel('private', 'owner', 'Sam', true)
const ALICE = demoChannel('private', 'alice', 'Alice')
const BOBP = demoChannel('private', 'bob', 'Bob')
const GROUP = demoChannel('group', 'club', '读书群')
const sam = { platformUserId: 'owner', displayName: 'Sam', isOwner: true }
const alice = { platformUserId: 'alice', displayName: 'Alice', isOwner: false }
const bob = { platformUserId: 'bob', displayName: 'Bob', isOwner: false }
const carol = { platformUserId: 'carol', displayName: 'Carol', isOwner: false }

/** People who keep writing to her through the afternoon; each line asks for an answer. */
const SCRIPT = [
  [ALICE, alice, '下午好！我在纠结周末去哪，你有推荐吗？'],
  [GROUP, bob, '@小鲸鱼 这个月读书会选哪本？你来定吧'],
  [BOBP, bob, '我刚看完《三体》第二部，太震撼了，你看过吗'],
  [OWNER, sam, '下午忙什么呢？'],
  [GROUP, carol, '@小鲸鱼 上次你说的那本散文集叫什么来着'],
  [ALICE, alice, '我又想了想，还是想去海边，你觉得冬天的海好看吗'],
  [BOBP, bob, '你觉得面壁者里谁最厉害？'],
  [GROUP, bob, '@小鲸鱼 读书会定周六下午三点可以吗？'],
  [OWNER, sam, '帮我想想晚饭吃什么'],
  [ALICE, alice, '你平时喜欢听什么歌？推荐几首'],
  [GROUP, carol, '@小鲸鱼 你能给大家写个读书会的开场白吗'],
  [BOBP, bob, '黑暗森林法则你信吗？'],
  [ALICE, alice, '我最近总失眠，你有什么办法吗'],
  [GROUP, bob, '@小鲸鱼 有人说想加一本推理小说，你怎么看'],
  [OWNER, sam, '今天累不累？'],
  [BOBP, bob, '再问一个：你最喜欢的科幻小说是哪本？'],
]

export function apply(ctx) {
  const core = ctx.anima
  const life = ctx.animaLife
  const dir = core.config.dataDir
  const report = { characterId: core.config.characterId, speed: core.clock.speed, genes: { sleep: core.config.sleep, energy: core.config.energy, heartbeat: core.config.heartbeat }, started: new Date().toISOString(), steps: [], samples: [], beats: [], calls: [], refusals: [], delivered: 0 }
  const save = () => writeFileSync(join(dir, 'r6-demo.json'), `${JSON.stringify(report, null, 2)}\n`)
  const clockText = (t = core.clock.now()) => new Date(t).toLocaleString('sv-SE').slice(5, 16)
  const log = line => { try { appendFileSync(join(dir, 'r6-demo.log'), `${new Date().toISOString()} [${clockText()}] ${line}\n`) } catch {} }
  const step = (id, value = {}) => { report.steps.push({ id, at: clockText(), ...value }); save(); log(`step ${id} ${JSON.stringify(value)}`) }
  const body = () => {
    const s = core.selfState()
    return { energy: +s.energy.toFixed(3), pressure: +s.sleepPressure.toFixed(3), valence: +s.mood.valence.toFixed(2), arousal: +s.mood.arousal.toFixed(2), asleep: core.asleep() }
  }

  // ---- observation ----
  ctx.on('anima/record', (record) => {
    if (['sleep', 'woke', 'waking-open', 'waking-archive'].includes(record.type)) {
      log(`record ${JSON.stringify(record)}`)
      report.steps.push({ id: `record:${record.type}`, at: clockText(), ...record, body: body() })
      if (record.type === 'sleep') report.sleep = { at: clockText(), by: record.by, note: record.note ?? null, body: body() }
      save()
    }
    if (record.type === 'gate' && record.decision === 'refused') {
      report.refusals.push({ at: clockText(), behavior: record.behavior, code: record.code, hint: record.hint })
      log(`refused ${record.behavior} ${record.code}`)
      save()
    }
  })
  const pending = new Map()
  const textOf = content => (content ?? []).map(b => b.text ?? '').join('')
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info?.kind !== 'waking') return
    const data = event.data ?? {}
    if (event.type === 'tool/call') pending.set(`${session.id}|${data.callId}`, { name: data.name, args: String(data.arguments ?? '').slice(0, 300) })
    if (event.type === 'tool/result') {
      const call = pending.get(`${session.id}|${data.message?.toolCallId}`)
      if (call === undefined) return
      const text = textOf(data.message?.content)
      const row = { clock: clockText(), ...call, error: data.message?.isError === true, result: text.slice(0, 300), body: body() }
      report.calls.push(row)
      log(`${row.name}${row.error ? ' ERROR' : ''} ${row.args.slice(0, 160)} -> ${row.result.slice(0, 160)} | e ${row.body.energy} p ${row.body.pressure}`)
      save()
    }
  })

  // ---- helpers on her clock ----
  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'r6-demo.stop')
  const start = core.clock.now()
  const at = (day, hhmm) => {
    const d = new Date(start)
    d.setDate(d.getDate() + day)
    const [h, m] = hhmm.split(':').map(Number)
    d.setHours(h, m, 0, 0)
    return d.getTime()
  }
  const until = async (test, realMs = 30 * 60_000) => {
    const end = Date.now() + realMs
    while (!stopped && Date.now() < end) { if (await test()) return true; await pause(1000) }
    return test()
  }
  const untilClock = t => until(() => core.clock.now() >= t, 6 * 3_600_000)
  const busy = () => life.statusLines()[0]?.includes('turn running') === true
  const idle = async () => {
    let quietSince = Date.now()
    return until(() => {
      if (busy()) quietSince = Date.now()
      return Date.now() - quietSince > 4000
    }, 10 * 60_000)
  }
  const say = async (channel, who, text, extra = {}) => {
    log(`${core.asleep() ? '(asleep) ' : ''}${who.displayName} -> ${channel.kind}:${channel.id}: ${text}`)
    report.delivered += 1
    await deliverAs(life, core, channel, who, text, extra)
  }

  // Samples every 10 minutes on her clock, and every heartbeat.
  ctx.effect(() => {
    let lastSample = 0
    let lastBeat = life.file?.lastHeartbeatAt
    const timer = setInterval(() => {
      const now = core.clock.now()
      if (now - lastSample >= 10 * 60_000) {
        lastSample = now
        report.samples.push({ clock: clockText(now), ...body(), busy: busy() })
      }
      const beat = life.file?.lastHeartbeatAt
      if (beat !== undefined && beat !== lastBeat) {
        lastBeat = beat
        const next = life.file?.nextHeartbeatAt
        const row = { clock: clockText(beat), nextIn: next === undefined ? null : Math.round((next - beat) / 60_000), ...body() }
        report.beats.push(row)
        log(`heartbeat; next in ${row.nextIn} min | e ${row.energy} p ${row.pressure} a ${row.arousal} v ${row.valence}${row.asleep ? ' asleep' : ''}`)
      }
      save()
    }, 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'r6-demo.sample')

  async function run() {
    await pause(3000)
    step('first-waking', { session: life.waking.current, body: body() })
    await idle()
    await untilClock(at(0, '13:05'))
    step('busy-start', { body: body() })
    let i = 0
    while (!stopped && core.clock.now() < at(0, '17:30') && !core.asleep()) {
      const [channel, who, text] = SCRIPT[i % SCRIPT.length]
      const round = Math.floor(i / SCRIPT.length)
      await say(channel, who, round === 0 ? text : `${text}（再问一次）`, channel.kind === 'group' ? { addressed: true } : {})
      i += 1
      await pause(2000)
      await idle()
    }
    step('busy-end', { body: body(), messages: i, says: report.calls.filter(c => c.name.endsWith('_say') && !c.error).length })
    await until(() => core.asleep() || core.clock.now() >= at(1, '02:00'), 6 * 3_600_000 / core.clock.speed + 10 * 60_000)
    await idle()
    const activity = join(dir, 'activity')
    const logged = existsSync(activity) ? readdirSync(activity).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(activity, f), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))) : []
    const refusedCodes = {}
    for (const row of logged) if (row.type === 'gate' && row.decision === 'refused') refusedCodes[row.code] = (refusedCodes[row.code] ?? 0) + 1
    const own = report.calls.filter(c => c.name === 'rest' || c.name === 'sleep')
    report.exit = {
      asleep: core.asleep(),
      sleep: report.sleep ?? null,
      restOrSleepCalls: own.map(c => `${c.clock} ${c.name} ${c.args} -> ${c.result}`),
      ofHerOwnAccord: report.sleep?.by === 'her' || own.some(c => c.name === 'rest' && !c.error),
      lowestEnergy: Math.min(...report.samples.map(s => s.energy)),
      exhaustedRefusals: report.refusals.filter(r => r.code === 'anima/exhausted').length,
      refusedInActivityLog: refusedCodes,
      quotaRefusals: refusedCodes['anima/over-quota'] ?? 0,
      beatIntervals: report.beats.map(b => b.nextIn),
    }
    report.finished = new Date().toISOString()
    save()
    step('finished', report.exit)
  }

  ctx.effect(() => {
    void run().catch((error) => { step('error', { error: errorText(error), stack: error?.stack }) })
    return () => {}
  }, 'r6-demo.run')
}
