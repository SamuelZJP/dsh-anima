/**
 * Anima life plugin: stimulus routing, deterministic session identity,
 * conversation, Self and triage sessions, the heartbeat loop and open_conversation.
 * @module @anima/life
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import { AnimaLife } from './service.ts'

export { conversationSessionId, selfSessionId, triageSessionId } from './identity.ts'
export { route, stimulusRef, stimulusSummary, stimulusText, type PublishedChannel, type Route, type Sender, type Stimulus } from './stimulus.ts'
export { PRESETS, SessionRouter, type HostAgent, type ModelChoice, type RouterOptions, type SessionHost } from './router.ts'
export { nextHeartbeat, type NextHeartbeat, type ScheduleInput } from './heartbeat.ts'
export { describeOutcome, IntentTracker, type Intent, type Outcome, type OutcomeKind, type TrackerState } from './intent.ts'
export { buildReport, formatSpan, type ChannelLine, type ReportInput } from './report.ts'
export { alarmPrompts, AnimaLife, DshSessionHost } from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-life'
/** Services used by the plugin. */
export const inject = ['anima']

/**
 * Mount the life service.
 * @param ctx - root context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(AnimaLife)
}
