/**
 * The guard's decisions on behavior calls (docs/design/outside.md): limits,
 * budget, conversations she starts, quotas, and whether the owner must approve.
 * Pure functions plus a sliding-window quota book. What her body cannot do
 * (asleep, wrong place) is decided inside the persona, by `anima-core`.
 * @module @anima/guard/gate
 */

import { costOf, quotaExempt, type BehaviorMeta, type SessionInfo } from '@anima/core'
import type { AllowRule, ApproveRule, LimitRule, QuotaRule } from './config.ts'

/** Outcome. A refusal carries a stable `code` and a hint. */
export type Verdict =
  /** `approval` set: allowed only once the owner approves; the text says why. */
  | { readonly allowed: true; readonly approval?: string }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Policy the gate applies. */
export interface Policy {
  readonly quotas: readonly QuotaRule[]
  readonly allow: readonly AllowRule[]
  readonly approve?: readonly ApproveRule[]
  readonly limits?: readonly LimitRule[]
  /** Conversations she may start per day; unlimited when omitted. */
  readonly initiatePerDay?: number
}

/** Facts of the moment, computed by the service. */
export interface GateMoment {
  /** Why she may not start a conversation now (quiet hours), or undefined. */
  readonly quiet?: string | undefined
  /** Whether the token budget of the moment is spent. */
  readonly overBudget: boolean
  /** Whether she is asleep (which budget counts). */
  readonly night?: boolean
  /** Conversations she started today. */
  readonly initiatesUsed: number
  /** Whether she may start a conversation in a channel (consent). */
  readonly mayInitiate: (channelKey: string) => boolean
  /** Whether an owner line exists to ask on; without one, approval-class calls are refused. */
  readonly ownerLine?: boolean
  /** Whether a channel is one of the owner's own (for `approve` rules with `targets: others`). */
  readonly ownerChannel?: (channelKey: string) => boolean
  /** Whether a channel is on the allowlist; every channel is when omitted. */
  readonly allowedChannel?: (channelKey: string) => boolean
}

/** Moment used when the caller gives none: nothing spent, consent everywhere. */
export const OPEN_MOMENT: GateMoment = { overBudget: false, initiatesUsed: 0, mayInitiate: () => true }

/** One behavior call. */
export interface GateCall {
  readonly name: string
  readonly meta: BehaviorMeta
  /** The calling session, or `undefined` when it is not an Anima session. */
  readonly session: SessionInfo | undefined
  /** Epoch milliseconds on her clock. */
  readonly now: number
  readonly args?: Readonly<Record<string, unknown>>
  /** Numeric facts from `meta.facts`. */
  readonly facts?: Readonly<Record<string, number>>
}

/** Refusal codes the guard emits. */
export const GuardCode = {
  needsApproval: 'anima/needs-approval',
  overQuota: 'anima/over-quota',
  paused: 'anima/paused',
  overBudget: 'anima/over-budget',
  quietHours: 'anima/quiet-hours',
  noConsent: 'anima/no-consent',
  overLimit: 'anima/over-limit',
  denied: 'anima/denied',
  notAllowlisted: 'anima/not-allowlisted',
} as const

/** Every refusal of the guard starts with this, so she knows it came from outside her. */
export const OUTSIDE = '（外面拦住了你，不是你自己的身体）'

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

/** A quota window in her words: 每小时, 每天, 每 10 分钟. */
export function windowZh(minutes: number): string {
  if (minutes === 24 * 60) return '每天'
  if (minutes % (24 * 60) === 0) return `每 ${minutes / (24 * 60)} 天`
  if (minutes === 60) return '每小时'
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

/** Where a quota counts, in her words. */
function scopeZh(rule: QuotaRule): string {
  switch (rule.per) {
    case 'channel': return '在同一个地方'
    case 'platform': return '在这个平台上'
    case 'global': return '总共'
  }
}

/** The refusal hint of a spent quota: an owner rule, stated as one. */
export function quotaHint(name: string, meta: BehaviorMeta, rule: QuotaRule, minutes: number): string {
  const later = `大约 ${minutes >= 120 ? `${Math.round(minutes / 60)} 小时` : `${minutes} 分钟`}后才行，现在别再试了。`
  if (meta.effect === 'express' && rule.per === 'channel' && rule.behavior === undefined) {
    return `${OUTSIDE}主人定的限制：一个聊天里${windowZh(rule.windowMinutes)}最多说 ${rule.limit} 次，已经到了；${later}`
  }
  if (rule.per === 'global' && rule.behavior === undefined && rule.effect === undefined && rule.platform === undefined) {
    return `${OUTSIDE}主人定的限制：${windowZh(rule.windowMinutes)}总共最多做 ${rule.limit} 件事，已经到了；${later}`
  }
  return `${OUTSIDE}主人定的限制：${name} ${windowZh(rule.windowMinutes)}${scopeZh(rule)}最多 ${rule.limit} 次，已经到了；${later}`
}

/** Sliding-window usage counters. */
export class QuotaBook {
  private readonly entries = new Map<string, { at: number; amount: number }[]>()

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

  /** Restore saved entries. */
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

  /** Current usage of every rule, one line each, for `/anima status`. */
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
 * Decide one behavior call. Checks, in order: the allowlist, fact limits, token budget,
 * conversations she starts (daily count, quiet hours, consent), quotas, and
 * last whether owner approval is needed. Does not record usage.
 */
export function decide(call: GateCall, policy: Policy, book: QuotaBook, moment: GateMoment = OPEN_MOMENT): Verdict {
  const { meta, name } = call
  const args = call.args ?? {}
  const target = meta.target?.(args)
  // The allowlist is about contact with a chat; what stays inside her (ending a turn, a memory) is never refused by it.
  const channel = target ?? (call.session?.kind === 'conversation' ? call.session.channelKey : undefined)
  if (channel !== undefined && meta.effect !== 'internal' && moment.allowedChannel?.(channel) === false) {
    return deny(GuardCode.notAllowlisted, `${OUTSIDE}主人没有让你接触 ${channel}。`)
  }
  for (const rule of policy.limits ?? []) {
    if (rule.behavior !== name) continue
    const value = call.facts?.[rule.fact]
    if (value !== undefined && value > rule.max) {
      return deny(GuardCode.overLimit, `${OUTSIDE}主人定的限制：${name} 的 ${rule.fact} 最多 ${rule.max}，这次是 ${Math.round(value * 100) / 100}。换个小一点的，或者换一种看法。`)
    }
  }
  if (moment.overBudget && meta.effect !== 'internal') {
    return deny(GuardCode.overBudget, `${OUTSIDE}${moment.night === true ? '今晚' : '今天'}主人给的 token 预算用完了。在它恢复之前，只有内心里的事（记忆、休息）还能做。`)
  }
  if (meta.effect === 'initiate') {
    const limit = policy.initiatePerDay
    if (limit !== undefined && moment.initiatesUsed + costOf(meta, args) > limit) {
      return deny(GuardCode.overQuota, `${OUTSIDE}主人定的限制：每天最多主动找人聊 ${limit} 次，今天已经 ${moment.initiatesUsed} 次了。等明天，或者等别人来找你。`)
    }
    if (moment.quiet !== undefined) return deny(GuardCode.quietHours, `${OUTSIDE}${moment.quiet}，现在不能主动找人说话。`)
    if (target !== undefined && !moment.mayInitiate(target)) {
      return deny(GuardCode.noConsent, `${OUTSIDE}主人没有允许你主动去 ${target} 说话。`)
    }
  }
  const over = book.exceeded(call, policy.quotas)
  if (over !== undefined) {
    const minutes = Math.max(1, Math.ceil((over.freeAt - call.now) / 60_000))
    return deny(GuardCode.overQuota, quotaHint(name, meta, over.rule, minutes))
  }
  const othersRule = target !== undefined && policy.approve?.some(rule => rule.behavior === name && rule.targets === 'others') === true
  const forced = policy.approve?.some(rule => rule.behavior === name
    && (rule.targets !== 'others' || target === undefined || moment.ownerChannel?.(target) !== true)) === true
  if (forced || ((meta.effect === 'public' || meta.effect === 'irreversible') && !policy.allow.some(rule => rule.behavior === name))) {
    const why = forced
      ? othersRule ? `the owner approves every ${name} toward someone other than the owner` : `the owner wants to approve every ${name}`
      : `${name} is a ${meta.effect} action`
    if (moment.ownerLine === true) return { allowed: true, approval: why }
    return deny(GuardCode.needsApproval, `${OUTSIDE}${whyZh(name, meta, forced, othersRule)}，现在没有办法问主人，所以不行。你可以告诉主人你想做什么。`)
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
