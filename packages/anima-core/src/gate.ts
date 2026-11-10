/**
 * The policy gate's decisions (DESIGN §10). Pure functions plus an in-memory
 * sliding-window quota book; the `tools/pre-execute` listener lives in the service.
 * @module @anima/core/gate
 */

import type { AllowRule, QuotaRule } from './config.ts'
import type { Mode } from './rhythm.ts'
import type { BehaviorMeta, EffectClass, SessionInfo } from './types.ts'

/** Gate outcome. A refusal carries a stable `code` and a hint she can act on. */
export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Policy the gate applies. Fields beyond quotas and allow rules are optional (tests). */
export interface Policy {
  readonly quotas: readonly QuotaRule[]
  readonly allow: readonly AllowRule[]
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
    case 'channel': return `${index}|channel:${session?.kind === 'conversation' ? session.channelKey : 'self'}`
    case 'platform': return `${index}|platform:${meta.platform ?? 'core'}`
    case 'global': return `${index}|global`
  }
}

function matches(rule: QuotaRule, call: GateCall): boolean {
  return (rule.effect === undefined || rule.effect === call.meta.effect)
    && (rule.behavior === undefined || rule.behavior === call.name)
}

function describeScope(rule: QuotaRule): string {
  switch (rule.per) {
    case 'channel': return 'in this channel'
    case 'platform': return 'on this platform'
    case 'global': return 'in total'
  }
}

function describeWindow(minutes: number): string {
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? 'day' : `${minutes / (24 * 60)} days`
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`
  return `${minutes} min`
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
   * @returns the rule and the time a slot frees up, or undefined when within all quotas.
   */
  exceeded(call: GateCall, quotas: readonly QuotaRule[]): { rule: QuotaRule; freeAt: number } | undefined {
    const cost = call.meta.cost ?? 1
    for (const [index, rule] of quotas.entries()) {
      if (!matches(rule, call)) continue
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

  /** Count an allowed call against every rule it matches. */
  record(call: GateCall, quotas: readonly QuotaRule[]): void {
    const cost = call.meta.cost ?? 1
    for (const [index, rule] of quotas.entries()) {
      if (!matches(rule, call)) continue
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
      const filter = [rule.effect, rule.behavior].filter(Boolean).join(' ') || 'all'
      const detail = used.length === 0 ? 'unused' : used.map(([key, n]) => `${key} ${n}`).join(', ')
      return `${filter}: ${rule.limit} per ${describeWindow(rule.windowMinutes)} per ${rule.per} — ${detail}`
    })
  }
}

/**
 * Decide one behavior call. Checks, in order: Anima session, session kind,
 * platform, mode (night), approval-class effects, argument constraints, token
 * budget, initiate rules (daily count, quiet hours, consent), quotas
 * (DESIGN §10 items 1–5; trust arrives with real platforms). Does not record usage.
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
    return deny(GateCode.notAnimaSession, `${name} only works in Anima sessions.`)
  }
  if (!meta.sessions.includes(session.kind)) {
    return deny(GateCode.wrongSession, `${name} is not available in the ${session.kind} session; it works in: ${meta.sessions.join(', ')}.`)
  }
  if (!platformFits(meta, session)) {
    return deny(GateCode.wrongPlatform, `${name} belongs to platform "${meta.platform}", which this session cannot use directly.`)
  }
  const allowed = policy.allowedEffects?.[moment.mode]
  if ((meta.modes !== undefined && !meta.modes.includes(moment.mode)) || (allowed !== undefined && !allowed.includes(meta.effect))) {
    return deny(GateCode.night, `${name} is not available while you are ${moment.mode === 'night' ? 'asleep' : 'awake'}${allowed === undefined ? '' : `; now only ${allowed.join(', ')} behaviors work`}.`)
  }
  if ((meta.effect === 'public' || meta.effect === 'irreversible') && !policy.allow.some(rule => rule.behavior === name)) {
    return deny(GateCode.needsApproval, `${name} is a ${meta.effect} action and the owner has not allowed it. You can tell the owner what you wanted to do.`)
  }
  const constraint = meta.constraint?.(args)
  if (constraint !== undefined) return deny(GateCode.notAllowed, constraint)
  if (moment.overBudget && meta.effect !== 'internal') {
    return deny(GateCode.overBudget, `today's token budget for ${moment.mode === 'night' ? 'the night' : 'the day'} is used up. Only rest and other internal behaviors work until it renews.`)
  }
  if (meta.effect === 'initiate') {
    const limit = policy.initiatePerDay
    if (limit !== undefined && moment.initiatesUsed + (meta.cost ?? 1) > limit) {
      return deny(GateCode.overQuota, `you already started ${moment.initiatesUsed} of ${limit} conversations allowed today. Wait until tomorrow, or wait for others to reach out.`)
    }
    if (moment.quiet !== undefined) return deny(GateCode.quietHours, `${moment.quiet}; you cannot start conversations now.`)
    const target = meta.target?.(args)
    if (target !== undefined && !moment.mayInitiate(target)) {
      return deny(GateCode.noConsent, `the owner has not allowed you to start conversations in ${target}.`)
    }
  }
  const over = book.exceeded(call, policy.quotas)
  if (over !== undefined) {
    const minutes = Math.max(1, Math.ceil((over.freeAt - call.now) / 60_000))
    const { rule } = over
    return deny(GateCode.overQuota, `limit of ${rule.limit} per ${describeWindow(rule.windowMinutes)} ${describeScope(rule)} reached for ${name}; next slot in about ${minutes} min. Do not retry now.`)
  }
  return { allowed: true }
}

function deny(code: string, hint: string): Verdict {
  return { allowed: false, code, hint }
}
