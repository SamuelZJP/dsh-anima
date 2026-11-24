/**
 * The `animaMemory` service (docs/design/memory.md): her own transcript, the
 * memory store with audience scopes, the `memory_*` behaviors, automatic recall
 * at turn start, consolidation when she falls asleep, and daily decay.
 * @module @anima/memory/service
 */

import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { AnimaError, channelKey, formatLocal, sayMessages, type BehaviorEvent, type ChannelRef } from '@anima/core'
import type {} from '@anima/core'
import type { Stimulus, StimulusEvent } from '@anima/life'
import type {} from '@anima/life'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { audienceOf, chatPerson, describeScope, hears, learnScope, narrow, personOf, PUBLIC, SELF, type Keep, type MemoryPlace, type Scope, type SessionFacts } from './audience.ts'
import type { Config } from './config.ts'
import { buildBlock, memoryLine, selfQuery } from './inject.ts'
import { MemoryStore, type Memory, type Segment } from './store.ts'
import type { MemoryKind } from './decay.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaMemory: AnimaMemory
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Memories recalled automatically at a turn start. */
    'anima-memory': { kind: 'anima-memory' } & ContextFormed
  }
}

const TICK_MS = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Transcript session id of observations (what she watched or read on her own). */
export const OBSERVATIONS = 'anima-observations'

/** Something she observed on her own (a video she watched), from an adapter. */
export interface Observation {
  /** What she observed, one or a few lines. */
  readonly text: string
  /** Who may hear it later: `public` for public content, `self` for her own thoughts. */
  readonly scope: 'public' | 'self'
  /**
   * Store it as a memory right away (text the model already wrote, such as a
   * viewing note). Without it the line goes to her transcript, and consolidation sorts it.
   */
  readonly memory?: { readonly kind?: MemoryKind; readonly importance?: number }
  /** Session it came from. */
  readonly source?: string
}

/** A consolidation run in progress. */
interface Run {
  readonly id: string
  readonly sessionId: string
  /** Segment label (`s1`, …) to segment. */
  readonly segments: ReadonlyMap<string, Segment>
  /** Real start time, for the timeout. */
  readonly startedReal: number
}

/** Strip the clock stamp and channel tag of a delivered message, keeping what was said. */
function spoken(text: string): string {
  return text.replace(/^(\[[^\]]*\]\s*)+/u, '').replace(/^[^:\n]{1,60}:\s*/u, '')
}

function textOf(message: UserMessage): string {
  return message.content.map(block => (block as { text?: string }).text ?? '').join('\n')
}

/** Anima memory service. */
export class AnimaMemory extends Service {
  static inject = ['anima', 'animaLife', 'tools']

  /** The store. */
  readonly store: MemoryStore
  private run: Run | undefined
  private runSeq = 0

  /**
   * @param ctx - root context.
   * @param config - resolved memory config.
   */
  constructor(ctx: Context, readonly config: Readonly<Config>) {
    super(ctx, 'animaMemory')
    const core = ctx.anima
    this.store = new MemoryStore(join(core.config.dataDir, 'memory.db'))
    // A run does not survive a restart; its lines go back to pending.
    this.store.releaseAll()
    ctx.effect(() => () => this.store.close(), 'animaMemory.store')

    ctx.on('anima/stimulus', event => this.onStimulus(event))
    ctx.on('anima/behavior', event => this.onBehavior(event))
    // Consolidation is part of her sleep: it starts when she falls asleep, and only then.
    ctx.on('anima/sleep', () => {
      this.consolidate().catch((error: unknown) => ctx.logger.warn(`anima-memory: consolidation failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    ctx.on('agent/pre-step', async (payload, next) => this.preStep(payload, next))
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' && this.run !== undefined && session.id === this.run.sessionId) this.finish()
    })

    this.registerBehaviors()

    ctx.animaLife.addReportLine(() => [this.reportLine()])
    core.addStatus(() => this.statusLines())

    ctx.effect(() => {
      const timer = setInterval(() => this.tick(), TICK_MS)
      return () => clearInterval(timer)
    }, 'animaMemory.tick')
  }

  // ---- sessions and scopes ----

  /** What scope decisions need to know about a session: her waking session and sleep's consolidation are her inner life. */
  facts(sessionId: string | undefined): SessionFacts {
    const kind = sessionId === undefined ? undefined : this.ctx.anima.describeSession(sessionId)?.kind
    const info: MemoryPlace | undefined = kind === undefined ? undefined : { kind: 'inner' }
    return { info, isOwner: false }
  }

  /** What scope decisions need to know about a chat. */
  chatFacts(channel: ChannelRef): SessionFacts {
    const key = channelKey(channel)
    return { info: { kind: 'chat', channel, channelKey: key }, isOwner: this.ctx.anima.channelInfo(key)?.isOwner === true }
  }

  // ---- transcript ----

  private onStimulus({ stimulus, sessionId }: StimulusEvent): void {
    if (stimulus.type !== 'message') return
    const facts = this.chatFacts(stimulus.channel)
    const scope = learnScope(facts, this.config.persons)
    if (scope === undefined || facts.info?.kind !== 'chat') return
    const { sender, channel } = stimulus
    this.store.record({
      ts: stimulus.ts, sessionId, channelKey: facts.info.channelKey, scope, dir: 'in',
      speaker: `${sender.displayName}${sender.isOwner ? ' (owner)' : ''}`,
      speakerId: personOf(channel.platform, sender.platformUserId, sender.isOwner, this.config.persons),
      text: stimulus.text,
    })
  }

  private onBehavior(event: BehaviorEvent): void {
    // A say's text is one message or a list of them (DESIGN §6); each is one transcript line.
    const messages = event.meta.effect === 'express' ? sayMessages(event.args) : []
    if (messages.length === 0) return
    const key = event.meta.target?.(event.args)
    const channel = key === undefined ? undefined : this.ctx.animaLife.channel(key)
    if (channel === undefined || event.sessionId === undefined || this.facts(event.sessionId).info === undefined) return
    const facts = this.chatFacts(channel)
    const scope = learnScope(facts, this.config.persons)
    if (scope === undefined || facts.info?.kind !== 'chat') return
    for (const text of messages) this.store.record({ ts: event.at, sessionId: event.sessionId, channelKey: facts.info.channelKey, scope, dir: 'out', speaker: 'you', text })
  }

  /**
   * Record something she observed on her own (DESIGN §8). The caller picks
   * `public` or `self`; nothing wider can be named.
   * @returns the memory id when stored as a memory, else undefined.
   */
  observe(observation: Observation): string | undefined {
    const scope: Scope = observation.scope === 'public' ? PUBLIC : SELF
    const now = this.ctx.anima.clock.now()
    if (observation.memory !== undefined) {
      return this.store.remember({
        kind: observation.memory.kind ?? 'episode', scope, text: observation.text,
        importance: observation.memory.importance, source: observation.source, now,
      }).id
    }
    this.store.record({ ts: now, sessionId: OBSERVATIONS, channelKey: undefined, scope, dir: 'in', speaker: 'you', text: observation.text })
    return undefined
  }

  // ---- automatic recall ----

  private async preStep(
    payload: { agent: { id: string }; messages: UserMessage[]; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted || payload.step !== 1) return decision
    if (this.ctx.anima.describeSession(payload.agent.id)?.kind !== 'waking') return decision
    const facts = this.facts(payload.agent.id)
    const texts = decision.messages
      .filter(message => message.source?.kind !== 'anima-memory')
      .map(textOf)
    const query = texts.map(text => /^\[[^\]]*\]\s*\[(心跳|醒来)\]/u.test(text) ? selfQuery(text) : spoken(text)).join('\n')
    const block = buildBlock({
      store: this.store,
      audience: audienceOf(facts, this.config.persons),
      person: undefined,
      channelKey: undefined,
      query,
      tokenBudget: this.config.inject.tokenBudget,
      maxItems: this.config.inject.maxItems,
    })
    if (block === undefined) return decision
    this.store.touch(block.ids, this.ctx.anima.clock.now())
    const message = createUserMessage({
      content: [{ type: 'text', text: block.text }],
      source: { kind: 'anima-memory', form: 'recall' },
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  // ---- consolidation ----

  /** Whether a consolidation run is in progress. */
  get consolidating(): boolean {
    return this.run !== undefined
  }

  /**
   * Start a consolidation run (she fell asleep): claim pending transcript lines
   * and deliver them to the day's consolidation session on the consolidation model.
   * What a run does not take, or a run that fails, waits for her next sleep.
   * @returns the number of lines handed over (0 when nothing is pending or a run is going).
   */
  async consolidate(): Promise<number> {
    if (this.run !== undefined) return 0
    const core = this.ctx.anima
    const now = core.clock.now()
    const id = `r${now.toString(36)}-${++this.runSeq}`
    const segments = this.store.claim(id, this.config.consolidation.maxInputTokens)
    if (segments.length === 0) return 0
    const labelled = new Map(segments.map((segment, index) => [`s${index + 1}`, segment] as const))
    const day = core.dayKey(now)
    const stimulus: Stimulus = { type: 'consolidate', day, text: this.consolidationText(labelled), run: id, ts: now }
    // Mark the run before delivery: its turn may end before deliver() resolves.
    const sessionId = this.ctx.animaLife.consolidationId(day)
    this.run = { id, sessionId, segments: labelled, startedReal: Date.now() }
    try {
      await this.ctx.animaLife.deliver(stimulus, { model: this.config.consolidation.model })
    } catch (error) {
      this.store.releaseRun(id)
      this.run = undefined
      throw error
    }
    return segments.reduce((sum, segment) => sum + segment.lines.length, 0)
  }

  private finish(): void {
    const run = this.run
    if (run === undefined) return
    this.store.finishRun(run.id)
    this.store.setMeta('lastConsolidatedAt', String(this.ctx.anima.clock.now()))
    this.run = undefined
  }

  private consolidationText(segments: ReadonlyMap<string, Segment>): string {
    const parts = ['Sort these conversations into memory. Call memory_write for what is worth keeping (segment label, kind, text); skip small talk. If you learned something lasting about your own tastes, habits or opinions, keep it in your self-model with self_note instead. Stop when every segment is done.']
    for (const [label, segment] of segments) {
      const display = segment.channelKey === undefined ? undefined : this.ctx.animaLife.channel(segment.channelKey)?.display
      const people = [...new Map(segment.lines.filter(line => line.speakerId !== undefined).map(line => [line.speakerId!, line.speaker])).entries()]
      const known = this.store.inScope(segment.scope, 12)
      parts.push([
        '',
        `## ${label}: ${segment.sessionId === OBSERVATIONS ? 'things you watched or read on your own' : display ?? segment.channelKey ?? segment.sessionId}; heard by: ${describeScope(segment.scope)}`,
        `People: ${people.length === 0 ? 'none' : people.map(([id, name]) => `${name} [${id}]`).join(', ')}`,
        `Memories you already have for this audience: ${known.length === 0 ? 'none' : ''}`,
        ...known.map(memory => memoryLine(memory, false)),
        'Conversation:',
        ...segment.lines.map(line => `[${formatLocal(line.ts)}] ${line.speaker}: ${line.text}`),
      ].join('\n'))
    }
    return parts.join('\n')
  }

  /** Periodic work: give up a stuck run, decay once a day. */
  tick(): void {
    const core = this.ctx.anima
    const now = core.clock.now()
    if (this.run !== undefined && Date.now() - this.run.startedReal > this.config.consolidation.timeoutSeconds * 1000) {
      this.ctx.logger.warn(`anima-memory: consolidation run ${this.run.id} did not finish in ${this.config.consolidation.timeoutSeconds} s; its lines return to pending.`)
      this.store.releaseRun(this.run.id)
      this.run = undefined
    }
    this.decayIfDue(now)
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

  private resolveAbout(about: string | undefined, fallback: string | undefined, segment?: Segment): string | undefined {
    if (about === undefined || about.trim() === '') return fallback
    const wanted = about.trim()
    if (segment !== undefined) {
      const match = segment.lines.find(line => line.speakerId === wanted || line.speaker.replace(/ \(owner\)$/, '').toLowerCase() === wanted.toLowerCase())
      if (match?.speakerId !== undefined) return match.speakerId
    }
    return wanted
  }

  /** `about` in a chat: the chat's own person when she names them (by id, user id or display name). */
  private aboutInChat(about: string | undefined, facts: SessionFacts): string | undefined {
    const person = chatPerson(facts, this.config.persons)
    if (person === undefined || facts.info?.kind !== 'chat') return this.resolveAbout(about, undefined)
    if (about === undefined || about.trim() === '') return person
    const wanted = about.trim().toLowerCase()
    const display = this.ctx.animaLife.channel(facts.info.channelKey)?.display ?? ''
    const names = [person, facts.info.channel.id, display.replace(/\s*\([^)]*\)$/, '')].map(name => name.toLowerCase())
    return names.includes(wanted) ? person : about.trim()
  }

  private registerBehaviors(): void {
    const core = this.ctx.anima
    const memoriesResult = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { lines: { type: 'array' as const, items: { type: 'string' as const }, required: true as const, description: 'One line per memory.' } },
      },
      render: (_args: unknown, value: { lines: string[] }) => [{ type: 'text' as const, text: value.lines.length === 0 ? 'Nothing comes to mind.' : value.lines.join('\n') }],
    }
    const lineResult = {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { line: { type: 'string' as const, required: true as const, description: 'What happened.' } },
      },
      render: (_args: unknown, value: { line: string }) => [{ type: 'text' as const, text: value.line }],
    }
    const keepParam = { type: 'string' as const, enum: ['here', 'self'], description: '"here" (default): kept with the chat it came from. "self": kept as your own private thought.' }
    const importanceParam = { type: 'number' as const, description: 'How much it matters, 0 to 1 (default 0.3). Important memories fade slower.' }

    core.registerBehavior(defineTool({
      name: 'memory_recall',
      description: 'Try to remember: search your memory.',
      parameters: {
        query: { type: 'string', required: true, description: 'Words to look for: names, topics, places.' },
        archive: { type: 'boolean', description: 'Also search faded, archived memories.' },
      },
      output: memoriesResult,
      execute: async (args, exec) => {
        const facts = this.facts(exec.agent?.id)
        const audience = audienceOf(facts, this.config.persons)
        const found = this.store.recall(args.query, audience, { archive: args.archive === true, limit: 8 })
        this.store.touch(found.map(memory => memory.id), core.clock.now())
        return { lines: found.map(memory => memoryLine(memory, true)) }
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
        keep: keepParam,
        importance: importanceParam,
      },
      output: lineResult,
      execute: async (args, exec) => {
        const sessionId = exec.agent?.id
        if (this.facts(sessionId).info === undefined) throw new AnimaError('anima/no-scope', 'this session cannot keep memories.')
        const from = args.channel === undefined || args.channel.trim() === '' ? undefined : this.ctx.animaLife.channel(args.channel.trim())
        if (args.channel !== undefined && args.channel.trim() !== '' && from === undefined) throw new AnimaError('anima/unknown-channel', `没有「${args.channel}」这个地方。`)
        const facts = from === undefined ? this.facts(sessionId) : this.chatFacts(from)
        const learned = learnScope(facts, this.config.persons)
        if (learned === undefined) throw new AnimaError('anima/no-scope', 'this session cannot keep memories.')
        if (args.text.trim() === '') throw new AnimaError('anima/empty-memory', 'text is empty.')
        const scope = narrow(learned, args.keep as Keep | undefined)
        const memory = this.store.remember({
          kind: (args.kind ?? 'fact') as MemoryKind,
          scope,
          text: args.text,
          personId: this.aboutInChat(args.about, facts),
          channelKey: facts.info?.kind === 'chat' ? facts.info.channelKey : undefined,
          importance: args.importance,
          source: sessionId,
          now: core.clock.now(),
        })
        return { line: `Remembered as ${memory.id}; heard by: ${describeScope(memory.scope)}.` }
      },
    }), { effect: 'internal', sessions: ['waking'] })

    core.registerBehavior(defineTool({
      name: 'memory_forget',
      description: 'Forget a memory for good, by its id (e.g. m12). Use it when someone asks you to forget something, or a memory is wrong.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id, e.g. m12.' },
      },
      output: lineResult,
      execute: async (args, exec) => {
        const memory = this.store.get(args.id)
        const audience = audienceOf(this.facts(exec.agent?.id), this.config.persons)
        if (memory === undefined || !hears(audience, memory.scope)) throw new AnimaError('anima/unknown-memory', `no memory "${args.id}" that you can reach here.`)
        this.store.forget(memory.id)
        return { line: `Forgot ${memory.id}.` }
      },
    }), { effect: 'internal', sessions: ['waking'] })

    core.registerBehavior(defineTool({
      name: 'memory_write',
      description: 'Write one memory from a conversation segment you are sorting. Who may hear it is set by the segment.',
      parameters: {
        segment: { type: 'string', required: true, description: 'Segment label, e.g. s1.' },
        kind: { type: 'string', enum: ['episode', 'fact', 'self'], required: true, description: 'episode (what happened, dated), fact (about a person or the world), self (a passing thought about yourself; lasting tastes, habits and opinions go to self_note).' },
        text: { type: 'string', required: true, description: 'The memory as a self-contained sentence; name people and dates.' },
        about: { type: 'string', description: 'Person id from the segment\'s People list, for facts about someone.' },
        replaces: { type: 'string', description: 'Id of an older memory this one corrects (e.g. m4); the old one is kept as history.' },
        keep: keepParam,
        importance: importanceParam,
      },
      output: lineResult,
      execute: async (args, exec) => {
        const run = this.run
        if (run === undefined || exec.agent?.id !== run.sessionId) throw new AnimaError('anima/no-run', 'no consolidation is running in this session.')
        const segment = run.segments.get(args.segment.trim())
        if (segment === undefined) throw new AnimaError('anima/unknown-segment', `no segment "${args.segment}"; use one of ${[...run.segments.keys()].join(', ')}.`)
        if (args.text.trim() === '') throw new AnimaError('anima/empty-memory', 'text is empty.')
        const scope: Scope = narrow(segment.scope, args.keep as Keep | undefined)
        let replaced: Memory | undefined
        if (args.replaces !== undefined && args.replaces.trim() !== '') {
          replaced = this.store.get(args.replaces)
          if (replaced === undefined || replaced.status !== 'active' || replaced.scope !== segment.scope) {
            throw new AnimaError('anima/unknown-memory', `"${args.replaces}" is not an active memory of this segment's audience.`)
          }
        }
        const person = segment.lines.find(line => line.dir === 'in' && line.speakerId !== undefined && segment.scope.startsWith('private:'))?.speakerId
          ?? (segment.scope === 'owner' ? 'owner' : undefined)
        const now = this.ctx.anima.clock.now()
        const memory = this.store.remember({
          kind: args.kind as MemoryKind,
          scope,
          text: args.text,
          personId: args.kind === 'self' ? undefined : this.resolveAbout(args.about, args.kind === 'fact' ? person : undefined, segment),
          channelKey: segment.channelKey,
          importance: args.importance,
          source: segment.sessionId,
          now,
        })
        if (replaced !== undefined) this.store.supersede(replaced.id, memory.id, now)
        return { line: `Wrote ${memory.id}${replaced === undefined ? '' : `, replacing ${replaced.id}`}; heard by: ${describeScope(scope)}.` }
      },
    }), { effect: 'internal', sessions: ['consolidation'] })
  }

  // ---- report, status, commands ----

  private lastConsolidation(): string {
    const at = this.store.meta('lastConsolidatedAt')
    return at === undefined ? 'never' : formatLocal(Number(at))
  }

  /** Situation report line: facts only. */
  reportLine(): string {
    const pending = this.store.pendingCount()
    const oldest = this.store.oldestPending()
    const since = oldest === undefined ? '' : ` (oldest from ${formatLocal(oldest)})`
    return `Memory: ${pending} conversation lines not yet consolidated${since}; last consolidation ${this.lastConsolidation()}.`
  }

  private statusLines(): string[] {
    const counts = this.store.counts()
    return [
      `Memories: ${counts.active} active, ${counts.archived} archived, ${counts.superseded} superseded`,
      `Transcript: ${this.store.pendingCount()} lines pending; last consolidation ${this.lastConsolidation()}${this.run === undefined ? '' : `; run ${this.run.id} in progress`}`,
    ]
  }
}
