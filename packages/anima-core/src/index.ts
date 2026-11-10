/**
 * Anima core plugin: the `anima` service (behaviors, policy gate, pause,
 * session resolver slot), the `/anima` owner command, and `anima_ping`.
 * @module @anima/core
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, resolveConfig, type Config as CoreConfig } from './config.ts'
import { AnimaCore } from './service.ts'

export * from './types.ts'
export { DEFAULT_MODEL, DEFAULT_QUOTAS, expandHome, resolveConfig, type AllowRule, type InitiateConfig, type ModeConfig, type ModelRoute, type QuotaRule, type QuotaScope, type ResolvedConfig, type TimeWindow } from './config.ts'
export { decide, GateCode, OPEN_MOMENT, QuotaBook, visibleIn, type GateCall, type GateMoment, type Policy, type Verdict } from './gate.ts'
export { AnimaClock, formatLocal, formatStamp, localDate, nextAtClock, parseClockTime, parseLocalDateTime, parseWhen, type ClockConfig } from './clock.ts'
export { dayKey, inWindow, modeAt, nextWake, phaseAt, resolveRhythm, type Mode, type Phase, type Rhythm, type RhythmConfig } from './rhythm.ts'
export { advance, DEFAULT_NEEDS, describeNeeds, feel, initialState, satisfaction, satisfy, spendTurn, type EnergyConfig, type MoodConfig, type NeedSpec, type SelfState, type StateModel } from './state.ts'
export { billableTokens, emptyDay, Ledger, readJson, writeJson, type DayLedger } from './ledger.ts'
export { describeGoal, GoalStore, type Goal, type GoalOwner, type GoalStatus } from './goals.ts'
export { parseSubcommand, SubcommandTable, type Subcommand } from './commands.ts'
export { AnimaCore, defaultConstitution, GATE_INFO_NAME, type ChannelResolver, type SessionResolver } from './service.ts'

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
/** Name of the owner command. */
export const COMMAND = 'anima'

/**
 * Register Anima core contributions.
 * @param ctx - root context.
 * @param config - plugin config.
 */
export function apply(ctx: Context, config: Partial<Config> | undefined): void {
  ctx.plugin(AnimaCore, resolveConfig(config))

  ctx.inject(['anima', 'commands'], (ctx) => {
    ctx.effect(() => ctx.commands.register({
      name: COMMAND,
      description: 'Anima owner controls: /anima help lists subcommands',
      input: { hint: 'status | pause | resume | goal … | chat <text> | self [text] | help' },
      handler: invocation => ctx.anima.dispatchCommand(invocation),
    }), 'anima.command')
  })

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
