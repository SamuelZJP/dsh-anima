/**
 * Anima life plugin: stimulus routing, deterministic session identity,
 * conversation and Self sessions (Phase 1; heartbeat comes in Phase 2).
 * @module @anima/life
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@anima/core'
import { AnimaLife } from './service.ts'

export { conversationSessionId, selfSessionId } from './identity.ts'
export { route, stimulusSummary, stimulusText, type PublishedChannel, type Route, type Sender, type Stimulus } from './stimulus.ts'
export { PRESETS, SessionRouter, type HostAgent, type RouterOptions, type SessionHost } from './router.ts'
export { AnimaLife, DshSessionHost } from './service.ts'

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
