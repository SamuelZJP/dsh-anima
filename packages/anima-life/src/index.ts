/**
 * Anima life plugin: her waking sessions, the stimuli that reach them, `wait`,
 * groups, the inbox, her heartbeat, and her sessions through sleep and waking.
 * @module @anima/life
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import { AnimaLife } from './service.ts'
import type { Config as LifeConfig } from './config.ts'

export { consolidationSessionId, wakingSessionId } from './identity.ts'
export { burstText, senderLabel, stimulusRef, stimulusSummary, stimulusText, wakes, whereOf, type ExtraBlock, type MessageStimulus, type PublishedChannel, type Sender, type Stimulus } from './stimulus.ts'
export { Config, resolveLifeConfig } from './config.ts'
export { GroupBuffers, type Glance } from './groups.ts'
export { Inbox, inboxSummary, type HeldMessage as InboxMessage, type InboxEntry } from './inbox.ts'
export { paceMessages, typingMs, type PacingConfig } from './pacing.ts'
export { CONSOLIDATION_PRESET, WAKING_PRESET, WakingSessions, type ArchiveResult, type HostAgent, type ModelChoice, type SessionHost, type WakingOptions, type WakingState } from './waking.ts'
export { nextBeat } from './heartbeat.ts'
export { buildReport, formatSpan, type ChannelLine, type ReportInput } from './report.ts'
export { alarmPrompts, AnimaLife, DshSessionHost, VIEWING_PRESET, type LifeOptions, type StimulusEvent, type ViewRequest } from './service.ts'

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
