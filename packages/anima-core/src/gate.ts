/**
 * The policy gate's decisions (DESIGN §10). Pure functions plus an in-memory
 * sliding-window quota book; the `tools/pre-execute` listener lives in the service.
 * @module @anima/core/gate
 */

import type { AllowRule, ApproveRule, LimitRule, QuotaRule } from './config.ts'
import type { Mode } from './rhythm.ts'
import { costOf, type BehaviorMeta, type EffectClass, type SessionInfo } from './types.ts'

/** Gate outcome. A refusal carries a stable `code` and a hint she can act on. */
export type Verdict =
  /** `approval` set: allowed only once the owner approves; the text says why approval is needed. */
  | { readonly allowed: true; readonly approval?: string }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Policy the gate applies. Fields beyond quotas and allow rules are optional (tests). */
export interface Policy {
  readonly quotas: readonly QuotaRule[]
  readonly allow: readonly AllowRule[]
  /** Behaviors that always need owner approval. */
  readonly approve?: readonly ApproveRule[]
  /** Limits on numeric facts of calls. */
  readonly limits?: readonly LimitRule[]
  /** Effect classes allowed per mode; all when omitted. */
  readonly allowedEffects?: Readonly<Record<Mode, readonly EffectClass[]>>
  /** Self-initiated conversations per day; unlimited when omitted. */
  readonly initiatePerDay?: number
}

/** Time and budget facts of the moment, computed from her clock by the service. */
export interface GateMoment {
  /** Current heartbeat mode. */
  readonly mode: Mode
  /** Why initiating is not allowed now (sleep, quiet hours), or undefined. */
  readonly quiet?: string | undefined
  /** Whether the current mode's token budget is spent. */
  readonly overBudget: boolean
  /** Conversations she initiated today. */
  readonly initiatesUsed: number
  /** Whether she may initiate in a channel (consent). */
  readonly mayInitiate: (channelKey: string) => boolean
  /** Whether an owner line exists to ask approvals on; without one, approval-class calls are refused. */
  readonly ownerLine?: boolean
  /**
   * Whether a channel is on its platform's allowlist: false when refused,
   * undefined when the platform has no allowlist.
   */
  readonly channelAllowed?: (channelKey: string) => boolean | undefined
  /**
   * Whether an adapter published a channel. A target nobody published is left
   * to the behavior, which refuses it and lists the channels that exist.
   */
  readonly channelKnown?: (channelKey: string) => boolean
  /** Whether a channel is one of the owner's own (for `approve` rules with `targets: others`). */
  readonly ownerChannel?: (channelKey: string) => boolean
  /** Channel keys she may reach (known and allowlisted), listed when a call targets an unknown one. */
  readonly knownChannels?: () => readonly string[]
  /**
   * Before the earliest bedtime of her day, for refusing `sleep` (Phase 9): the time she woke and the
   * earliest bedtime, both `HH:mm` of her day; undefined from the earliest bedtime on.
   */
  readonly beforeBedtime?: { readonly woke: string, readonly earliest: string } | undefined
}

/** Moment used when the caller gives none: day, nothing spent, consent everywhere. */
export const OPEN_MOMENT: GateMoment = { mode: 'day', overBudget: false, initiatesUsed: 0, mayInitiate: () => true }

/** One gated behavior call. */
export interface GateCall {
  /** Tool name. */
  readonly name: string
  readonly meta: BehaviorMeta
  /** The calling session, or `undefined` when it is not an Anima session. */
  readonly session: SessionInfo | undefined
  /** Epoch milliseconds. */
  readonly now: number
  /** Parsed call arguments. */
  readonly args?: Readonly<Record<string, unknown>>
  /** Numeric facts from `meta.facts`, when the behavior has them. */
  readonly facts?: Readonly<Record<string, number>>
}

/** Refusal codes the gate emits. */
export const GateCode = {
  notAnimaSession: 'anima/not-anima-session',
  wrongSession: 'anima/wrong-session',
  wrongPlatform: 'anima/wrong-platform',
  needsApproval: 'anima/needs-approval',
  overQuota: 'anima/over-quota',
  paused: 'anima/paused',
  night: 'anima/night',
  overBudget: 'anima/over-budget',
  quietHours: 'anima/quiet-hours',
  noConsent: 'anima/no-consent',
  notAllowed: 'anima/not-allowed',
  notAllowlisted: 'anima/not-allowlisted',
  unknownChannel: 'anima/unknown-channel',
  overLimit: 'anima/over-limit',
  denied: 'anima/denied',
  notBedtime: 'anima/not-bedtime',
} as const

/**
 * Whether a behavior's platform fits the session (DESIGN §6 tool scoping):
 * a conversation sees only its own platform; Self sees only platforms' `observe` behaviors.
 */
function platformFits(meta: BehaviorMeta, session: SessionInfo): boolean {
  if (meta.platform === undefined) return true
  if (session.kind === 'conversation') return session.channel.platform === meta.platform
  return meta.effect === 'observe'
}

/**
 * Whether a behavior is offered to the model in a session.
 * @param meta - behavior metadata.
 * @param session - the session, or `undefined` for a non-Anima session.
 * @returns true when the tool should be visible for this step.
 */
export function visibleIn(meta: BehaviorMeta, session: SessionInfo | undefined, mode?: Mode): boolean {
  return session !== undefined && meta.sessions.includes(session.kind) && platformFits(meta, session)
    && (mode === undefined || meta.modes === undefined || meta.modes.includes(mode))
}

/** Counter key of one quota rule for a call. */
function counterKey(index: number, rule: QuotaRule, call: GateCall): string {
  const { session, meta } = call
  switch (rule.per) {
    case 'channel': {
      const target = meta.target?.(call.args ?? {})
      return `${index}|channel:${target ?? (session?.kind === 'conversation' ? session.channelKey : 'self')}`
    }
    case 'platform': return `${index}|platform:${meta.platform ?? 'core'}`
    case 'global': return `${index}|global`
  }
}

/**
 * Whether a behavior only closes the turn with no effect on the world (`end_turn`,
 * `rest`, `group_pass`): quotas never count or refuse it, because refusing the
 * close leaves the turn unclosed and turns a spent quota into a lost reply (Phase 8).
 */
export function quotaExempt(meta: BehaviorMeta): boolean {
  return meta.closes === true && meta.effect === 'internal'
}

function matches(rule: QuotaRule, call: GateCall): boolean {
  if (quotaExempt(call.meta)) return false
  return (rule.effect === undefined || rule.effect === call.meta.effect)
    && (rule.behavior === undefined || rule.behavior === call.name)
    && (rule.platform === undefined || rule.platform === call.meta.platform)
}

function describeWindow(minutes: number): string {
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? 'day' : `${minutes / (24 * 60)} days`
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`
  return `${minutes} min`
}

/** A quota window in her words: 这一小时, 今天, 这 10 分钟. */
function windowZh(minutes: number): string {
  if (minutes === 24 * 60) return '这一天'
  if (minutes % (24 * 60) === 0) return `这 ${minutes / (24 * 60)} 天`
  if (minutes === 60) return '这一小时'
  if (minutes % 60 === 0) return `这 ${minutes / 60} 小时`
  return `这 ${minutes} 分钟`
}

/** Where a quota counts, in her words. */
function scopeZh(rule: QuotaRule): string {
  switch (rule.per) {
    case 'channel': return '在这个地方'
    case 'platform': return '在这个平台上'
    case 'global': return '总共'
  }
}

/** Session kinds in her words (the primer's names for her places of attention). */
const KIND_ZH: Record<string, string> = {
  self: '你的内心（Self）',
  conversation: '聊天',
  triage: '心跳',
  consolidation: '整理记忆',
  'group-triage': '扫视群聊',
  viewing: '细看',
}

/**
 * The refusal hint of a spent quota, in her world's terms (Phase 9): a say in
 * a chat reads "you said a lot here this hour", not "express quota".
 */
export function quotaHint(name: string, meta: BehaviorMeta, rule: QuotaRule, minutes: number): string {
  const later = `大约 ${minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`}后才行，现在别再试了。`
  if (meta.effect === 'express' && rule.per === 'channel' && rule.behavior === undefined) {
    return `这个聊天里你${windowZh(rule.windowMinutes)}已经说了很多了（最多 ${rule.limit} 次），过一会儿再说吧：${later}`
  }
  if (rule.per === 'global' && rule.behavior === undefined && rule.effect === undefined && rule.platform === undefined) {
    return `你${windowZh(rule.windowMinutes)}做的事已经够多了（总共最多 ${rule.limit} 次），歇一歇：${later}`
  }
  return `${name} ${windowZh(rule.windowMinutes)}${scopeZh(rule)}最多 ${rule.limit} 次，已经到了；${later}`
}

/** Sliding-window usage counters, in memory (Phase 1: a restart resets them). */
export class QuotaBook {
  private readonly entries = new Map<string, { at: number; amount: number }[]>()

  /** Live entries of a key inside the window ending at `now`. */
  private live(key: string, windowMs: number, now: number): { at: number; amount: number }[] {
    const list = (this.entries.get(key) ?? []).filter(entry => entry.at > now - windowMs)
    if (list.length === 0) this.entries.delete(key)
    else this.entries.set(key, list)
    return list
  }

  /**
   * Find the first matching rule the call would exceed.
   * @param only - consider only these rules (indexes stay those of `quotas`).
   * @returns the rule and the time a slot frees up, or undefined when within all quotas.
   */
  exceeded(call: GateCall, quotas: readonly QuotaRule[], only?: (rule: QuotaRule) => boolean): { rule: QuotaRule; freeAt: number } | undefined {
    const cost = costOf(call.meta, call.args)
    for (const [index, rule] of quotas.entries()) {
      if (!matches(rule, call) || only?.(rule) === false) continue
      const windowMs = rule.windowMinutes * 60_000
      const list = this.live(counterKey(index, rule, call), windowMs, call.now)
      let used = list.reduce((sum, entry) => sum + entry.amount, 0)
      if (used + cost <= rule.limit) continue
      // The slot frees when enough of the oldest entries age out.
      let freeAt = call.now
      for (const entry of list) {
        used -= entry.amount
        freeAt = entry.at + windowMs
        if (used + cost <= rule.limit) break
      }
      return { rule, freeAt }
    }
    return undefined
  }

  /** Entries for persistence; expired ones are dropped on the next read. */
  toJSON(): Record<string, { at: number; amount: number }[]> {
    return Object.fromEntries(this.entries)
  }

  /** Restore saved entries (from {@link toJSON}). */
  load(saved: Readonly<Record<string, readonly { at: number; amount: number }[]>> | undefined): void {
    for (const [key, list] of Object.entries(saved ?? {})) this.entries.set(key, list.map(entry => ({ at: entry.at, amount: entry.amount })))
  }

  /** Count an allowed call against every rule it matches. */
  record(call: GateCall, quotas: readonly QuotaRule[], only?: (rule: QuotaRule) => boolean): void {
    const cost = costOf(call.meta, call.args)
    for (const [index, rule] of quotas.entries()) {
      if (!matches(rule, call) || only?.(rule) === false) continue
      const key = counterKey(index, rule, call)
      const list = this.entries.get(key) ?? []
      list.push({ at: call.now, amount: cost })
      this.entries.set(key, list)
    }
  }

  /**
   * Current usage of every rule for one channel key, for `/anima status`.
   * @returns one line per rule.
   */
  usage(quotas: readonly QuotaRule[], now: number): string[] {
    return quotas.map((rule, index) => {
      const windowMs = rule.windowMinutes * 60_000
      const prefix = `${index}|`
      const counters = [...this.entries.keys()].filter(key => key.startsWith(prefix))
      const used = counters.map(key => [key.slice(prefix.length), this.live(key, windowMs, now).reduce((s, e) => s + e.amount, 0)] as const)
        .filter(([, n]) => n > 0)
      const filter = [rule.platform === undefined ? undefined : `${rule.platform}_*`, rule.effect, rule.behavior].filter(Boolean).join(' ') || 'all'
      const detail = used.length === 0 ? 'unused' : used.map(([key, n]) => `${key} ${n}`).join(', ')
      return `${filter}: ${rule.limit} per ${describeWindow(rule.windowMinutes)} per ${rule.per} — ${detail}`
    })
  }
}

/**
 * Decide one behavior call. Checks, in order: Anima session, session kind,
 * platform, mode (night), channel allowlist, argument constraints, fact limits, token
 * budget, initiate rules (daily count, quiet hours, consent), quotas, and
 * last whether owner approval is needed (DESIGN §10). Does not record usage.
 * @param call - the call.
 * @param policy - owner policy.
 * @param book - quota counters.
 * @param moment - time and budget facts; open by default.
 * @returns the verdict.
 */
export function decide(call: GateCall, policy: Policy, book: QuotaBook, moment: GateMoment = OPEN_MOMENT): Verdict {
  const { meta, session, name } = call
  const args = call.args ?? {}
  if (session === undefined) {
    return deny(GateCode.notAnimaSession, `${name} 只在你自己的会话里能用。`)
  }
  if (!meta.sessions.includes(session.kind)) {
    return deny(GateCode.wrongSession, `${name} 在${KIND_ZH[session.kind] ?? session.kind}里用不了；它在这些地方能用：${meta.sessions.map(kind => KIND_ZH[kind] ?? kind).join('、')}。`)
  }
  if (!platformFits(meta, session)) {
    return deny(GateCode.wrongPlatform, `${name} 属于 ${meta.platform}，在这里不能直接用。`)
  }
  const allowed = policy.allowedEffects?.[moment.mode]
  if ((meta.modes !== undefined && !meta.modes.includes(moment.mode)) || (allowed !== undefined && !allowed.includes(meta.effect))) {
    return deny(GateCode.night, moment.mode === 'night'
      ? `你现在睡着了：${name} 要等你醒来才能用，睡着时只能做内心里的事（记忆、休息）。`
      : `${name} 只在夜里能用。`)
  }
  const target = meta.target?.(args)
  if (target !== undefined && moment.channelKnown?.(target) === false) {
    // Refused before any approval or count, with the real keys, so she never has to guess.
    const known = moment.knownChannels?.() ?? []
    return deny(GateCode.unknownChannel, `没有「${target}」这个地方。你能去的地方：${known.length === 0 ? '没有' : known.join('、')}。`)
  }
  const allowlisted = moment.channelAllowed
  if (allowlisted !== undefined) {
    if (meta.platform !== undefined && session.kind === 'conversation' && allowlisted(session.channelKey) === false) {
      return deny(GateCode.notAllowlisted, `主人没有把这个聊天放进名单，${name} 在这里用不了。`)
    }
    if (target !== undefined && allowlisted(target) === false) {
      return deny(GateCode.notAllowlisted, `主人没有把 ${target} 放进名单，你去不了那里。`)
    }
  }
  if (meta.bedtime === true && moment.beforeBedtime !== undefined) {
    return deny(GateCode.notBedtime, `还不到睡觉的时候：你今天 ${moment.beforeBedtime.woke} 才起床，主人定的最早上床时间是今晚 ${moment.beforeBedtime.earliest}。`)
  }
  const constraint = meta.constraint?.(args)
  if (constraint !== undefined) return deny(GateCode.notAllowed, constraint)
  for (const rule of policy.limits ?? []) {
    if (rule.behavior !== name) continue
    const value = call.facts?.[rule.fact]
    if (value !== undefined && value > rule.max) {
      return deny(GateCode.overLimit, `${name} 的 ${rule.fact} 最多 ${rule.max}，这次是 ${Math.round(value * 100) / 100}。换个小一点的，或者换一种看法。`)
    }
  }
  if (moment.overBudget && meta.effect !== 'internal') {
    return deny(GateCode.overBudget, `${moment.mode === 'night' ? '今晚' : '今天'}能用的 token 预算用完了。在它恢复之前，你只能休息和做内心里的事。`)
  }
  if (meta.effect === 'initiate') {
    const limit = policy.initiatePerDay
    if (limit !== undefined && moment.initiatesUsed + costOf(meta, args) > limit) {
      return deny(GateCode.overQuota, `今天你已经主动找人聊了 ${moment.initiatesUsed} 次，最多 ${limit} 次。等明天，或者等别人来找你。`)
    }
    if (moment.quiet !== undefined) return deny(GateCode.quietHours, `${moment.quiet}，现在不能主动找人说话。`)
    if (target !== undefined && !moment.mayInitiate(target)) {
      return deny(GateCode.noConsent, `主人没有允许你主动去 ${target} 说话。`)
    }
  }
  const over = book.exceeded(call, policy.quotas)
  if (over !== undefined) {
    const minutes = Math.max(1, Math.ceil((over.freeAt - call.now) / 60_000))
    const { rule } = over
    return deny(GateCode.overQuota, quotaHint(name, meta, rule, minutes))
  }
  const forced = policy.approve?.some(rule => rule.behavior === name
    && (rule.targets !== 'others' || target === undefined || moment.ownerChannel?.(target) !== true)) === true
  if (forced || ((meta.effect === 'public' || meta.effect === 'irreversible') && !policy.allow.some(rule => rule.behavior === name))) {
    const why = forced
      ? target !== undefined && policy.approve?.some(rule => rule.behavior === name && rule.targets === 'others') === true
        ? `the owner approves every ${name} toward someone other than the owner`
        : `the owner wants to approve every ${name}`
      : `${name} is a ${meta.effect} action`
    if (moment.ownerLine === true) return { allowed: true, approval: why }
    return deny(GateCode.needsApproval, `${whyZh(name, meta, forced, target !== undefined && policy.approve?.some(rule => rule.behavior === name && rule.targets === 'others') === true)}，现在没有办法问主人，所以不行。你可以告诉主人你想做什么。`)
  }
  return { allowed: true }
}

/** Why a call needs the owner, in her words. */
function whyZh(name: string, meta: BehaviorMeta, forced: boolean, others: boolean): string {
  if (forced) return others ? `每次用 ${name} 去找主人以外的人，主人都要先同意` : `每次用 ${name}，主人都要先同意`
  return `${name} 是${meta.effect === 'public' ? '公开的' : '做了就收不回的'}事，主人要先同意`
}

function deny(code: string, hint: string): Verdict {
  return { allowed: false, code, hint }
}
