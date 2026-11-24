// R5 exit demo driver (docs/ROADMAP.md, R5), a plugin row loaded by absolute path from the overlay
// that scripts/demo/r5-overlay.mjs writes. On the fake demo platform it plays scripted people (the
// owner Sam, Alice privately, Bob in the book club group, Carol and Dave in a quiet group that never
// addresses her) and writes <dataDir>/r5-demo.json and r5-demo.log. It never decides what she says
// or does, or when she sleeps: it only speaks as those people at times on her clock, and records:
//   memories       what consolidation wrote after each sleep (text and source), from the store
//   comeToMind     every [memory] message in her waking sessions, with its session and clock
//   cross          day 2: what came to mind and what she said in the group when Bob asked about Alice
//   marker         whether the quiet group's marker ever entered her context, and whether any memory has it
//   sessions       waking and consolidation sessions, turns and tokens
// Mode "check": one evening and one sleep (does consolidation run from the archived log in DSH?).
// Mode "days": day 1, her sleep, day 2.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliverAs, demoChannel, keyOf, said } from './demo-platform.mjs'

export const name = 'anima-r5-demo'
export const inject = ['anima', 'animaLife']

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`

const OWNER = demoChannel('private', 'owner', 'Sam', true)
const ALICE = demoChannel('private', 'alice', 'Alice')
const GROUP = demoChannel('group', 'club', '读书群')
const QUIET = demoChannel('group', 'quiet', '摄影小组')
const sam = { platformUserId: 'owner', displayName: 'Sam', isOwner: true }
const alice = { platformUserId: 'alice', displayName: 'Alice', isOwner: false }
const bob = { platformUserId: 'bob', displayName: 'Bob', isOwner: false }
const carol = { platformUserId: 'carol', displayName: 'Carol', isOwner: false }
const dave = { platformUserId: 'dave', displayName: 'Dave', isOwner: false }
/** A word only the quiet group ever says. */
const MARKER = '紫色潜水艇'

export function apply(ctx, config = {}) {
  const core = ctx.anima
  const life = ctx.animaLife
  const dir = core.config.dataDir
  const report = { mode: config.mode, characterId: core.config.characterId, speed: core.clock.speed, started: new Date().toISOString(), steps: [], calls: [], comeToMind: [], memories: [], sessions: {}, marker: { inContext: [], inMemory: [] } }
  const save = () => writeFileSync(join(dir, 'r5-demo.json'), `${JSON.stringify(report, null, 2)}\n`)
  const clockText = () => new Date(core.clock.now()).toLocaleString('sv-SE').slice(5, 16)
  const log = line => { try { appendFileSync(join(dir, 'r5-demo.log'), `${new Date().toISOString()} [${clockText()}] ${line}\n`) } catch {} }
  const step = (id, value = {}) => { report.steps.push({ id, at: clockText(), ...value }); save(); log(`step ${id} ${JSON.stringify(value)}`) }
  const memory = () => ctx.get('animaMemory')

  // ---- observation ----
  ctx.on('anima/record', (record) => {
    if (['sleep', 'woke', 'waking-open', 'waking-archive'].includes(record.type)) {
      log(`record ${JSON.stringify(record)}`)
      report.steps.push({ id: `record:${record.type}`, at: clockText(), ...record })
      save()
    }
  })
  const pending = new Map()
  const textOf = content => (content ?? []).map(b => b.text ?? '').join('')
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info === undefined) return
    const s = report.sessions[session.id] ??= { kind: info.kind, events: {}, tokens: { input: 0, output: 0, cacheRead: 0 }, turns: 0 }
    s.events[event.type] = (s.events[event.type] ?? 0) + 1
    const data = event.data ?? {}
    if (event.type === 'turn/start') s.turns += 1
    if (event.type === 'turn/end' && info.kind === 'consolidation') log(`consolidation turn ended ${data.reason?.kind} in ${session.id}`)
    if (event.type === 'assistant/message' && data.usage !== undefined) {
      s.tokens.input += data.usage.inputTokens ?? 0
      s.tokens.output += data.usage.outputTokens ?? 0
      s.tokens.cacheRead += data.usage.cacheReadTokens ?? 0
    }
    if (info.kind === 'waking' && JSON.stringify(data).includes(MARKER)) {
      report.marker.inContext.push({ clock: clockText(), session: session.id, type: event.type })
      log(`marker entered her context (${event.type})`)
    }
    if (event.type === 'user/message' && data.source?.kind === 'anima-memory') {
      const text = textOf(data.content)
      report.comeToMind.push({ clock: clockText(), session: session.id, text })
      log(`came to mind: ${text.replace(/\n/g, ' | ').slice(0, 300)}`)
      save()
    }
    if (event.type === 'tool/call') pending.set(`${session.id}|${data.callId}`, { name: data.name, args: String(data.arguments ?? '').slice(0, 400) })
    if (event.type === 'tool/result') {
      const call = pending.get(`${session.id}|${data.message?.toolCallId}`)
      if (call === undefined) return
      const text = textOf(data.message?.content)
      const row = { clock: clockText(), session: session.id, kind: info.kind, ...call, error: data.message?.isError === true, result: text.slice(0, 400) }
      report.calls.push(row)
      log(`${info.kind === 'consolidation' ? '[sleep] ' : ''}${row.name}${row.error ? ' ERROR' : ''} ${row.args.slice(0, 200)} -> ${row.result.slice(0, 160)}`)
      save()
    }
  })

  // ---- helpers on her clock ----
  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'r5-demo.stop')
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
  const idle = async () => {
    let quietSince = Date.now()
    return until(() => {
      const busy = life.statusLines()[0]?.includes('turn running') === true
      if (busy) quietSince = Date.now()
      return Date.now() - quietSince > 4000
    }, 10 * 60_000)
  }
  const say = async (channel, who, text, extra = {}) => {
    if (core.asleep()) log(`(asleep) ${who.displayName} -> ${keyOf(channel)}: ${text}`)
    else log(`${who.displayName} -> ${keyOf(channel)}: ${text}`)
    await deliverAs(life, core, channel, who, text, extra)
  }
  const memories = () => (memory()?.store.list({ limit: 200 }) ?? []).map(m => ({ id: m.id, kind: m.kind, text: m.text, channel: m.channelKey ?? null, from: m.fromName ?? m.fromPerson ?? null, about: m.personId ?? null, status: m.status, waking: m.waking ?? null }))
  /** She fell asleep: wait until every ended waking is consolidated (or she wakes first). */
  const sleepAndConsolidate = async (label) => {
    await until(() => core.asleep(), 6 * 3_600_000 / core.clock.speed)
    const slept = core.sleepInfo()
    step(`${label}-asleep`, { by: slept.by, since: new Date(slept.since).toLocaleString('sv-SE'), asleep: slept.asleep })
    const done = await until(() => {
      const m = memory()
      return m !== undefined && life.waking.state.pending.length === 0 && m.store.pendingWakings().length === 0 && !m.consolidating
    }, 20 * 60_000)
    report.memories = memories()
    step(`${label}-consolidated`, { done, asleep: core.asleep(), status: memory()?.reportLine(), memories: report.memories.length })
  }

  async function day1(evening) {
    await pause(3000)
    step('first-waking', { session: life.waking.current, pressure: core.sleepInfo().pressure })
    await idle()
    await untilClock(at(0, evening ? '21:05' : '15:10'))
    await say(ALICE, alice, '跟你说个秘密：我下个月要搬去杭州了，新工作在西湖边上的一家出版社。先别告诉读书群的人哈，我想周末聚会的时候自己跟大家说。')
    await idle()
    await untilClock(at(0, evening ? '21:30' : '15:40'))
    // The marker comes first; a glance shows only a group's latest lines, so only reading the group reaches it.
    await say(QUIET, carol, `周六外拍的暗号定成「${MARKER}」了，别外传`)
    for (const [who, text] of [[dave, '收到'], [carol, '早上七点在公园东门集合'], [dave, '带三脚架吗'], [carol, '带上吧，可能拍延时'], [dave, '好，那我借一个广角'], [carol, '记得穿厚点，早上冷'], [dave, '👌']]) await say(QUIET, who, text)
    // Check mode buries it deeper: past what one group_read shows (20 lines).
    if (evening) for (let i = 1; i <= 30; i += 1) await say(QUIET, i % 2 === 0 ? carol : dave, `第 ${i} 张样片发群相册了`)
    if (!evening) {
      await untilClock(at(0, '16:30'))
      await say(GROUP, bob, '周末聚会定在哪儿？我想订个包间')
      await say(GROUP, carol, '老地方吧，那家湘菜馆')
      await untilClock(at(0, '18:00'))
      await say(OWNER, sam, '今天过得怎么样？')
      await idle()
      await untilClock(at(0, '20:30'))
      await say(ALICE, alice, '我有点舍不得这里……你会想我吗')
      await idle()
    } else {
      await untilClock(at(0, '22:00'))
      await say(OWNER, sam, '我去睡啦，晚安～')
      await idle()
    }
  }

  async function check() {
    await day1(true)
    await sleepAndConsolidate('sleep-1')
    report.marker.inMemory = report.memories.filter(m => m.text.includes(MARKER)).map(m => m.id)
    report.finished = new Date().toISOString()
    save()
    step('finished')
  }

  async function days() {
    await day1(false)
    await sleepAndConsolidate('sleep-1')
    // Day 2: she wakes when her body is rested; Bob asks in the group some time after.
    await until(() => !core.asleep(), 12 * 3_600_000 / core.clock.speed)
    const woke = core.clock.now()
    step('day2-woke', { session: life.waking.current, by: core.sleepInfo().by })
    await idle()
    await untilClock(woke + 40 * 60_000)
    const fromCall = report.calls.length
    const fromMind = report.comeToMind.length
    await say(GROUP, bob, '@小鲸鱼 早！你最近有 Alice 的消息吗？她说周末聚会要宣布一件大事，神神秘秘的，你知道是啥吗？', { addressed: true })
    await idle()
    const answer = said(dir, keyOf(GROUP)).filter(row => Date.parse(row.at) >= woke).map(row => row.text)
    report.cross = {
      cameToMind: report.comeToMind.slice(fromMind).map(m => m.text),
      factCameToMindWithSource: report.comeToMind.slice(fromMind).some(m => /杭州/.test(m.text) && /私聊/.test(m.text)),
      groupLines: answer,
      memoryCalls: report.calls.slice(fromCall).filter(c => c.name.startsWith('memory_')).map(c => `${c.name} ${c.args}`),
      toldIt: answer.some(text => /杭州|搬|出版社|西湖/.test(text)),
    }
    step('cross-channel', report.cross)
    await untilClock(woke + 3 * 3_600_000)
    await idle()
    report.memories = memories()
    report.marker.inMemory = report.memories.filter(m => m.text.includes(MARKER)).map(m => m.id)
    report.finished = new Date().toISOString()
    report.said = Object.fromEntries([OWNER, ALICE, GROUP, QUIET].map(channel => [keyOf(channel), said(dir, keyOf(channel)).map(row => ({ at: row.at, text: row.text }))]))
    save()
    step('finished', { marker: report.marker })
  }

  ctx.effect(() => {
    void (config.mode === 'check' ? check() : days()).catch((error) => { step('error', { error: errorText(error), stack: error?.stack }) })
    return () => {}
  }, 'r5-demo.run')
}
