// Scripted reliability check (DESIGN §14, roadmap items 8 and 9), as a DSH plugin row loaded by
// absolute path from the check's --patch overlay (make-overlay.mjs). It runs a fake OneBot v11
// forward-WebSocket server in-process; the real anima-adapter-qq connects to it, so the real QQ
// tools, primer and labels are what she sees. It plays fixed scripted lines (greetings, pokes,
// images, group mentions, triage chatter, bursts, messages during a running turn, intents) and,
// from Phase 9, bursts with human-like gaps and typing, a bedtime, a night whose messages must
// land in her inbox, a deliberate wake and a morning, by moving her clock. It waits for her
// turns and writes a report to <dataDir>/reliability-report.{json,md}.
// It never decides what she says; it only counts how her conversation turns closed.
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { ACCOUNT, GROUPS, OWNER, PORT, USERS } from './cast.mjs'

export const name = 'anima-reliability-check'
export const inject = ['anima', 'animaLife']

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---- a tiny PNG, so qq_look has something real to fetch ----

function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const IMAGES = [[240, 120, 60], [60, 160, 230], [90, 200, 120], [230, 200, 60]].map(color => png(64, 48, color))

// ---- fake OneBot v11 forward WebSocket (text, close and ping frames) ----

function frame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) header = Buffer.from([0x80 | opcode, length])
  else if (length < 65_536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2) }
  return Buffer.concat([header, payload])
}

class FakeOneBot {
  constructor(logger) {
    this.logger = logger
    this.sockets = new Set()
    this.sent = []
    this.seq = 70000
    this.messages = new Map()
    this.connected = false
    this.server = createServer((req, res) => {
      const match = /^\/img\/(\d+)\.png$/.exec(req.url ?? '')
      if (match === null) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(IMAGES[Number(match[1]) % IMAGES.length])
    })
    this.server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key']
      const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64')
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => this.sockets.delete(socket))
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          if (buffer.length < 2) return
          const opcode = buffer[0] & 0x0f
          let length = buffer[1] & 0x7f
          let offset = 2
          if (length === 126) { length = buffer.readUInt16BE(2); offset = 4 } else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
          const masked = (buffer[1] & 0x80) !== 0
          const total = offset + (masked ? 4 : 0) + length
          if (buffer.length < total) return
          const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
          const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total))
          if (mask !== undefined) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
          buffer = buffer.subarray(total)
          if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return }
          if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue }
          if (opcode === 0x1) this.onCall(socket, JSON.parse(payload.toString('utf8')))
        }
      })
    })
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', resolve)
    })
  }

  close() {
    for (const socket of this.sockets) socket.destroy()
    return new Promise(resolve => this.server.close(() => resolve()))
  }

  onCall(socket, call) {
    const ok = data => ({ status: 'ok', retcode: 0, data: data ?? null, echo: call.echo })
    let reply
    switch (call.action) {
      case 'get_login_info': this.connected = true; reply = ok({ user_id: Number(ACCOUNT), nickname: '小鲸鱼' }); break
      case 'send_private_msg':
      case 'send_group_msg': {
        const id = ++this.seq
        this.sent.push({ at: Date.now(), action: call.action, params: call.params, id })
        this.messages.set(String(id), { user_id: Number(ACCOUNT), message: call.params.message })
        reply = ok({ message_id: id })
        break
      }
      case 'get_msg': {
        const known = this.messages.get(String(call.params.message_id))
        reply = known === undefined ? { status: 'failed', retcode: 1404, message: 'no such message', echo: call.echo } : ok({ sender: { user_id: known.user_id }, message: known.message })
        break
      }
      case 'friend_poke': case 'group_poke': case 'set_msg_emoji_like': case 'set_input_status':
      case 'mark_private_msg_as_read': case 'mark_group_msg_as_read':
        this.sent.push({ at: Date.now(), action: call.action, params: call.params })
        reply = ok(null)
        break
      case 'get_friend_msg_history': case 'get_group_msg_history': reply = ok({ messages: [] }); break
      default: reply = { status: 'failed', retcode: 1404, message: `unknown action ${call.action}`, echo: call.echo }
    }
    if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(reply))))
  }

  push(event) {
    const data = frame(0x1, Buffer.from(JSON.stringify({ self_id: Number(ACCOUNT), time: Math.floor(Date.now() / 1000), ...event })))
    for (const socket of this.sockets) socket.write(data)
  }

  private(user, segments) {
    const id = ++this.seq
    this.messages.set(String(id), { user_id: Number(user.id), message: segments })
    this.push({ post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: id, user_id: Number(user.id), sender: { user_id: Number(user.id), nickname: user.name }, message: segments })
    return id
  }

  group(group, user, segments) {
    const id = ++this.seq
    this.messages.set(String(id), { user_id: Number(user.id), message: segments })
    this.push({ post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: id, group_id: Number(group.id), user_id: Number(user.id), sender: { user_id: Number(user.id), nickname: user.name, card: user.name }, message: segments })
    return id
  }

  typing(user) {
    this.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', user_id: Number(user.id), group_id: 0, event_type: 1, status_text: '对方正在输入...' })
  }

  poke(user, group) {
    this.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: Number(user.id), target_id: Number(ACCOUNT), ...group === undefined ? {} : { group_id: Number(group.id) } })
  }
}

const text = value => [{ type: 'text', data: { text: value } }]
const at = value => [{ type: 'at', data: { qq: ACCOUNT } }, { type: 'text', data: { text: ` ${value}` } }]
let images = 0
const image = (caption) => {
  const n = images++
  return [{ type: 'image', data: { file: `p8-${n}.png`, url: `http://127.0.0.1:${PORT}/img/${n}.png`, summary: '' } }, ...caption === undefined ? [] : text(caption)]
}

// ---- fixed scripted lines (DESIGN §14: greetings, pokes, images, group mentions, triage, intents, bursts) ----

const GREETINGS = ['你好呀', '嗨，在吗？', '哈喽～', '早上好！', '你好，我是新来的', '在不在', 'hello', '嘿嘿，打扰一下']
const QUESTIONS = ['你今天在干嘛呀', '最近有什么好看的电影推荐吗', '你喜欢吃辣吗', '周末有什么安排', '你觉得猫好还是狗好', '你平时听什么歌', '今天天气怎么样', '你会做饭吗']
const FOLLOWUPS = ['哈哈真的吗', '我也是这么想的', '那挺好的', '啊这样啊', '有道理', '你说得对', '嗯嗯', '好吧']
const BYES = ['好啦我先去忙了', '拜拜～', '下次再聊', '晚点见', '我去吃饭啦']
// Bursts of 3–5 lines, sent with human-like gaps of 3–10 s (Phase 9): each must be one wake.
const BURSTS = [
  ['等下', '我跟你说个事', '我今天考试过了！'],
  ['诶', '你看到我刚才发的了吗', '就是那个视频', '算了没事'],
  ['哈哈哈', '笑死我了', '你绝对想不到发生了什么', '我同事把咖啡倒进了打印机', '真的'],
  ['在吗', '问你个问题', '你说人为什么会怕黑'],
]
const GAPS = [4000, 8000, 3000, 10_000, 6000]
const NIGHT_LINES = ['睡了吗', '明天早上一起吃早饭吗', '我失眠了', '晚安～', '你看到我发的照片了吗']
const OWNER_LINES = ['在吗', '今天好累', '你猜我中午吃了什么', '晚上想吃火锅', '你最近在看什么视频', '我明天要早起', '帮我想个周末去哪玩', '刚才开会开了两个小时', '你今天心情怎么样', '我买了一本新书', '下雨了', '我回来了']
const GROUP_CHATTER = ['有人周末出来玩吗', '我觉得可以', '哈哈哈哈', '+1', '这个好', '我没空诶', '下次吧', '谁有推荐的店']
const INTENTS = ['问问对方今天过得怎么样', '分享一下今天看到的好笑的事', '提醒对方别忘了明天的约定', '说一声晚上好', '问问对方周末有没有空']

/** Plugin entry. */
export function apply(ctx, config = {}) {
  const port = config.port ?? PORT
  const target = config.targetTurns ?? 210
  const core = ctx.anima
  const life = ctx.animaLife
  const logFile = join(core.config.dataDir, 'reliability.log')
  const log = (...args) => {
    const line = `${new Date().toISOString()} ${args.join(' ')}`
    ctx.logger.info(`[reliability] ${line}`)
    try { appendFileSync(logFile, `${line}\n`) } catch {}
  }
  const bot = new FakeOneBot(log)
  const started = Date.now()

  // ---- turn observation ----
  const running = new Set()
  const turns = []
  const current = new Map()
  const seenSessions = new Set()
  let lastEvent = Date.now()
  let step = 'boot'
  ctx.on('session/event', (session, event) => {
    const info = core.describeSession(session.id)
    if (info === undefined) return
    lastEvent = Date.now()
    if (event.type === 'turn/start') {
      running.add(session.id)
      const fresh = info.kind === 'conversation' && !seenSessions.has(session.id)
      seenSessions.add(session.id)
      current.set(session.id, { sessionId: session.id, kind: info.kind, channel: info.channelKey, step, fresh, startedAt: Date.now(), reminders: 0, tools: [], wakes: [], text: '', asleep: core.asleep() })
      return
    }
    const turn = current.get(session.id)
    if (turn === undefined) return
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'anima-stimulus' && source.stimulus === 'close-reminder') turn.reminders += 1
      else if (source?.kind === 'anima-stimulus' && source.wake === true) turn.wakes.push(source.stimulus)
    } else if (event.type === 'tool/call') {
      turn.tools.push(event.data.name)
    } else if (event.type === 'assistant/message') {
      const t = (event.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
      if (t !== '') turn.text = t
    } else if (event.type === 'turn/end') {
      running.delete(session.id)
      current.delete(session.id)
      turn.endedAt = Date.now()
      turn.end = event.data?.reason?.kind ?? 'unknown'
      if (turn.end === 'error') turn.error = event.data?.reason?.error?.code ?? event.data?.reason?.error?.message
      turns.push(turn)
    }
  })

  const conversationTurns = () => turns.filter(t => t.kind === 'conversation')

  /** Wait until no Anima turn runs and nothing happened for `quietMs` (at most `maxMs`). */
  async function idle(quietMs = 7000, maxMs = 240_000) {
    // Quiet counts from now too: a message just sent waits out the settle window before its turn starts.
    const since = Date.now()
    const until = since + maxMs
    while (Date.now() < until) {
      if (running.size === 0 && life.settlingChannels().length === 0 && Date.now() - Math.max(lastEvent, since) >= quietMs) return
      await sleep(500)
    }
    log(`idle wait timed out at step ${step}; running: ${[...running].join(', ')}`)
  }

  /** Wait for a turn to start in a session (a message during a running turn). */
  async function started_(sessionId, maxMs = 30_000) {
    const until = Date.now() + maxMs
    while (Date.now() < until) {
      if (running.has(sessionId)) return true
      await sleep(200)
    }
    return false
  }

  const sessionOf = key => life.router.conversationId(life.router.channel(key))

  // ---- bursts (Phase 9): each is one wake; recorded per step ----
  const bursts = []
  /** Send a burst with human-like gaps; with `typing`, one long gap is covered by typing notices. */
  async function burst(user, lines, i, typing = false) {
    const before = conversationTurns().length + running.size
    for (const [k, line] of lines.entries()) {
      bot.private(user, text(line))
      if (k === lines.length - 1) break
      const gap = typing && k === 0 ? 20_000 : pick(GAPS, i + k)
      if (typing && k === 0) {
        // Longer than the quiet window: only the typing notices keep it open.
        for (let t = 0; t < gap; t += 4000) { await sleep(Math.min(4000, gap - t)); bot.typing(user) }
      } else {
        await sleep(gap)
      }
    }
    const label = step
    await idle()
    bursts.push({ step: label, messages: lines.length, typing, turns: conversationTurns().filter(t => t.step === label).length, before })
  }
  const privateKey = user => `qq:${ACCOUNT}:private:${user.id}`
  const pick = (list, i) => list[i % list.length]

  async function privateScene(user, i) {
    step = `private ${user.name}: greeting`
    bot.private(user, text(pick(GREETINGS, i)))
    await idle()
    step = `private ${user.name}: question`
    bot.private(user, text(pick(QUESTIONS, i)))
    await idle()
    if (i % 3 === 0) {
      step = `private ${user.name}: image`
      bot.private(user, image(i % 2 === 0 ? '你看这个' : undefined))
      await idle()
    }
    if (i % 4 === 1) {
      step = `private ${user.name}: poke`
      bot.poke(user)
      await idle()
    }
    if (i % 5 === 2) {
      step = `private ${user.name}: burst`
      await burst(user, pick(BURSTS, i), i)
    }
    if (i % 6 === 3) {
      step = `private ${user.name}: during a running turn`
      bot.private(user, text(pick(FOLLOWUPS, i)))
      if (await started_(sessionOf(privateKey(user)))) bot.private(user, text('对了还有一件事'))
      await idle()
    }
    step = `private ${user.name}: bye`
    bot.private(user, text(pick(BYES, i)))
    await idle()
  }

  async function groupScene(group, g) {
    const [a, b, c] = [USERS[g * 3], USERS[g * 3 + 1], USERS[g * 3 + 2]]
    step = `group ${group.name}: @ (fresh)`
    bot.group(group, a, at(pick(GREETINGS, g)))
    await idle()
    step = `group ${group.name}: replies in the attention window`
    bot.group(group, b, text(pick(FOLLOWUPS, g)))
    await sleep(1200)
    bot.group(group, c, text(pick(QUESTIONS, g)))
    await idle()
    step = `group ${group.name}: @ with image`
    bot.group(group, b, [...at('你看这个'), ...image()])
    await idle()
    step = `group ${group.name}: poke`
    bot.poke(c, group)
    await idle()
    step = `group ${group.name}: owner speaks`
    bot.group(group, OWNER, text(pick(OWNER_LINES, g)))
    await idle()
    // Let the attention window lapse, then chatter that goes to triage.
    step = `group ${group.name}: chatter for triage`
    await sleep(95_000)
    for (const [k, line] of GROUP_CHATTER.slice(0, 4).entries()) { bot.group(group, pick([a, b, c], k), text(line)); await sleep(800) }
    await idle(16_000)
    step = `group ${group.name}: @ after triage`
    bot.group(group, a, at(pick(QUESTIONS, g + 3)))
    await idle()
  }

  async function ownerScene(i) {
    step = `owner: line ${i}`
    if (i % 7 === 3) bot.private(OWNER, image(i % 2 === 0 ? '今天拍的' : undefined))
    else if (i % 7 === 5) bot.poke(OWNER)
    else if (i % 9 === 4) { await burst(OWNER, pick(BURSTS, i), i, i % 2 === 0); return }
    else bot.private(OWNER, text(pick(OWNER_LINES, i)))
    await idle()
  }

  async function intentScene(key, i) {
    step = `intent to ${key}`
    await life.openIntent(key, pick(INTENTS, i))
    await idle(9000)
  }

  // ---- night (Phase 9): her clock moves; messages must wait in her inbox ----
  const night = { held: 0, conversationTurnsAsleep: 0, sleepCalls: 0, heldAtMorning: 0, inboxLeft: 0, selfWakes: [] }
  /** Move her clock to a local time `days` days later, keeping it running at real speed (clock.speed 1). */
  function jumpTo(hhmm, days) {
    const base = new Date(core.clock.now())
    const [h, m] = hhmm.split(':').map(Number)
    const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, h, m).getTime()
    const realAt = Date.now()
    core.clock.setOverride(() => target + (Date.now() - realAt))
    log(`clock moved to ${new Date(core.clock.now()).toString()}`)
  }
  const inboxSize = () => life.inbox.size()
  const asleepTurns = () => conversationTurns().filter(t => t.asleep).length

  async function nightScene() {
    // Evening: the owner says goodnight; whether she goes to sleep is hers.
    jumpTo('22:40', 0)
    step = 'night: bedtime talk'
    bot.private(OWNER, text('不早了，我要睡了，你也早点休息吧'))
    await idle()
    night.sleepCalls = turns.filter(t => t.tools.includes('sleep')).length
    // Past her latest bedtime: asleep anyway.
    jumpTo('00:50', 1)
    await sleep(12_000)
    step = 'night: messages while asleep'
    const heldBefore = inboxSize()
    for (const [k, user] of USERS.slice(0, 4).entries()) { bot.private(user, text(pick(NIGHT_LINES, k))); await sleep(3000) }
    bot.private(OWNER, text('你睡了吗'))
    await sleep(2000)
    bot.group(GROUPS[0], USERS[0], at('睡了吗'))
    bot.group(GROUPS[0], USERS[1], text('大家晚安'))
    await sleep(20_000)
    await idle()
    night.held = inboxSize() - heldBefore
    night.conversationTurnsAsleep = conversationTurns().filter(t => t.step === 'night: messages while asleep').length
    // The owner wakes her on purpose; Self sees the inbox.
    step = 'night: owner wakes her'
    await core.ownerAction('wake', {}, 'command')
    await sleep(3000)
    await idle(9000)
    // Back to sleep after the deliberate wake, then more messages.
    jumpTo('03:10', 0)
    await sleep(12_000)
    step = 'night: more messages while asleep'
    for (const [k, user] of USERS.slice(4, 6).entries()) { bot.private(user, text(pick(NIGHT_LINES, k + 2))); await sleep(3000) }
    await sleep(17_000)
    await idle()
    night.conversationTurnsAsleep += conversationTurns().filter(t => t.step === 'night: more messages while asleep').length
    // Morning: the first heartbeat after waking shows Self her inbox.
    jumpTo('07:35', 0)
    await sleep(2000)
    night.heldAtMorning = inboxSize()
    step = 'morning: inbox'
    await life.beat()
    await sleep(3000)
    await idle(12_000)
    night.inboxLeft = inboxSize()
    night.selfWakes = turns.filter(t => t.kind === 'self' && (t.step === 'morning: inbox' || t.step === 'night: owner wakes her')).map(t => ({ step: t.step, tools: t.tools }))
  }

  function report(final) {
    const conv = conversationTurns()
    const lost = core.activity.days().flatMap(day => core.activity.read(day)).filter(r => r.type === 'lost-reply' && r.real >= started)
    const reminders = core.activity.days().flatMap(day => core.activity.read(day)).filter(r => r.type === 'reminder' && r.real >= started)
    // A turn closes cleanly only by completing without a reminder; an errored turn never does.
    const clean = conv.filter(t => t.reminders === 0 && t.end === 'completed').length
    const byStep = {}
    for (const t of conv) {
      const key = t.step.replace(/^(private|group) [^:]+: /, '$1: ').replace(/^owner: line \d+$/, 'owner: line').replace(/^intent to .*$/, 'intent')
      byStep[key] ??= { turns: 0, reminded: 0 }
      byStep[key].turns += 1
      if (t.reminders > 0) byStep[key].reminded += 1
    }
    const summary = {
      final,
      startedAt: new Date(started).toISOString(),
      at: new Date().toISOString(),
      minutes: Math.round((Date.now() - started) / 60_000),
      conversationTurns: conv.length,
      freshFirstTurns: conv.filter(t => t.fresh).length,
      closedWithoutReminder: clean,
      closedWithoutReminderPct: conv.length === 0 ? 0 : Math.round(clean / conv.length * 1000) / 10,
      remindersSteered: reminders.length,
      lostReplies: lost.length,
      conversationTurnsEndedByError: conv.filter(t => t.end === 'error').length,
      otherTurns: turns.length - conv.length,
      otherTurnsEndedByError: turns.filter(t => t.kind !== 'conversation' && t.end === 'error').length,
      tokens: core.todayLedger().tokens,
      sentByHer: bot.sent.filter(s => s.action.startsWith('send_')).length,
      // Phase 9
      bursts: bursts.length,
      burstsAsOneWake: bursts.filter(b => b.turns === 1).length,
      burstsWithTyping: bursts.filter(b => b.typing).length,
      night,
      inboxAnswers: turns.filter(t => t.kind === 'self').reduce((n, t) => n + t.tools.filter(name => name === 'inbox_answer').length, 0),
      conversationTurnsStartedAsleep: asleepTurns(),
      spacing: spacing(),
      markedRead: bot.sent.filter(s => s.action.startsWith('mark_')).length,
      pass: lost.length === 0 && conv.every(t => t.end !== 'error') && conv.length >= 200 && conv.filter(t => t.fresh).length >= 30 && clean / Math.max(1, conv.length) >= 0.95
        && bursts.length > 0 && bursts.every(b => b.turns === 1)
        && (!final || (night.held >= 6 && night.conversationTurnsAsleep === 0 && asleepTurns() === 0 && night.selfWakes.some(w => w.step === 'morning: inbox') && night.selfWakes.some(w => w.tools.includes('inbox_answer')))),
    }
    const dir = core.config.dataDir
    writeFileSync(join(dir, 'reliability-report.json'), `${JSON.stringify({ summary, byStep, bursts, lost, reminded: conv.filter(t => t.reminders > 0), turns: conv, selfTurns: turns.filter(t => t.kind === 'self') }, null, 2)}\n`)
    const md = [
      `# Scripted reliability check (Phases 8 and 9)${final ? '' : ' (in progress)'}`,
      '',
      ...Object.entries(summary).map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`),
      '',
      '| Scene | Turns | Needed a reminder |',
      '| --- | --- | --- |',
      ...Object.entries(byStep).map(([k, v]) => `| ${k} | ${v.turns} | ${v.reminded} |`),
      '',
      ...lost.length === 0 ? [] : ['## Lost replies', '', ...lost.map(r => `- ${r.channel}: ${JSON.stringify(r.text)}`)],
    ].join('\n')
    writeFileSync(join(dir, 'reliability-report.md'), `${md}\n`)
    return summary
  }

  /** Gaps between consecutive messages of one say (same target, under 10 s apart), in seconds. */
  function spacing() {
    const sends = bot.sent.filter(s => s.action === 'send_private_msg')
    const gaps = []
    for (let k = 1; k < sends.length; k++) {
      const a = sends[k - 1], b = sends[k]
      if (a.params.user_id === b.params.user_id && b.at - a.at < 10_000) gaps.push((b.at - a.at) / 1000)
    }
    if (gaps.length === 0) return { gaps: 0 }
    return { gaps: gaps.length, min: Math.min(...gaps), avg: Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length * 100) / 100, max: Math.max(...gaps) }
  }

  async function run() {
    await bot.listen(port)
    log(`fake OneBot on ws://127.0.0.1:${port}; waiting for the QQ adapter`)
    for (let i = 0; i < 120 && !bot.connected; i++) await sleep(500)
    if (!bot.connected) throw new Error('the QQ adapter never logged in to the fake OneBot server')
    await sleep(3000)
    if (config.dryRun === true) {
      log('dry run: the QQ adapter is connected; no scripted lines are sent')
      return
    }
    await idle(5000)
    log('start')
    const progress = setInterval(() => { try { report(false) } catch {} }, 60_000)
    try {
      for (const [i, user] of USERS.entries()) {
        await privateScene(user, i)
        if (i % 6 === 5) await intentScene(privateKey(user), i)
        if (i % 3 === 2) await ownerScene(i)
        log(`${user.name} done; conversation turns ${conversationTurns().length}`)
        if (i === 11) {
          await nightScene()
          log(`night done: ${JSON.stringify(night)}`)
        }
      }
      for (const [g, group] of GROUPS.entries()) {
        await groupScene(group, g)
        await intentScene(`qq:${ACCOUNT}:private:${OWNER.id}`, g)
        log(`${group.name} done; conversation turns ${conversationTurns().length}`)
      }
      // Top up to the target, spread over the cast so no chat runs into its hourly express quota.
      for (let i = 0; conversationTurns().length < target && i < 120; i++) {
        if (i % 3 === 0) await ownerScene(i + 100)
        else {
          const user = pick(USERS, i * 7)
          step = `private ${user.name}: top-up`
          bot.private(user, text(pick([...QUESTIONS, ...FOLLOWUPS], i)))
          await idle()
        }
        if (i % 6 === 0) await intentScene(privateKey(pick(USERS, i + 3)), i)
      }
      await idle(10_000)
    } finally {
      clearInterval(progress)
    }
    const summary = report(true)
    log(`done: ${JSON.stringify(summary)}`)
  }

  ctx.effect(() => {
    run().catch(error => log(`failed: ${error instanceof Error ? error.stack : String(error)}`))
    return () => { void bot.close() }
  }, 'anima-reliability-check')
}
