/**
 * Anima life plugin: stimulus routing, deterministic session identity,
 * conversation, Self and triage sessions, the heartbeat loop and open_conversation.
 * @module @anima/life
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import { AnimaLife } from './service.ts'
import type { Config as LifeConfig } from './config.ts'

export { consolidationSessionId, conversationSessionId, groupTriageSessionId, selfSessionId, triageSessionId, viewingSessionId } from './identity.ts'
export { reminderText, TurnCloser, type StopAction } from './closer.ts'
export { answerLine, burstText, route, senderLabel, wakes, stimulusRef, stimulusSummary, stimulusText, type ExtraBlock, type PublishedChannel, type Route, type Sender, type Stimulus } from './stimulus.ts'
export { batchText, GroupTriage, type Batch, type Decision, type MessageStimulus, type TriageHooks, type TriageOptions } from './group-triage.ts'
export { Config, resolveLifeConfig } from './config.ts'
export { Inbox, inboxSummary, type HeldMessage as InboxMessage, type InboxEntry } from './inbox.ts'
export { paceMessages, typingMs, type PacingConfig } from './pacing.ts'
export { PRESETS, SessionRouter, type HostAgent, type ModelChoice, type RouterOptions, type SessionHost } from './router.ts'
export { nextHeartbeat, type NextHeartbeat, type ScheduleInput } from './heartbeat.ts'
export { answeringIntent, describeOutcome, IntentTracker, OUTBOX_CANCELLED, OUTBOX_EXPIRED, type Intent, type Outcome, type OutcomeKind, type TrackerState } from './intent.ts'
export { buildReport, formatSpan, type ChannelLine, type ReportInput } from './report.ts'
export { alarmPrompts, AnimaLife, DshSessionHost, type LifeOptions, type StimulusEvent, type ViewRequest } from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-life'
/** Services used by the plugin. */
export const inject = ['anima']

/**
 * Mount the life service.
 * @param ctx - root context.
 */
export function apply(ctx: Context, config: Partial<LifeConfig> | undefined): void {
  ctx.plugin(AnimaLife, { config: config ?? {} })
}
