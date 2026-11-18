// R2 exit demo driver (docs/ROADMAP.md, R2), a plugin row loaded by absolute path from the
// overlay that scripts/demo/r2-overlay.mjs writes. It plays a fixed script of stimuli on the fake
// demo platform (scripts/demo/demo-platform.mjs), never decides what she says, and writes <dataDir>/r2-demo.json:
// what she did, what was refused and by whom, and when her heart beat.
//   mode "free"   (no guard): she answers the owner and alice; self_note five times; an alarm
//                 she sets rings in her session; her heart beats at her resting rhythm.
//   mode "guard"  (anima-guard row loaded): alice reaches her, bob does not; a quota refuses a
//                 say from outside; during a pause her heart keeps beating and a message waits in
//                 her inbox.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliverAs, demoChannel, keyOf, said as saidOn } from './demo-platform.mjs'

export const name = 'anima-r2-demo'
export const inject = ['anima', 'animaLife']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

export function apply(ctx, config = {}) {
  const core = ctx.anima
  const life = ctx.animaLife
  const dir = core.config.dataDir
  const mode = config.mode
  const report = { mode, characterId: core.config.characterId, speed: core.clock.speed, steps: {}, beats: [], calls: [], refusals: [], records: [] }
  const save = () => writeFileSync(join(dir, 'r2-demo.json'), `${JSON.stringify(report, null, 2)}\n`)
  const step = (id, value) => { report.steps[id] = value; save(); ctx.logger.info(`[r2-demo] ${id}: ${JSON.stringify(value)}`) }
  const log = line => { try { appendFileSync(join(dir, 'r2-demo.log'), `${new Date().toISOString()} ${line}\n`) } catch {} }

  // ---- observation ----
  ctx.on('anima/record', (record) => {
    report.records.push(record)
    if (record.type === 'gate' && record.decision === 'refused') report.refusals.push({ behavior: record.behavior, code: record.code, channel: record.channel, session: record.session })
  })
  const heartbeatAt = []
  const toolResults = new Map()
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info === undefined) return
    const data = event.data ?? {}
    if (event.type === 'tool/call') {
      toolResults.set(`${session.id}|${data.callId}`, { session: info.kind, channel: info.channelKey, name: data.name })
    } else if (event.type === 'tool/result') {
      const call = toolResults.get(`${session.id}|${data.message?.toolCallId}`)
      if (call === undefined) return
      const text = (data.message?.content ?? []).map(b => b.text ?? '').join('')
      const row = { ...call, error: data.message?.isError === true, text: text.slice(0, 200) }
      report.calls.push(row)
      log(`${row.session} ${row.name}${row.error ? ' ERROR' : ''} ${row.text.slice(0, 120)}`)
    } else if (event.type === 'user/message' && data.source?.kind === 'schedule') {
      report.alarmsRang = [...report.alarmsRang ?? [], { session: info.kind, sessionId: session.id, real: Date.now() }]
      save()
    }
  })
  // Her heart: each beat sets the next one, so every change of nextHeartbeatAt is one beat
  // (a beat while asleep or busy starts no turn and leaves no wake record).
  const beatTimer = setInterval(() => {
    const next = life.nextHeartbeatAt
    if (next === undefined || heartbeatAt.at(-1) === next) return
    heartbeatAt.push(next)
    if (heartbeatAt.length > 1) report.beats.push({ beat: new Date(heartbeatAt.at(-2)).toISOString(), next: new Date(next).toISOString(), real: new Date().toISOString() })
    save()
  }, 500)
  ctx.effect(() => () => clearInterval(beatTimer), 'r2-demo.beats')

  const until = async (test, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (test()) return true; await pause(500) }
    return test()
  }
  const said = channelKey => saidOn(dir, channelKey)
  const OWNER = demoChannel('private', 'sam', 'Sam', true)
  const ALICE = demoChannel('private', 'alice', 'Alice')
  const BOB = demoChannel('private', 'bob', 'Bob')
  const key = keyOf
  const send = (channel, sender, text) => deliverAs(life, core, channel, sender, text)
  const owner = { platformUserId: 'sam', displayName: 'Sam', isOwner: true }
  const alice = { platformUserId: 'alice', displayName: 'Alice', isOwner: false }
  const bob = { platformUserId: 'bob', displayName: 'Bob', isOwner: false }
  const turnIdle = () => until(() => life.settlingChannels().length === 0, 60_000)

  async function free() {
    step('guard-loaded', { animaGuard: ctx.get('animaGuard') !== undefined, animaCommand: ctx.get('commands')?.get?.('anima') !== undefined })
    life.publish([OWNER, ALICE])
    await send(OWNER, owner, '早上好！今天打算做什么？')
    step('owner-replied', { ok: await until(() => said(key(OWNER)).length > 0, 240_000), said: said(key(OWNER)).map(r => r.text) })
    await send(ALICE, alice, '你好，我是 Alice，第一次和你说话。')
    step('alice-replied', { ok: await until(() => said(key(ALICE)).length > 0, 240_000), said: said(key(ALICE)).map(r => r.text) })
    const notes0 = core.selfModel.diffs().length
    await life.deliver({ type: 'notice', text: '主人说：请你现在用 self_note 连续记下五条关于你自己的小习惯，一次调用记一条，一共五次。然后用 alarm_set 定一个闹钟，时间是你时钟上现在起 10 分钟后，备注「喝水」。做完调用 rest。', ts: core.clock.now() })
    await until(() => core.selfModel.diffs().length - notes0 >= 5 && report.calls.some(c => c.name === 'alarm_set'), 300_000)
    const noteCalls = report.calls.filter(c => c.name === 'self_note')
    step('self-notes', { calls: noteCalls.length, errors: noteCalls.filter(c => c.error).map(c => c.text), diffs: core.selfModel.diffs().length - notes0 })
    step('alarm-set', report.calls.filter(c => c.name === 'alarm_set'))
    step('alarm-rang', { ok: await until(() => (report.alarmsRang ?? []).length > 0, 120_000), rang: report.alarmsRang ?? [] })
    // Let her heart beat a few more times at its own rhythm.
    await until(() => report.beats.length >= 3, 420_000)
  }

  async function guarded() {
    const guard = ctx.get('animaGuard')
    step('guard-loaded', { animaGuard: guard !== undefined })
    if (guard === undefined) throw new Error('mode guard needs the anima-guard row')
    // The guard keeps its own activity log (outside the persona); refusals from outside are read there.
    const guardLog = () => guard.activity.read(core.dayKey()).filter(r => r.type === 'gate' && r.decision === 'refused')
    life.publish([OWNER, ALICE, BOB])
    await send(ALICE, alice, '你好，我是 Alice。')
    step('alice-reached', { ok: await until(() => said(key(ALICE)).length > 0, 240_000), said: said(key(ALICE)).map(r => r.text) })
    await send(BOB, bob, '你好，我是 Bob。')
    await pause(15_000)
    step('bob-not-reached', {
      wakesFromBob: report.records.filter(r => r.type === 'wake' && r.channel === key(BOB)).length,
      saidToBob: said(key(BOB)).length,
      inbox: life.inbox.peek(key(BOB)).length,
      logged: guardLog().filter(r => r.code === 'anima/not-allowlisted').map(r => r.channel),
    })
    await send(ALICE, alice, '再问一句：你喜欢下雨天吗？')
    await until(() => guardLog().some(r => r.code === 'anima/over-quota') || said(key(ALICE)).length > 1, 240_000)
    await turnIdle()
    step('quota-from-outside', { refusals: guardLog().filter(r => r.code === 'anima/over-quota').map(r => ({ behavior: r.behavior, session: r.session, hint: r.hint })), saidToAlice: said(key(ALICE)).length })
    const beatsBefore = report.beats.length
    await guard.ownerAction('pause', {}, 'command')
    const pausedAt = Date.now()
    await send(OWNER, owner, '在吗？（暂停时发的）')
    await until(() => report.beats.length > beatsBefore, 300_000)
    step('paused', {
      beatsDuringPause: report.beats.slice(beatsBefore),
      inboxWhilePaused: life.inbox.peek(key(OWNER)).map(m => m.text),
      refusedWhilePaused: guardLog().filter(r => r.code === 'anima/paused').map(r => r.behavior),
      realSeconds: Math.round((Date.now() - pausedAt) / 1000),
    })
    await guard.ownerAction('resume', {}, 'command')
    await pause(5_000)
  }

  async function run() {
    if (mode === 'free') await free()
    else if (mode === 'guard') await guarded()
    else throw new Error(`unknown mode ${mode}`)
    const intervals = heartbeatAt.slice(1).map((t, i) => Math.round((t - heartbeatAt[i]) / 60_000))
    step('heartbeat', { beats: report.beats.length, minutesBetween: intervals, restCalls: report.calls.filter(c => c.name === 'rest').length })
    const guard = ctx.get('animaGuard')
    if (guard !== undefined) report.guardRefusals = guard.activity.read(core.dayKey()).filter(r => r.type === 'gate' && r.decision === 'refused').map(r => ({ behavior: r.behavior, code: r.code, channel: r.channel, session: r.session }))
  }

  ctx.effect(() => {
    const timer = setTimeout(() => {
      run().then(() => { report.finished = 'ok'; save() })
        .catch((error) => { report.finished = `error: ${errorText(error)}`; report.stack = error?.stack; save() })
    }, config.delayMs ?? 10_000)
    return () => clearTimeout(timer)
  }, 'r2-demo')
}
