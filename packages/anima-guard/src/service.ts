/**
 * The `animaGuard` service (docs/design/outside.md): everything that acts on
 * her from outside the persona. It gates her behavior calls on
 * `tools/pre-execute` (after her own body check), answers `anima/admit`, holds
 * the messages she starts, asks the owner for approvals, counts budgets and
 * quotas, keeps the pause switch, keeps the activity log, and owns the owner
 * surface (`/anima` and the Anima page). The persona never imports this package;
 * unloading it leaves her running with no restriction but her physiology.
 * @module @anima/guard/service
 */

import { join } from 'node:path'
import {
  AnimaError, costOf, Ledger, quotaExempt, readJson, sayMessages, writeJson,
  type AdmitRefusal, type AdmitRequest, type FriendRequest, type NewActivity, type OwnerSource, type PlaceFacts, type Subcommand, type ViewParams,
} from '@anima/core'
import { OUTBOX_CANCELLED, OUTBOX_EXPIRED } from './outbox.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { ActivityLog, summarize, type ActivityRecord, type DaySummary } from './activity.ts'
import { ApprovalBroker, parseOwnerReply, type ApprovalAnswer } from './approvals.ts'
import { SubcommandTable } from './commands.ts'
import { onAllowlist, resolveGuardConfig, type Config, type ResolvedGuardConfig } from './config.ts'
import { decide, startsConversation, GuardCode, OUTSIDE, QuotaBook, windowZh, type GateCall, type GateMoment } from './gate.ts'
import { Outbox, platformOf } from './outbox.ts'
import { OwnerRegistry } from './owner.ts'
import { registerSurface } from './surface.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    animaGuard: AnimaGuard
  }
}

/** Name recorded in `ToolErrorInfo.name` for guard refusals. */
export const GUARD_INFO_NAME = 'AnimaGuard'

const PAUSED_HINT = `${OUTSIDE}主人让你先停一下：现在什么都做不了，等主人让你继续。`

/** Budget counters of one of her days. */
interface GuardDay {
  initiates: number
  tokens: { day: number; night: number }
}

interface GuardFile {
  quotas?: Record<string, { at: number; amount: number }[]>
  days?: Record<string, GuardDay>
  approvalSeq?: number
  outboxSeq?: number
}

/**
 * Tokens counted against the budget: everything that is not a cache hit.
 * DSH's DeepSeek adapter reports `inputTokens` without cache reads.
 */
export function billableTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + (usage.cacheWriteTokens ?? 0)
}

/** Anima guard service. */
export class AnimaGuard extends Service {
  static inject = ['anima', 'tools']

  readonly config: ResolvedGuardConfig
  /** Pending owner approvals. */
  readonly approvals: ApprovalBroker
  /** Messages she started, waiting to go out. */
  readonly outbox: Outbox
  /** The activity log. */
  readonly activity: ActivityLog
  private readonly quota = new QuotaBook()
  private readonly owner = new OwnerRegistry()
  private readonly subcommands = new SubcommandTable()
  private readonly ledger: Ledger<GuardDay>
  private readonly path: string
  private readonly file: GuardFile
  private pausedState = false
  /** Calls that start a conversation, waiting for their success (`session|target`). */
  private readonly starting = new Set<string>()

  /**
   * @param ctx - root context with `anima` and `tools`; `animaLife`, when loaded, adds the outbox and report lines.
   * @param input - plugin config.
   */
  constructor(ctx: Context, input: Partial<Config> | undefined) {
    super(ctx, 'animaGuard')
    this.config = resolveGuardConfig(input)
    const core = ctx.anima
    const dataDir = core.config.dataDir
    this.path = join(dataDir, 'guard.json')
    this.file = readJson<GuardFile>(this.path) ?? {}
    this.quota.load(this.file.quotas)
    this.ledger = new Ledger<GuardDay>(this.file.days ?? {}, 14, () => ({ initiates: 0, tokens: { day: 0, night: 0 } }))
    this.activity = new ActivityLog(join(dataDir, 'activity'))
    // Ids keep counting across restarts, so a late "yes a3" never approves a newer request.
    this.approvals = new ApprovalBroker(() => {
      this.file.approvalSeq = (this.file.approvalSeq ?? 0) + 1
      this.save()
      return this.file.approvalSeq
    }, this.config.approvals.timeoutSeconds * 1000)
    this.outbox = new Outbox(() => {
      this.file.outboxSeq = (this.file.outboxSeq ?? 0) + 1
      this.save()
      return this.file.outboxSeq
    }, this.config.outbox.delaySeconds * 1000, this.config.outbox.offlineHoldMinutes * 60_000)
    ctx.effect(() => () => {
      this.approvals.denyAll()
      this.outbox.cancelAll()
    }, 'animaGuard.pending')

    // What the persona reports, kept in the log.
    ctx.on('anima/record', (record) => {
      const { day, ...rest } = record
      this.append(day, rest as unknown as ActivityRecord)
      if (rest.type === 'platform' && (rest as { online?: boolean }).online === true) this.outbox.release((rest as { platform: string }).platform)
    })
    ctx.on('anima/admit', request => this.admitRequest(request))
    ctx.on('anima/owner-message', text => this.ownerMessage(text))
    ctx.on('anima/friend-request', (request) => {
      void this.friendRequest(request).catch((error: unknown) => ctx.logger.warn(`anima guard: friend request: ${error instanceof Error ? error.message : String(error)}`))
      return true
    })

    // The gate: after her body check, before the tool runs.
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const meta = core.behavior(exec.name)
      if (meta === undefined) return next()
      const sessionId = exec.agent?.id
      // What her body refuses is left to her body (the next listener says why).
      if (!core.check(exec.name, exec.arguments, sessionId).allowed) return next()
      const sessionKind = sessionId === undefined ? undefined : core.describeSession(sessionId)?.kind
      const record = (decision: 'allowed' | 'refused' | 'approved' | 'denied', code?: string, hint?: string) => this.log({
        type: 'gate', behavior: exec.name, decision,
        ...sessionKind === undefined ? {} : { session: sessionKind },
        ...sessionId === undefined ? {} : { sessionId },
        ...code === undefined ? {} : { code },
        ...hint === undefined ? {} : { hint },
      })
      const refuse = (code: string, hint: string) => {
        record('refused', code, hint)
        return refusal(code, hint)
      }
      if (this.pausedState && !quotaExempt(meta)) return refuse(GuardCode.paused, PAUSED_HINT)
      const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {}
      let facts: Readonly<Record<string, number>> | undefined
      if (meta.facts !== undefined) {
        try {
          facts = await meta.facts(args)
        } catch (error: unknown) {
          const code = error instanceof AnimaError ? error.code : 'anima/facts-failed'
          const text = error instanceof Error ? error.message.replace(/^[a-z]+\/[a-z-]+:\s*/, '') : String(error)
          return refuse(code, text)
        }
      }
      const call: GateCall = {
        name: exec.name, meta,
        session: sessionId === undefined ? undefined : core.describeSession(sessionId),
        now: core.clock.now(), args,
        ...facts === undefined ? {} : { facts },
      }
      const verdict = decide(call, this.policy(), this.quota, this.moment(call.now))
      if (!verdict.allowed) return refuse(verdict.code, verdict.hint)
      if (verdict.approval !== undefined) {
        const answer = await this.requestApproval(`She wants to call ${exec.name}${describeArgs(args)} (${verdict.approval}).`, { signal: exec.signal })
        if (answer !== 'approved') {
          const hint = deniedHint(exec.name, answer)
          record('denied', GuardCode.denied, hint)
          return refusal(GuardCode.denied, hint)
        }
        if (this.pausedState && !quotaExempt(meta)) return refuse(GuardCode.paused, PAUSED_HINT)
      }
      // Where she speaks first, a say waits in the outbox, and the conversation she starts counts.
      const target = meta.target?.(args)
      const starts = startsConversation(call, this.moment(call.now))
      if (starts && sessionId !== undefined && target !== undefined && meta.effect === 'express' && exec.name.endsWith('_say') && this.config.outbox.delaySeconds > 0) {
        const held = await this.holdOutgoing(sessionId, target, sayMessages(args).join('\n'))
        if (held !== undefined) return refuse(held.code, held.hint)
      }
      const decision = await next()
      if (decision.kind === 'allow') {
        // It counts as a conversation she started once the call succeeds (`anima/behavior`).
        if (starts) this.starting.add(`${sessionId ?? ''}|${target ?? exec.name}`)
        this.quota.record(call, this.config.quotas)
        this.save()
        record(verdict.approval === undefined ? 'allowed' : 'approved')
      } else if (decision.kind === 'deny') {
        record('refused', decision.info?.code ?? 'dsh/denied', decision.reason)
      }
      return decision
    }, { prepend: true })

    // Monotonic final denial: nothing later in the pipeline can lift a pause (turn closers excepted).
    ctx.tools.guard((exec) => {
      const meta = core.behavior(exec.name)
      return this.pausedState && meta !== undefined && !quotaExempt(meta) ? `${GuardCode.paused}: ${PAUSED_HINT}` : undefined
    })

    // Token budget: billable tokens of every Anima session's model calls.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return
      if (core.describeSession(session.id) === undefined) return
      const now = core.clock.now()
      this.today(now).tokens[core.asleep() ? 'night' : 'day'] += billableTokens(event.data.usage)
      this.save()
    })
    // A conversation she started counts once the call that started it succeeded.
    ctx.on('anima/behavior', (event) => {
      const key = `${event.sessionId ?? ''}|${event.meta.target?.(event.args) ?? event.name}`
      if (!this.starting.delete(key)) return
      this.today(event.at).initiates += costOf(event.meta, event.args)
      this.save()
    })

    // Facts from outside in her prompt and her report.
    core.addPlaceLines(facts => this.limitLines(facts))
    ctx.inject(['animaLife'], (ctx) => {
      ctx.animaLife.addBudgetLine(() => this.budgetLines())
    })

    this.registerOwnSurface()
  }

  // ---- state ----

  /** Whether she is paused. */
  get paused(): boolean {
    return this.pausedState
  }

  /** Pause or resume her; tells the persona (`anima/paused`). */
  setPaused(paused: boolean): void {
    const was = this.pausedState
    this.pausedState = paused
    if (was !== paused) this.ctx.emit('anima/paused', paused)
  }

  private today(t: number): GuardDay {
    return this.ledger.day(this.ctx.anima.dayKey(t))
  }

  /** Today's counters (read-only copy). */
  todayCounts(t = this.ctx.anima.clock.now()): GuardDay {
    return this.ledger.peek(this.ctx.anima.dayKey(t))
  }

  /** Whether the token budget of the moment (awake or asleep) is spent. */
  overBudget(t = this.ctx.anima.clock.now()): boolean {
    const mode = this.ctx.anima.asleep() ? 'night' : 'day'
    return this.todayCounts(t).tokens[mode] >= this.config.budget[mode]
  }

  /**
   * Whether a say toward a chat would be her speaking first: nobody there
   * wrote to her, and she did not speak there, within `initiate.replyWindowMinutes`.
   * The guard's own rule, outside her; her life only reports when she last heard and spoke.
   */
  speakingFirst(channelKey: string, t = this.ctx.anima.clock.now()): boolean {
    const life = this.ctx.get('animaLife')
    if (life === undefined) return false
    const window = this.config.initiate.replyWindowMinutes * 60_000
    const recent = (at: number | undefined) => at !== undefined && t - at <= window
    if (life.inbox.peek(channelKey).length > 0) return false
    return !recent(life.lastHeard(channelKey)) && !recent(life.lastSpoke(channelKey))
  }

  /** Whether she may start a conversation in a channel (consent). */
  mayInitiate(channelKey: string): boolean {
    if (this.config.initiate.consent.channels.includes(channelKey)) return true
    return this.config.initiate.consent.owner && this.ctx.anima.channelInfo(channelKey)?.isOwner === true
  }

  private save(): void {
    writeJson(this.path, { ...this.file, quotas: this.quota.toJSON(), days: this.ledger.toJSON() } satisfies GuardFile)
  }

  private policy() {
    return {
      quotas: this.config.quotas,
      allow: this.config.allow,
      approve: this.config.approve,
      limits: this.config.limits,
      initiatePerDay: this.config.initiate.perDay,
    }
  }

  private moment(now: number): GateMoment {
    const core = this.ctx.anima
    const quiet = this.config.quiet.some(window => inWindow(now, window.from, window.to)) ? '现在是主人定的安静时段' : undefined
    return {
      quiet,
      speakingFirst: key => this.speakingFirst(key, now),
      overBudget: this.overBudget(now),
      night: core.asleep(),
      initiatesUsed: this.todayCounts(now).initiates,
      mayInitiate: key => this.mayInitiate(key),
      ownerLine: core.ownerLine !== undefined,
      ownerChannel: key => core.channelInfo(key)?.isOwner === true,
      allowedChannel: key => this.allowed(key),
    }
  }

  // ---- the activity log ----

  private append(day: string, record: ActivityRecord): void {
    try {
      this.activity.append(day, record)
    } catch (error: unknown) {
      this.ctx.logger.warn(`anima guard: activity log write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Log one record of the guard's own on her current day. */
  log(record: NewActivity): void {
    const core = this.ctx.anima
    const at = core.clock.now()
    this.append(core.dayKey(at), { ...record, at, real: Date.now() } as ActivityRecord)
  }

  /** Summary of one of her days (default today). */
  daySummary(day = this.ctx.anima.dayKey()): DaySummary {
    const counts = this.ledger.peek(day)
    return summarize(day, this.activity.read(day), counts)
  }

  // ---- admission ----

  /** Whether a channel is on the owner's allowlist (the owner's own channels always are). */
  allowed(channelKey: string): boolean {
    return onAllowlist(this.config.allowlist, channelKey, this.ctx.anima.channelInfo(channelKey)?.isOwner === true)
  }

  private admitRequest(request: AdmitRequest): AdmitRefusal | undefined {
    const paused: AdmitRefusal = { code: GuardCode.paused, reason: 'paused' }
    switch (request.kind) {
      case 'reach':
        if (request.channelKey !== undefined && !this.allowed(request.channelKey)) {
          this.log({ type: 'gate', behavior: 'reach', decision: 'refused', channel: request.channelKey, code: GuardCode.notAllowlisted, hint: 'not on the allowlist; it does not reach her' })
          return { code: GuardCode.notAllowlisted, reason: 'not-allowlisted', drop: true }
        }
        return this.pausedState ? paused : undefined
      case 'initiate': return this.mayInitiate(request.channelKey) ? undefined : { code: GuardCode.noConsent, reason: 'no-consent' }
      case 'wake': return this.admitWake(request.name, request.channelKey)
    }
  }

  /** A wake that is not a tool call (`group_attention`): pause, then only the quotas that name it. */
  private admitWake(name: string, channelKey: string): AdmitRefusal | undefined {
    const record = (decision: 'allowed' | 'refused', code?: string, hint?: string) => this.log({
      type: 'gate', behavior: name, decision, session: 'waking', channel: channelKey,
      ...code === undefined ? {} : { code }, ...hint === undefined ? {} : { hint },
    })
    if (this.pausedState) {
      record('refused', GuardCode.paused, PAUSED_HINT)
      return { code: GuardCode.paused, reason: 'paused' }
    }
    const call: GateCall = { name, meta: { effect: 'internal', sessions: ['waking'], target: () => channelKey }, session: undefined, now: this.ctx.anima.clock.now(), args: {} }
    const own = (rule: { behavior?: string | undefined }) => rule.behavior === name
    const over = this.quota.exceeded(call, this.config.quotas, own)
    if (over !== undefined) {
      record('refused', GuardCode.overQuota, `limit of ${over.rule.limit} per ${over.rule.windowMinutes} min reached for ${name} in ${channelKey}.`)
      return { code: GuardCode.overQuota, reason: 'over-quota' }
    }
    this.quota.record(call, this.config.quotas, own)
    this.save()
    record('allowed')
    return undefined
  }

  // ---- approvals, owner replies, friend requests ----

  /** Ask the owner over the owner line and wait for the answer. */
  requestApproval(summary: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ApprovalAnswer> {
    return this.approvals.request(this.ctx.anima.ownerLine, summary, {
      ...options,
      onAsked: id => this.ctx.logger.info(`anima: approval ${id} asked: ${summary}`),
    })
  }

  /**
   * A message the owner wrote on an owner line. Reply commands (`yes a3`,
   * `no a3`, `cancel o2`) are consumed here and never reach her.
   * @returns the confirmation to send back, or undefined when it is ordinary chat.
   */
  ownerMessage(text: string): string | undefined {
    const reply = parseOwnerReply(text)
    if (reply === undefined) return undefined
    if (reply.verb !== 'cancel' && reply.id.startsWith('a')) {
      return this.approvals.answer(reply.id, reply.verb === 'yes')
        ? `${reply.verb === 'yes' ? 'Allowed' : 'Denied'} ${reply.id}.`
        : `No pending request ${reply.id} (already answered or timed out).`
    }
    if (reply.verb === 'cancel' && reply.id.startsWith('o')) {
      return this.outbox.cancel(reply.id) ? `Cancelled ${reply.id}; it will not be sent.` : `No message ${reply.id} in the outbox (already sent or cancelled).`
    }
    return `No pending request ${reply.id}.`
  }

  private async friendRequest(request: FriendRequest): Promise<void> {
    const answer = await this.requestApproval(request.summary)
    if (answer === 'approved' || answer === 'denied') await request.answer(answer === 'approved')
    else request.leave(answer === 'timeout' ? 'the owner did not answer in time' : 'the owner could not be asked')
  }

  // ---- the outbox ----

  /**
   * Hold a say she makes where she speaks first.
   * @returns a refusal when it must not go out, or undefined to send it.
   */
  private async holdOutgoing(sessionId: string, channelKey: string, text: string): Promise<{ code: string; hint: string } | undefined> {
    const core = this.ctx.anima
    const life = this.ctx.get('animaLife')
    if (life === undefined) return undefined
    const platform = platformOf(channelKey)
    const display = life.channel(channelKey)?.display ?? channelKey
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => { done = resolve })
    try {
      const result = await this.outbox.hold({ sessionId, channelKey, display, text, reason: 'speaking first' }, {
        online: () => life.platformOnline(platform),
        onHeld: (held) => {
          this.ctx.emit('anima/outgoing-held', { channelKey, sendsAt: held.sendsAt, done: finished })
          if (!this.config.outbox.notifyOwner || core.channelInfo(channelKey)?.isOwner === true) return
          core.ownerLine?.send(`[Anima outbox ${held.id}] In ${this.config.outbox.delaySeconds} s she sends to ${held.display}: "${text}". Reply "cancel ${held.id}" to stop it.`)
            .catch((error: unknown) => this.ctx.logger.warn(`anima: could not notify the owner about ${held.id}: ${String(error)}`))
        },
      })
      if (result === 'cancelled') return { code: OUTBOX_CANCELLED, hint: `${OUTSIDE}主人在它发出去之前取消了这条消息。现在别再发一次。` }
      if (result === 'expired') {
        return { code: OUTBOX_EXPIRED, hint: `${platform} 在该发出的时候断开了 ${this.config.outbox.offlineHoldMinutes} 分钟，所以这条消息一直没有发出去。现在别再发一次；${platform} 恢复时你会知道。` }
      }
      if (this.pausedState) return { code: OUTBOX_CANCELLED, hint: `${OUTSIDE}消息在等待发出时主人让你停下了，所以它没有发出去。` }
      return undefined
    } finally {
      done()
    }
  }

  // ---- facts for her prompt and report ----

  /** The quotas and limits that may stop the tools of a place, as fact lines (Chinese). */
  limitLines(facts: PlaceFacts): string[] {
    const here = false
    const lines: string[] = []
    for (const rule of this.config.quotas) {
      const matching = facts.tools.filter(tool => !quotaExempt(tool.meta) && (rule.behavior === undefined || rule.behavior === tool.name)
        && (rule.platform === undefined || rule.platform === tool.meta.platform)
        && (rule.effect === undefined || rule.effect === tool.meta.effect))
      if (matching.length === 0) continue
      const scope = rule.per === 'channel' ? here ? '在这个聊天里' : '每个频道分开算，' : rule.per === 'platform' ? '整个平台' : ''
      const what = rule.behavior !== undefined ? `\`${rule.behavior}\``
        : rule.effect !== undefined ? `${EFFECT_ZH[rule.effect] ?? rule.effect}类（${matching.map(tool => `\`${tool.name}\``).join('、')}）`
          : rule.platform !== undefined ? `${PLATFORM_ZH[rule.platform] ?? rule.platform} 的工具`
            : '所有工具合计'
      lines.push(`${what}：${scope}${windowZh(rule.windowMinutes)}最多 ${rule.limit} 次。`)
    }
    for (const rule of this.config.limits) {
      if (!facts.tools.some(tool => tool.name === rule.behavior)) continue
      lines.push(rule.fact === 'messages' ? `\`${rule.behavior}\`：一次最多 ${rule.max} 条消息。` : `\`${rule.behavior}\`：${rule.fact} 最多 ${rule.max}。`)
    }
    if (facts.tools.some(tool => tool.meta.effect === 'express' && tool.meta.target !== undefined)) {
      const window = this.config.initiate.replyWindowMinutes
      lines.push(`在 ${window} 分钟里没有人找过你、你也没说过话的聊天里开口，算你主动找人：每天最多 ${this.config.initiate.perDay} 次，只在主人允许的聊天里${this.config.outbox.delaySeconds > 0 ? `；这样的消息会先在发件箱里等 ${this.config.outbox.delaySeconds} 秒，主人可以取消` : ''}。`)
    }
    return lines
  }

  /** Budget lines for her situation report. */
  budgetLines(t = this.ctx.anima.clock.now()): string[] {
    const day = this.todayCounts(t)
    const mode = this.ctx.anima.asleep() ? 'night' : 'day'
    const perDay = this.config.initiate.perDay
    return [
      `conversations you may still start today: ${Math.max(0, perDay - day.initiates)} of ${perDay}`,
      `tokens used ${mode === 'night' ? 'tonight' : 'today'}: ${day.tokens[mode]} of ${this.config.budget[mode]}`,
    ]
  }

  // ---- owner surface ----

  /**
   * Add an owner view, owned by the given context (default the guard's).
   * @param owner - context whose unloading removes it.
   */
  addOwnerView(name: string, view: (params: ViewParams) => unknown, owner: Context = this.ctx): () => void {
    return owner.effect(() => this.owner.addView(name, view), `animaGuard.addOwnerView(${name})`)
  }

  /** Add an owner action, owned by the given context (default the guard's). */
  addOwnerAction(name: string, action: (args: Readonly<Record<string, unknown>>, source: OwnerSource) => unknown, owner: Context = this.ctx): () => void {
    return owner.effect(() => this.owner.addAction(name, action), `animaGuard.addOwnerAction(${name})`)
  }

  /** Add an `/anima` subcommand, owned by the given context (default the guard's). */
  addSubcommand(sub: Subcommand, owner: Context = this.ctx): () => void {
    return owner.effect(() => this.subcommands.add(sub), `animaGuard.addSubcommand(${sub.name})`)
  }

  /** Read an owner view. */
  ownerView(name: string, params: ViewParams = {}): Promise<unknown> {
    return this.owner.view(name, params)
  }

  /**
   * Run an owner action and log it with its source. Platform actions
   * (`<platform>.<name>`) come from the platforms' self-descriptions.
   */
  async ownerAction(name: string, args: Readonly<Record<string, unknown>>, source: OwnerSource): Promise<unknown> {
    try {
      const platformAction = this.platformAction(name)
      const result = platformAction === undefined ? await this.owner.run(name, args, source) : await platformAction(args, source)
      this.log({ type: 'owner', action: name, source, args, ok: true })
      return result
    } catch (error: unknown) {
      this.log({ type: 'owner', action: name, source, args, ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  private platformAction(name: string) {
    const dot = name.indexOf('.')
    if (dot < 0) return undefined
    const provider = this.ctx.anima.platforms().find(p => p.platform === name.slice(0, dot))
    return provider?.actions?.[name.slice(dot + 1)]
  }

  /** Registered owner view and action names, platform actions included. */
  ownerNames(): { views: string[]; actions: string[] } {
    const names = this.owner.names()
    const platform = this.ctx.anima.platforms().flatMap(p => Object.keys(p.actions ?? {}).map(action => `${p.platform}.${action}`))
    return { views: names.views, actions: [...names.actions, ...platform].sort() }
  }

  /** Run one `/anima` invocation; platform subcommands come from the platforms' self-descriptions. */
  dispatch(invocation: CommandInvocation): Promise<CommandResult> {
    const table = new SubcommandTable()
    const disposers = [...this.subcommands.all(), ...this.ctx.anima.platforms().flatMap(p => p.subcommands ?? [])].map(sub => table.add(sub))
    return table.dispatch(invocation).finally(() => { for (const dispose of disposers) dispose() })
  }

  /** Structured status: what `/anima status` shows, as data. */
  statusView(): Record<string, unknown> {
    const core = this.ctx.anima
    const now = core.clock.now()
    const body = core.bodyView()
    const day = this.todayCounts(now)
    return {
      ...body,
      paused: this.pausedState,
      budgets: {
        tokens: { day: day.tokens.day, night: day.tokens.night, dayBudget: this.config.budget.day, nightBudget: this.config.budget.night },
        initiates: { used: day.initiates, perDay: this.config.initiate.perDay },
        overBudget: this.overBudget(now),
      },
      approvals: this.approvals.list().length,
      ownerLine: core.ownerLine?.name ?? null,
      quotas: this.quota.usage(this.config.quotas, now),
      parts: core.statusParts(),
    }
  }

  /** `/anima status` text. */
  statusText(): string {
    const core = this.ctx.anima
    const now = core.clock.now()
    return [
      `Paused: ${this.pausedState ? 'yes' : 'no'}`,
      ...core.statusLines(),
      ...this.budgetLines(now).map(line => `Budget: ${line}`),
      `Pending approvals: ${this.approvals.list().map(p => `${p.id} ${p.summary}`).join('; ') || 'none'}`,
      `Outbox: delay ${this.config.outbox.delaySeconds} s, offline hold ${this.config.outbox.offlineHoldMinutes} min; held ${this.outbox.list().map(m => `${m.id} → ${m.display}${m.offlineSince === undefined ? '' : ' (waiting for its platform)'}`).join(', ') || 'none'}`,
      'Quotas:',
      ...this.quota.usage(this.config.quotas, now).map(line => `  ${line}`),
    ].join('\n')
  }

  private registerOwnSurface(): void {
    // Kept apart so the surface reads as one list of what the owner can see and do.
    registerSurface(this, this.ctx)
  }
}

const EFFECT_ZH: Readonly<Record<string, string>> = {
  observe: '观看', internal: '内心', workspace: '工作区', express: '表达', initiate: '发起', public: '公开', irreversible: '不可撤回',
}
const PLATFORM_ZH: Readonly<Record<string, string>> = { qq: 'QQ', bili: 'B站' }

/** Short argument summary for an approval request. */
function describeArgs(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args)
  if (text === '{}') return ''
  return ` with ${text.length > 800 ? `${text.slice(0, 800)}…` : text}`
}

function deniedHint(name: string, answer: ApprovalAnswer): string {
  switch (answer) {
    case 'denied': return `${OUTSIDE}主人没有同意 ${name}。现在别再为同一件事去问了。`
    case 'timeout': return `${OUTSIDE}主人没有及时回答，所以 ${name} 没有做成。以后可以跟主人提一下。`
    default: return `${OUTSIDE}没办法问到主人，所以 ${name} 没有做成。`
  }
}

function refusal(code: string, hint: string): PreToolDecision {
  return { kind: 'deny', reason: `${code}: ${hint}`, info: { name: GUARD_INFO_NAME, code, reason: hint } }
}

/**
 * Whether a local time lies inside a window of minutes after midnight (which
 * may wrap midnight): the owner's quiet hours, a clock rule kept outside her.
 */
export function inWindow(t: number, from: number, to: number): boolean {
  const d = new Date(t)
  const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
  return from <= to ? m >= from && m < to : m >= from || m < to
}
