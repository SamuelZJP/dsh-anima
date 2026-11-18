/**
 * Anima guard plugin: everything outside the persona that acts on her (the
 * safety gate, approvals, the outbox hold, budgets, pause, the activity log
 * and the owner surface). The persona packages never import it.
 * @module @anima/guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import type {} from '@anima/life'
import type {} from '@deepseek-ai/dsh-commands'
import { AnimaGuard } from './service.ts'
import type { Config as GuardConfig } from './config.ts'

export { ActivityLog, summarize, type DayCounts, type DaySummary } from './activity.ts'
export { ApprovalBroker, parseOwnerReply, type ApprovalAnswer, type OwnerReply, type PendingApproval } from './approvals.ts'
export { parseSubcommand, SubcommandTable } from './commands.ts'
export { Config, DEFAULT_LIMITS, DEFAULT_QUOTAS, onAllowlist, resolveGuardConfig, type AllowlistEntry, type AllowRule, type ApproveRule, type LimitRule, type QuotaRule, type QuotaScope, type ResolvedGuardConfig, type TimeWindow } from './config.ts'
export { decide, GuardCode, OPEN_MOMENT, OUTSIDE, QuotaBook, quotaHint, windowZh, type GateCall, type GateMoment, type Policy, type Verdict } from './gate.ts'
export { Outbox, platformOf, type HeldMessage, type HoldOptions, type HoldResult } from './outbox.ts'
export { OwnerRegistry } from './owner.ts'
export { AnimaGuard, billableTokens, GUARD_INFO_NAME } from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-guard'
/** Services used by the plugin. */
export const inject = ['anima', 'tools']

/**
 * Mount the guard.
 * @param ctx - root context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Partial<GuardConfig> | undefined): void {
  ctx.plugin(AnimaGuard, config ?? {})
}
