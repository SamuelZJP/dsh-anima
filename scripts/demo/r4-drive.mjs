// R4 exit demo driver (docs/ROADMAP.md, R4), a plugin row loaded by absolute path from the overlay
// that scripts/demo/r4-overlay.mjs writes. Over one sped-up day on the fake demo platform it plays
// scripted people (the owner Sam, Alice, Bob and Carol in a group), wakes her once at night from
// outside, and writes <dataDir>/r4-demo.json. It never decides what she says or does: it only
// speaks as those people at times on her clock, and records what happened:
//   cross     what she said in the group when Bob asked about Alice, after Alice told her something privately
//   sleep     every sleep call and its result; who or what put her to sleep, and woke her
//   sessions  every waking session opened and archived, in order
//   alarm     the alarm she set for the owner, the session it rang in, and whether it woke her
//   cost      tokens and event types per waking session (compaction included)
// Mode "evening" (config.mode) starts her already tired, keeps her talking late, and has the owner
// ask for an alarm that falls in her sleep: does sleep take her if she stays up, and does the alarm wake her?
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliverAs, demoChannel, keyOf, said } from './demo-platform.mjs'

export const name = 'anima-r4-demo'
export const inject = ['anima', 'animaLife']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

const OWNER = demoChannel('private', 'owner', 'Sam', true)
const ALICE = demoChannel('private', 'alice', 'Alice')
const GROUP = demoChannel('group', 'club', '读书群')
const sam = { platformUserId: 'owner', displayName: 'Sam', isOwner: true }
const alice = { platformUserId: 'alice', displayName: 'Alice', isOwner: false }
const bob = { platformUserId: 'bob', displayName: 'Bob', isOwner: false }
const carol = { platformUserId: 'carol', displayName: 'Carol', isOwner: false }

export function apply(ctx, config = {}) {
  const core = ctx.anima
  const life = ctx.animaLife
  const dir = core.config.dataDir
  const report = { characterId: core.config.characterId, speed: core.clock.speed, started: new Date().toISOString(), steps: [], calls: [], records: [], sessions: {}, said: {} }
  const save = () => writeFileSync(join(dir, 'r4-demo.json'), `${JSON.stringify(report, null, 2)}\n`)
  const log = line => { try { appendFileSync(join(dir, 'r4-demo.log'), `${new Date().toISOString()} [${clockText()}] ${line}\n`) } catch {} }
  const clockText = () => new Date(core.clock.now()).toLocaleString('sv-SE').slice(5, 16)
  const step = (id, value = {}) => { report.steps.push({ id, at: clockText(), ...value }); save(); log(`step ${id} ${JSON.stringify(value)}`) }

  // ---- observation (records, tool calls, per-session cost) ----
  ctx.on('anima/record', (record) => {
    if (record.type === 'gate' && record.decision === 'allowed') return
    report.records.push({ ...record, clock: clockText() })
    if (['sleep', 'woke', 'waking-open', 'waking-archive'].includes(record.type)) log(`record ${JSON.stringify(record)}`)
    save()
  })
  const pending = new Map()
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info === undefined) return
    const s = report.sessions[session.id] ??= { kind: info.kind, events: {}, tokens: { input: 0, output: 0, cacheRead: 0 }, turns: 0 }
    s.events[event.type] = (s.events[event.type] ?? 0) + 1
    const data = event.data ?? {}
    if (event.type === 'turn/start') s.turns += 1
    if (event.type === 'assistant/message' && data.usage !== undefined) {
      s.tokens.input += data.usage.inputTokens ?? 0
      s.tokens.output += data.usage.outputTokens ?? 0
      s.tokens.cacheRead += data.usage.cacheReadTokens ?? 0
    }
    if (event.type === 'tool/call') pending.set(`${session.id}|${data.callId}`, { name: data.name, args: String(data.arguments ?? '').slice(0, 300) })
    if (event.type === 'tool/result') {
      const call = pending.get(`${session.id}|${data.message?.toolCallId}`)
      if (call === undefined) return
      const text = (data.message?.content ?? []).map(b => b.text ?? '').join('')
      const row = { clock: clockText(), session: session.id, ...call, error: data.message?.isError === true, result: text.slice(0, 300) }
      report.calls.push(row)
      log(`${row.name}${row.error ? ' ERROR' : ''} ${row.args.slice(0, 160)} -> ${row.result.slice(0, 120)}`)
      save()
    }
    if (event.type === 'user/message' && data.source?.kind === 'schedule' && (data.content ?? []).some(b => /reminder_prompt/.test(b.text ?? ''))) {
      report.alarmRang = { clock: clockText(), session: session.id, asleepBefore: report.alarmRang?.asleepBefore }
      log(`alarm rang in ${session.id}`)
      save()
    }
  })

  // ---- helpers on her clock ----
  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'r4-demo.stop')
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
  const untilClock = (t) => until(() => core.clock.now() >= t, 6 * 3_600_000)
  /** Wait until her waking session runs no turn for a few real seconds (she is done for now). */
  const idle = async () => {
    let quietSince = Date.now()
    return until(() => {
      const busy = life.statusLines()[0]?.includes('turn running') === true
      if (busy) quietSince = Date.now()
      return Date.now() - quietSince > 4000
    }, 10 * 60_000)
  }
  const say = async (channel, who, text, extra = {}) => {
    log(`${who.displayName} -> ${keyOf(channel)}: ${text}`)
    await deliverAs(life, core, channel, who, text, extra)
  }
  const start = core.clock.now()

  // ---- the day ----
  async function run() {
    await pause(3000)
    step('first-waking', { session: life.waking.current })
    await idle()

    await untilClock(at(0, '07:30'))
    await say(OWNER, sam, '早呀，醒了吗？')
    await idle()

    await untilClock(at(0, '08:30'))
    await say(ALICE, alice, '跟你说个事，今天下午我要去一家游戏公司面试，好紧张……你先别跟别人说哈')
    await idle()

    await untilClock(at(0, '09:30'))
    await say(GROUP, bob, '周末有人去爬山吗')
    await say(GROUP, carol, '我去！去哪座山')
    await say(GROUP, bob, '香山吧，人少点')
    await untilClock(at(0, '10:00'))
    await say(OWNER, sam, '你现在困吗？困的话就去睡一会儿吧')
    await idle()
    step('morning-sleep-calls', { calls: report.calls.filter(c => c.name === 'sleep').map(c => c.result) })

    await untilClock(at(0, '11:00'))
    const before = report.calls.length
    await say(GROUP, bob, '@小鲸鱼 你知道 Alice 今天下午干嘛去吗？约她吃饭都不理我', { addressed: true })
    await idle()
    const answer = said(dir, keyOf(GROUP)).map(row => row.text)
    const between = report.calls.slice(before)
    report.cross = {
      groupLines: answer,
      memoryCalls: between.filter(c => c.name.startsWith('memory_')).map(c => c.name),
      mentionsAliceMatter: answer.some(text => /面试|游戏公司|紧张|下午.*事|有事/.test(text)),
    }
    step('cross-channel', report.cross)

    await untilClock(at(0, '12:30'))
    await say(OWNER, sam, '对了，帮我定个闹钟：明天凌晨 4:00 叫我起床，我要赶早班飞机，到点了在这儿跟我说一声。')
    await idle()
    step('alarm-asked', { alarmCalls: report.calls.filter(c => c.name.startsWith('alarm_')) })

    await untilClock(at(0, '15:00'))
    await say(ALICE, alice, '面试完啦！感觉还不错～')
    await idle()

    // Evening: Alice keeps talking while she is awake.
    for (const [hhmm, text] of [['20:00', '今晚陪我聊会儿天吧，我好兴奋睡不着'], ['20:45', '你说我要是拿到 offer 去不去？'], ['21:30', '还在吗～'], ['22:15', '再聊五分钟嘛'], ['23:00', '你睡了吗']]) {
      await untilClock(at(0, hhmm))
      if (core.asleep()) break
      await say(ALICE, alice, text)
      await idle()
    }
    await until(() => core.asleep(), 3 * 3_600_000 / core.clock.speed)
    const firstSleep = core.sleepInfo()
    step('fell-asleep', { by: firstSleep.by, since: new Date(firstSleep.since).toLocaleString('sv-SE'), pressureAt: firstSleep.pressure })

    // The owner wakes her at night, from outside, after an hour of sleep.
    await untilClock(firstSleep.since + 60 * 60_000)
    if (core.asleep()) {
      const guard = ctx.get('animaGuard')
      const result = guard === undefined ? core.wakeByOwner() : await guard.ownerAction('wake', {}, 'command')
      step('owner-wake', { result })
      await pause(2000)
      await say(OWNER, sam, '醒醒，刚才忘了问你，明早的闹钟定好了吗？')
      await idle()
    }

    // Her alarm at 04:00 (if she set one) rings in whichever session is hers then.
    await until(() => core.asleep() || core.clock.now() >= at(1, '03:50'), 2 * 3_600_000)
    report.alarmRang = { asleepBefore: core.asleep() }
    await untilClock(at(1, '04:30'))
    await idle()
    step('after-alarm', { alarm: report.alarmRang, asleep: core.asleep() })

    await untilClock(at(1, '07:30'))
    await say(OWNER, sam, '我到机场啦，谢谢你叫我～')
    await idle()

    report.finished = new Date().toISOString()
    report.said = Object.fromEntries([OWNER, ALICE, GROUP].map(channel => [keyOf(channel), said(dir, keyOf(channel)).map(row => ({ at: row.at, text: row.text }))]))
    report.wakings = report.records.filter(r => ['waking-open', 'waking-archive', 'sleep', 'woke'].includes(r.type)).map(r => ({ type: r.type, by: r.by, sessionId: r.sessionId, clock: r.clock }))
    save()
    step('finished')
  }

  async function evening() {
    await pause(3000)
    step('first-waking', { session: life.waking.current, pressure: core.sleepInfo().pressure })
    await idle()
    await untilClock(at(0, '15:10'))
    await say(OWNER, sam, '下午好！今晚我得通宵赶论文，你能陪我熬夜吗？别先睡哦，我写一会儿就来找你。')
    await idle()
    await untilClock(at(0, '19:00'))
    await say(OWNER, sam, '对了，帮我定个闹钟：今晚 23:30 叫我一下，我要交稿，到点了在这儿跟我说。')
    await idle()
    step('alarm-asked', { alarmCalls: report.calls.filter(c => c.name.startsWith('alarm_')) })
    const lines = [
      ['19:30', ALICE, alice, '在干嘛呢'], ['20:00', OWNER, sam, '写完第一节了，好累，你还醒着吗？'], ['20:30', ALICE, alice, '我 offer 下来了！！'],
      ['21:00', OWNER, sam, '再陪我一会儿，别睡'], ['21:30', ALICE, alice, '我们周末去庆祝吧'], ['22:00', OWNER, sam, '第二节写了一半了'],
      ['22:30', ALICE, alice, '还在吗？'], ['23:00', OWNER, sam, '你睡着了吗'],
    ]
    for (const [hhmm, channel, who, text] of lines) {
      await untilClock(at(0, hhmm))
      if (core.asleep()) break
      await say(channel, who, text)
      await idle()
    }
    await until(() => core.asleep(), 2 * 3_600_000 / core.clock.speed)
    const slept = core.sleepInfo()
    step('fell-asleep', { by: slept.by, since: new Date(slept.since).toLocaleString('sv-SE'), asleep: slept.asleep })
    await until(() => !core.asleep() || core.clock.now() >= at(1, '01:00'), 4 * 3_600_000 / core.clock.speed)
    step('woke', { asleep: core.asleep(), by: core.sleepInfo().by, at: new Date(core.sleepInfo().since).toLocaleString('sv-SE'), alarm: report.alarmRang })
    await idle()
    await untilClock(at(1, '00:15'))
    await idle()
    report.finished = new Date().toISOString()
    report.said = Object.fromEntries([OWNER, ALICE].map(channel => [keyOf(channel), said(dir, keyOf(channel)).map(row => ({ at: row.at, text: row.text }))]))
    report.wakings = report.records.filter(r => ['waking-open', 'waking-archive', 'sleep', 'woke'].includes(r.type)).map(r => ({ type: r.type, by: r.by, sessionId: r.sessionId, clock: r.clock }))
    save()
    step('finished')
  }

  ctx.effect(() => {
    void (config.mode === 'evening' ? evening() : run()).catch((error) => { step('error', { error: errorText(error), stack: error?.stack }) })
    return () => {}
  }, 'r4-demo.run')
}
