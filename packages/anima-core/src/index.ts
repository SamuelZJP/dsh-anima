/**
 * Anima core plugin: the `anima` service (her body: behaviors, the body
 * check, clock, state, sleep, goals, self-model, resolver slots) and `anima_ping`.
 * The `/anima` owner command is outside the persona, in `anima-guard`.
 * @module @anima/core
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, resolveConfig, type Config as CoreConfig } from './config.ts'
import { AnimaCore } from './service.ts'

export * from './types.ts'
export { DEFAULT_MODEL, expandHome, resolveConfig, type ModeConfig, type ModelRoute, type ResolvedConfig } from './config.ts'
export { bodyCheck, GateCode, quotaExempt, visibleIn, type BodyCall, type BodyMoment, type BodyVerdict } from './gate.ts'
export { AnimaClock, formatLocal, formatStamp, localDate, nextAtClock, parseClockTime, parseLocalDateTime, parseWhen, type ClockConfig } from './clock.ts'
export { asleepAt, dayKey, dayStart, earliestBedtime, inWindow, latestBedtime, modeAt, nextWake, phaseAt, resolveRhythm, wokenUntil, type Mode, type Phase, type Rhythm, type RhythmConfig, type SleepRecord } from './rhythm.ts'
export { advance, DEFAULT_NEEDS, describeNeeds, feel, initialState, satisfaction, satisfy, spendTurn, type EnergyConfig, type MoodConfig, type NeedSpec, type SelfState, type StateModel } from './state.ts'
export { Ledger, readJson, writeJson } from './ledger.ts'
export { describeGoal, GoalStore, type Goal, type GoalOwner, type GoalStatus } from './goals.ts'
export type { Subcommand } from './commands.ts'
export type { ActivityRecord, GateRecord, NewActivity, OwnerRecord, OwnerSource, PlatformRecord, SleepActivity, WakeRecord } from './records.ts'
export { optionalStringArg, stringArg, type OwnerAction, type OwnerView, type PlatformProvider, type PlatformView, type ViewParams } from './owner.ts'
export { SELF_SECTIONS, SelfModelStore, type SelfDiff, type SelfEntry, type SelfModelOptions, type SelfSection } from './selfmodel.ts'
export { EFFECT_NAMES, HER_WORLD, placeName, placeText, platformName, primerText, SESSION_RULES, type PlaceChannel, type PlaceFacts, type PlaceReach, type PlaceTool } from './primer.ts'
export { AnimaCore, defaultConstitution, describeDiff, GATE_INFO_NAME, type BedtimeInfo, type BehaviorEvent, type ChannelInfo, type ChannelResolver, type SessionResolver } from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-core'
/** Services used by the plugin. */
export const inject = ['tools']

/** Plugin config. */
export type Config = CoreConfig
/** Plugin config schema. */
export const Config = ConfigSchema

/** Name of the integration probe tool. */
export const PING_TOOL = 'anima_ping'

/**
 * Register Anima core contributions.
 * @param ctx - root context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  ctx.plugin(AnimaCore, resolveConfig(config))

  ctx.tools.register(defineTool({
    name: PING_TOOL,
    description: 'Check that the Anima plugin is loaded. Returns "pong", echoing the optional message.',
    parameters: {
      message: { type: 'string', description: 'Optional text to echo back.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pong: { type: 'boolean', required: true, description: 'Always true.' },
          echo: { type: 'string', description: 'The message argument, when given.' },
          at: { type: 'string', required: true, description: 'Host time of the call, ISO 8601.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.echo === undefined ? 'pong' : `pong: ${value.echo}` }],
    },
    async execute(args) {
      return {
        pong: true,
        ...args.message === undefined ? {} : { echo: args.message },
        at: new Date().toISOString(),
      }
    },
  }))
}
