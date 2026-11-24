/**
 * The `animaMemory` service (docs/design/memory.md): her long-term memory with
 * the source of every memory, what comes to mind at the steps of her waking
 * session, the `memory_*` behaviors, consolidation in sleep from the archived
 * log of each ended waking, and daily decay.
 * @module @anima/memory/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, channelKey, describeGoal, formatLocal, type ChannelRef } from '@anima/core'
import type {} from '@anima/core'
import { whereOf, type PublishedChannel, type SourcePerson } from '@anima/life'
import type {} from '@anima/life'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import type { MemoryKind } from './decay.ts'
import { buildBlock, cueText, historyLine, memoryLine, type ChannelLookup } from './inject.ts'
import { cutPieces, pieceFacts, renderLog, type Piece } from './log.ts'
import { chatPerson, personOf } from './source.ts'
import { MemoryStore, type Memory } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaMemory: AnimaMemory
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** What came to mind at a step of her waking session. */
    'anima-memory': { kind: 'anima-memory' } & ContextFormed
  }
}

const TICK_MS = 60_000
const DAY = 24 * 3_600_000
/** Item of the `shown` table: the waking cues of a waking session came. */
const WAKING_ITEM = 'waking'

/** A consolidation turn in progress: one piece of one ended waking. */
interface Run {
  readonly id: string
  readonly waking: string
  /** The consolidation session of that waking. */
  readonly sessionId: string
  readonly piece: Piece
  /** Channel keys in the piece: a memory's source must be one of them. */
  readonly channels: ReadonlySet<string>
  /** People in the piece, person id → name. */
  readonly people: ReadonlyMap<string, string>
  readonly startedReal: number
  /** DSH turn number, once it started. */
  turn?: number
}

interface Source { kind?: string; stimulus?: string; channel?: string; people?: SourcePerson[] }

function textOf(message: UserMessage): string {
  return message.content.map(block => (block as { text?: string }).text ?? '').join('\n')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Anima memory service. */
export class AnimaMemory extends Service {
  static inject = ['anima', 'animaLife', 'tools']

  /** The store. */
  readonly store: MemoryStore
  private run: Run | undefined
  private runSeq = 0
  /** A consolidation step is being prepared (reading a log). */
  private starting = false
  /** Consolidation could not go on (a failed read, a failed or stuck turn): it waits for her next sleep. */
  private stalled = false

  /**
   * @param ctx - root context.
   * @param config - resolved memory config.
   */
  constructor(ctx: Context, readonly config: Readonly<Config>) {
    super(ctx, 'animaMemory')
    const core = ctx.anima
    this.store = new MemoryStore(join(core.config.dataDir, 'memory.db'))
    ctx.effect(() => () => this.store.close(), 'animaMemory.store')

    // Consolidation is part of her sleep: an ended waking is sorted once it is archived, while she sleeps.
    ctx.on('anima/waking-archived', ({ sessionId }) => {
      this.store.addWaking(sessionId, core.clock.now())
      this.kick()
    })
    ctx.on('anima/sleep', () => {
      this.stalled = false
      this.kick()
    })
    ctx.on('anima/wake', () => this.stopRun('she woke'))
    ctx.on('agent/pre-step', async (payload, next) => this.preStep(payload, next))
    ctx.on('session/event', (session, event) => this.onSessionEvent(session.id, event))

    this.registerBehaviors()

    ctx.animaLife.addReportLine(() => [this.reportLine()])
    core.addStatus(() => this.statusLines())

    ctx.effect(() => {
      const timer = setInterval(() => this.tick(), TICK_MS)
      // Asleep at load (a restart in her sleep): what is pending goes on.
      this.kick()
      return () => clearInterval(timer)
    }, 'animaMemory.tick')
  }

  private readonly channelLookup: ChannelLookup = key => this.ctx.animaLife.channel(key)

  // ---- coming to mind ----

  private async preStep(
    payload: { agent: { id: string }; messages: UserMessage[]; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    const sessionId = payload.agent.id
    if (this.ctx.anima.describeSession(sessionId)?.kind !== 'waking') return decision
    const message = await this.comesToMind(sessionId, decision.messages)
    if (message === undefined) return decision
    return { ...decision, messages: [...decision.messages, message] }
  }

  /**
   * What comes to mind with the messages of one step: at the first step of a
   * waking, her open goals, the latest episodes and the people in her inbox;
   * on arrivals, the people and channels that wrote and full-text hits on
   * what arrived, plus, at first contact in this waking, the chat's last
   * lines from before she woke. Nothing shown in this waking comes again.
   * @returns the logged `[memory]` message, or undefined when nothing comes to mind.
   */
  async comesToMind(sessionId: string, messages: readonly UserMessage[]): Promise<UserMessage | undefined> {
    const core = this.ctx.anima
    const life = this.ctx.animaLife
    const persons = this.config.persons
    const arrivals = messages.filter(message => message.source?.kind !== 'anima-memory')
    const shown = this.store.shownIn(sessionId, [WAKING_ITEM])
    const waking = !shown.has(WAKING_ITEM)
    if (arrivals.length === 0 && !waking) return undefined

    const people = new Set<string>()
    const channels = new Set<string>()
    for (const message of arrivals) {
      const source = message.source as Source | undefined
      if (source?.channel !== undefined) channels.add(source.channel)
      for (const person of source?.people ?? []) people.add(personOf(person.platform, person.userId, person.owner === true, persons))
    }
    const arrived = arrivals.map(textOf).join('\n')
    const extra: string[] = []
    if (waking) {
      for (const entry of life.inbox.entries()) {
        for (const held of entry.messages) people.add(personOf(entry.channel.platform, held.sender.platformUserId, held.sender.isOwner, persons))
      }
      const goals = core.goals.open()
      if (goals.length > 0) extra.push('你还没了结的目标：', ...goals.map(goal => `- ${describeGoal(goal)}`))
    }
    // First contact of this waking with a chat: where they left off, from the platform's history.
    const contacts = this.config.recall.firstContactLines > 0 ? [...channels] : []
    const already = this.store.shownIn(sessionId, contacts.map(key => `c:${key}`))
    const fresh = contacts.filter(key => !already.has(`c:${key}`))
    const woke = core.sleepInfo().since
    for (const key of fresh) {
      const lines = await life.history(key, { count: this.config.recall.firstContactLines * 2 }).catch((error: unknown) => {
        this.ctx.logger.warn(`anima-memory: history of ${key}: ${errorText(error)}`)
        return undefined
      })
      const before = (lines ?? []).filter(line => line.ts < woke && !arrived.includes(line.text)).slice(-this.config.recall.firstContactLines)
      const channel = life.channel(key)
      if (before.length > 0 && channel !== undefined) extra.push(`${whereOf(channel)} 你醒来之前，这里最后几句：`, ...before.map(historyLine))
    }

    const block = buildBlock({
      store: this.store,
      cues: { people: [...people], channels: [...channels], query: arrivals.map(message => cueText(textOf(message))).join('\n'), latest: waking ? this.config.recall.wakingEpisodes : 0 },
      channelEpisodes: this.config.recall.channelEpisodes,
      exclude: this.store.shownAll(sessionId),
      extra,
      channel: this.channelLookup,
      tokenBudget: this.config.inject.tokenBudget,
      maxItems: this.config.inject.maxItems,
    })
    this.store.markShown(sessionId, [...waking ? [WAKING_ITEM] : [], ...fresh.map(key => `c:${key}`), ...block?.ids ?? []])
    if (block === undefined) return undefined
    this.store.touch(block.ids, core.clock.now())
    return createUserMessage({
      content: [{ type: 'text', text: block.text }],
      source: { kind: 'anima-memory', form: 'recall' },
    })
  }

  // ---- consolidation in sleep ----

  /** Whether a consolidation turn is in progress. */
  get consolidating(): boolean {
    return this.run !== undefined
  }

  private kick(): void {
    this.consolidateNext().catch((error: unknown) => {
      this.stalled = true
      this.ctx.logger.warn(`anima-memory: consolidation failed: ${errorText(error)}`)
    })
  }

  /**
   * While she sleeps, start the next piece of the oldest ended waking not yet
   * consolidated: read its archived log, cut what is left into pieces, and
   * hand the first to its consolidation session on the consolidation model.
   * @returns whether a piece was handed over.
   */
  async consolidateNext(): Promise<boolean> {
    const core = this.ctx.anima
    const life = this.ctx.animaLife
    if (this.run !== undefined || this.starting || this.stalled || !core.asleep()) return false
    this.starting = true
    try {
      for (const waking of this.store.pendingWakings()) {
        let events
        try {
          events = await life.readLog(waking.sessionId)
        } catch (error: unknown) {
          this.stalled = true
          this.ctx.logger.warn(`anima-memory: cannot read waking ${waking.sessionId}: ${errorText(error)}; tried again at her next sleep.`)
          return false
        }
        const lines = renderLog(events.filter(event => event.seq > waking.upto), { resultChars: this.config.consolidation.resultChars })
        const pieces = cutPieces(lines, this.config.consolidation.maxInputTokens)
        const piece = pieces[0]
        if (piece === undefined) {
          this.store.finishWaking(waking.sessionId)
          continue
        }
        if (!core.asleep()) return false
        const facts = pieceFacts(piece)
        const people = new Map(facts.people.map(person => [personOf(person.platform, person.userId, person.owner === true, this.config.persons), person.name] as const))
        const now = core.clock.now()
        const run: Run = {
          id: `r${now.toString(36)}-${++this.runSeq}`, waking: waking.sessionId, sessionId: life.consolidationId(waking.sessionId),
          piece, channels: new Set(facts.channels), people, startedReal: Date.now(),
        }
        // Mark the run before delivery: its turn may end before deliver() resolves.
        this.run = run
        try {
          await life.deliver({ type: 'consolidate', waking: waking.sessionId, text: this.pieceText(run, pieces.length), run: run.id, ts: now }, { model: this.config.consolidation.model })
        } catch (error) {
          if (this.run === run) this.run = undefined
          throw error
        }
        return true
      }
      return false
    } finally {
      this.starting = false
    }
  }

  private onSessionEvent(sessionId: string, event: { type: string; data?: unknown }): void {
    const run = this.run
    if (run === undefined || sessionId !== run.sessionId) return
    const data = (event.data ?? {}) as { turn?: number; reason?: { kind?: string } }
    if (event.type === 'turn/start') {
      if (run.turn === undefined && data.turn !== undefined) run.turn = data.turn
      return
    }
    if (event.type !== 'turn/end') return
    if (run.turn !== undefined && data.turn !== undefined && data.turn !== run.turn) return
    this.run = undefined
    if (data.reason === undefined || data.reason.kind === 'completed') {
      this.store.advanceWaking(run.waking, run.piece.to)
      this.store.setMeta('lastConsolidatedAt', String(this.ctx.anima.clock.now()))
      this.kick()
    } else {
      // Cut short: the piece waits for her next sleep.
      this.stalled = true
      this.ctx.logger.warn(`anima-memory: consolidation turn ended ${data.reason.kind ?? 'early'}; the piece is retried at her next sleep.`)
    }
  }

  /** Stop the running consolidation turn (she woke, or it is stuck); its piece is retried at her next sleep. */
  private stopRun(why: string): void {
    const run = this.run
    if (run === undefined) return
    this.run = undefined
    this.ctx.animaLife.stopConsolidation(run.sessionId).catch((error: unknown) => this.ctx.logger.warn(`anima-memory: stopping consolidation (${why}): ${errorText(error)}`))
  }

  private pieceText(run: Run, left: number): string {
    const life = this.ctx.animaLife
    const people = [...run.people].map(([id, name]) => `${name} [${id}]`)
    const places = [...run.channels].map(key => {
      const channel = life.channel(key)
      return channel === undefined ? key : whereOf(channel)
    })
    const related: Memory[] = []
    for (const id of run.people.keys()) related.push(...this.store.about(id, 4))
    for (const key of run.channels) related.push(...this.store.recentEpisodes(key, 3))
    const known = [...new Map(related.map(memory => [memory.id, memory])).values()].slice(0, this.config.inject.maxItems)
    return [
      `这是你上一次醒着时的一段经历（这次醒着的经历还剩 ${left} 段，这是其中最早的一段）。`,
      `在场的人：${people.length === 0 ? '没有' : people.join('、')}`,
      `出现的地方：${places.length === 0 ? '没有' : places.join('、')}`,
      `你已经有的相关记忆：${known.length === 0 ? '没有' : ''}`,
      ...known.map(memory => memoryLine(memory, this.channelLookup)),
      '经过：',
      ...run.piece.lines.map(line => line.text),
    ].join('\n')
  }

  /** Periodic work: give up a stuck consolidation turn, decay once a day. */
  tick(): void {
    const run = this.run
    if (run !== undefined && Date.now() - run.startedReal > this.config.consolidation.timeoutSeconds * 1000) {
      this.ctx.logger.warn(`anima-memory: consolidation turn ${run.id} did not finish in ${this.config.consolidation.timeoutSeconds} s; its piece is retried at her next sleep.`)
      this.stalled = true
      this.stopRun('timeout')
    }
    this.decayIfDue()
  }

  /** Apply decay for every her-day passed since the last run. */
  decayIfDue(now = this.ctx.anima.clock.now()): void {
    const day = this.ctx.anima.dayKey(now)
    const last = this.store.meta('lastDecayDay')
    if (last === day) return
    this.store.setMeta('lastDecayDay', day)
    if (last === undefined) return
    const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / DAY)
    if (days > 0) this.store.decay(days, this.config.decay, now)
  }

  // ---- behaviors ----

  /** A person named in a piece or chat: by person id, platform user id or name; otherwise the name as given. */
  private resolvePerson(named: string | undefined, people: ReadonlyMap<string, string>): { id: string; name: string } | undefined {
    if (named === undefined || named.trim() === '') return undefined
    const wanted = named.trim()
    const lower = wanted.toLowerCase()
    for (const [id, name] of people) {
      if (id.toLowerCase() === lower || id.split(':').at(-1)?.toLowerCase() === lower || name.toLowerCase() === lower) return { id, name }
    }
    return { id: wanted, name: wanted }
  }

  /** The person of a private chat, with the chat's name. */
  private chatPeople(channel: PublishedChannel | undefined): Map<string, string> {
    if (channel === undefined) return new Map()
    const person = chatPerson(channel, channel.isOwner === true, this.config.persons)
    return person === undefined ? new Map() : new Map([[person, channel.display.replace(/\s*\([^)]*\)$/, '')]])
  }

  private registerBehaviors(): void {
    const core = this.ctx.anima
    const life = this.ctx.animaLife
    const memoriesResult = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { lines: { type: 'array' as const, items: { type: 'string' as const }, required: true as const, description: 'One line per memory.' } },
      },
      render: (_args: unknown, value: { lines: string[] }) => [{ type: 'text' as const, text: value.lines.length === 0 ? '什么也想不起来。' : value.lines.join('\n') }],
    }
    const lineResult = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { line: { type: 'string' as const, required: true as const, description: 'What happened.' } },
      },
      render: (_args: unknown, value: { line: string }) => [{ type: 'text' as const, text: value.line }],
    }
    const importanceParam = { type: 'number' as const, description: 'How much it matters, 0 to 1 (default 0.3). Important memories fade slower.' }
    const sourceOf = (memory: Memory) => memoryLine(memory, this.channelLookup).replace(/^- /, '')

    core.registerBehavior(defineTool({
      name: 'memory_recall',
      description: 'Try to remember: search your memory. Each memory says where you learned it.',
      parameters: {
        query: { type: 'string', required: true, description: 'Words to look for: names, topics, places.' },
        archive: { type: 'boolean', description: 'Also search faded, archived memories.' },
      },
      output: memoriesResult,
      execute: async (args) => {
        const found = this.store.recall(args.query, { archive: args.archive === true, limit: 8 })
        this.store.touch(found.map(memory => memory.id), core.clock.now())
        return { lines: found.map(memory => memoryLine(memory, this.channelLookup)) }
      },
    }), { effect: 'observe', sessions: ['waking'] })

    core.registerBehavior(defineTool({
      name: 'memory_remember',
      description: 'Keep something in memory now: a fact about someone, something that happened, a note to yourself.',
      parameters: {
        text: { type: 'string', required: true, description: 'What to remember, as a self-contained sentence (name people).' },
        kind: { type: 'string', enum: ['fact', 'episode', 'self'], description: 'fact (default), episode (something that happened) or self (about yourself).' },
        about: { type: 'string', description: 'Person it is about, if any. Defaults to the person of a private chat.' },
        channel: { type: 'string', description: 'Channel key of the chat it came from, if any (its source).' },
        from: { type: 'string', description: 'Who told you, if not the person of that private chat.' },
        importance: importanceParam,
      },
      output: lineResult,
      execute: async (args, exec) => {
        if (args.text.trim() === '') throw new AnimaError('anima/empty-memory', 'text is empty.')
        const key = args.channel?.trim() ?? ''
        const channel = key === '' ? undefined : life.channel(key)
        if (key !== '' && channel === undefined) throw new AnimaError('anima/unknown-channel', `没有「${args.channel}」这个地方。`)
        const people = this.chatPeople(channel)
        const chat = [...people][0]
        const from = this.resolvePerson(args.from, people) ?? (chat === undefined ? undefined : { id: chat[0], name: chat[1] })
        const kind = (args.kind ?? 'fact') as MemoryKind
        const about = this.resolvePerson(args.about, people)?.id ?? (kind === 'fact' ? chat?.[0] : undefined)
        const memory = this.store.remember({
          kind, text: args.text, channelKey: channel === undefined ? undefined : channelKey(channel),
          fromPerson: from?.id, fromName: from?.name, personId: kind === 'self' ? undefined : about,
          importance: args.importance, waking: exec.agent?.id, now: core.clock.now(),
        })
        return { line: `记住了：${sourceOf(memory)}` }
      },
    }), { effect: 'internal', sessions: ['waking'] })

    core.registerBehavior(defineTool({
      name: 'memory_write',
      description: 'Write one memory from the piece of your waking you are sorting.',
      parameters: {
        kind: { type: 'string', enum: ['episode', 'fact', 'self'], required: true, description: 'episode (what happened, dated), fact (about a person or the world), self (a passing thought about yourself; lasting tastes, habits and opinions go to self_note).' },
        text: { type: 'string', required: true, description: 'The memory as a self-contained sentence; name people and dates.' },
        channel: { type: 'string', description: 'Channel key of the place in the piece where it happened or was said (its source). Omit for what was your own (a thought, a video you watched).' },
        from: { type: 'string', description: 'Who it came from: a person of the piece (id or name). Defaults to the person of a private chat.' },
        about: { type: 'string', description: 'Person it is about, for facts about someone (id or name).' },
        replaces: { type: 'string', description: 'Id of an older memory this one corrects (e.g. m4); the old one is kept as history.' },
        importance: importanceParam,
      },
      output: lineResult,
      execute: async (args, exec) => {
        const run = this.run
        if (run === undefined || exec.agent?.id !== run.sessionId) throw new AnimaError('anima/no-run', 'no consolidation is running in this session.')
        if (args.text.trim() === '') throw new AnimaError('anima/empty-memory', 'text is empty.')
        const key = args.channel?.trim() ?? ''
        if (key !== '' && !run.channels.has(key)) {
          throw new AnimaError('anima/unknown-channel', `这段经历里没有「${key}」；这段里出现的地方：${[...run.channels].join('、') || '没有'}。`)
        }
        const channel: (ChannelRef & { display?: string; isOwner?: boolean }) | undefined = key === '' ? undefined : life.channel(key)
        const people = new Map([...run.people, ...this.chatPeople(channel as PublishedChannel | undefined)])
        const chat = channel === undefined ? undefined : [...this.chatPeople(channel as PublishedChannel)][0]
        const from = this.resolvePerson(args.from, people) ?? (chat === undefined ? undefined : { id: chat[0], name: chat[1] })
        let replaced: Memory | undefined
        if (args.replaces !== undefined && args.replaces.trim() !== '') {
          replaced = this.store.get(args.replaces)
          if (replaced === undefined || replaced.status !== 'active') throw new AnimaError('anima/unknown-memory', `"${args.replaces}" is not an active memory.`)
        }
        const kind = args.kind as MemoryKind
        const about = this.resolvePerson(args.about, people)?.id ?? (kind === 'fact' ? chat?.[0] : undefined)
        const now = core.clock.now()
        const memory = this.store.remember({
          kind, text: args.text, channelKey: key === '' ? undefined : key,
          fromPerson: from?.id, fromName: from?.name, personId: kind === 'self' ? undefined : about,
          importance: args.importance, waking: run.waking, now,
        })
        if (replaced !== undefined) this.store.supersede(replaced.id, memory.id, now)
        return { line: `写下 ${sourceOf(memory)}${replaced === undefined ? '' : `（代替 ${replaced.id}）`}` }
      },
    }), { effect: 'internal', sessions: ['consolidation'] })
  }

  // ---- report, status ----

  private lastConsolidation(): string {
    const at = this.store.meta('lastConsolidatedAt')
    return at === undefined ? 'never' : formatLocal(Number(at))
  }

  /** Situation report line: facts only. */
  reportLine(): string {
    const pending = this.store.pendingWakings().length
    return `Memory: ${pending === 0 ? 'every ended waking is consolidated' : `${pending} ended waking${pending === 1 ? '' : 's'} not yet consolidated`}; last consolidation ${this.lastConsolidation()}.`
  }

  private statusLines(): string[] {
    const counts = this.store.counts()
    return [
      `Memories: ${counts.active} active, ${counts.archived} archived, ${counts.superseded} superseded`,
      `Consolidation: ${this.store.pendingWakings().length} ended wakings pending; last ${this.lastConsolidation()}${this.run === undefined ? '' : `; piece ${this.run.id} of ${this.run.waking} in progress`}${this.stalled ? '; waiting for her next sleep' : ''}`,
    ]
  }
}

