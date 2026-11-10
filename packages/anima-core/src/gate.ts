/**
 * The policy gate's decisions (DESIGN §10). Pure functions plus an in-memory
 * sliding-window quota book; the `tools/pre-execute` listener lives in the service.
 * @module @anima/core/gate
 */

import type { AllowRule, QuotaRule } from './config.ts'
import type { BehaviorMeta, SessionInfo } from './types.ts'

/** Gate outcome. A refusal carries a stable `code` and a hint she can act on. */
export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Policy the gate applies. */
export interface Policy {
  readonly quotas: readonly QuotaRule[]
  readonly allow: readonly AllowRule[]
}

/** One gated behavior call. */
export interface GateCall {
  /** Tool name. */
  readonly name: string
  readonly meta: BehaviorMeta
  /** The calling session, or `undefined` when it is not an Anima session. */
  readonly session: SessionInfo | undefined
  /** Epoch milliseconds. */
  readonly now: number
}

/** Refusal codes the gate emits. */
export const GateCode = {
  notAnimaSession: 'anima/not-anima-session',
  wrongSession: 'anima/wrong-session',
  wrongPlatform: 'anima/wrong-platform',
  needsApproval: 'anima/needs-approval',
  overQuota: 'anima/over-quota',
  paused: 'anima/paused',
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
export function visibleIn(meta: BehaviorMeta, session: SessionInfo | undefined): boolean {
  return session !== undefined && meta.sessions.includes(session.kind) && platformFits(meta, session)
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
 * platform, approval-class effects, quotas (DESIGN §10 items 1–3; time, consent
 * and trust arrive in later phases). Does not record usage.
 * @param call - the call.
 * @param policy - owner policy.
 * @param book - quota counters.
 * @returns the verdict.
 */
export function decide(call: GateCall, policy: Policy, book: QuotaBook): Verdict {
  const { meta, session, name } = call
  if (session === undefined) {
    return deny(GateCode.notAnimaSession, `${name} only works in Anima sessions.`)
  }
  if (!meta.sessions.includes(session.kind)) {
    return deny(GateCode.wrongSession, `${name} is not available in the ${session.kind} session; it works in: ${meta.sessions.join(', ')}.`)
  }
  if (!platformFits(meta, session)) {
    return deny(GateCode.wrongPlatform, `${name} belongs to platform "${meta.platform}", which this session cannot use directly.`)
  }
  if ((meta.effect === 'public' || meta.effect === 'irreversible') && !policy.allow.some(rule => rule.behavior === name)) {
    return deny(GateCode.needsApproval, `${name} is a ${meta.effect} action and the owner has not allowed it. You can tell the owner what you wanted to do.`)
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
