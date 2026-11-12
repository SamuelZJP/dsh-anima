/**
 * Anima life configuration: group triage and the outbox.
 * @module @anima/life/config
 */

import { AnimaError, type ModelRoute } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** Plugin config of `@anima/life`. */
export interface Config {
  /** Group triage (DESIGN §5). */
  groupTriage: {
    /** Real seconds a group's buffer of unaddressed messages stays open. */
    windowSeconds: number
    /** A buffer with this many messages closes at once. */
    maxBatch: number
    /** Real seconds a batch may stay undecided before it is remembered. */
    timeoutSeconds: number
    /** Model of group-triage turns; the day triage model when omitted. */
    model?: Partial<ModelRoute> | undefined
  }
  /** The outbox for messages she starts (DESIGN §10). */
  outbox: {
    /** Real seconds her initiated message waits before it goes out; 0 sends at once. */
    delaySeconds: number
    /** Tell the owner on the owner line about each held message (not for the owner's own chat). */
    notifyOwner: boolean
    /** Real minutes a held message waits for its platform to come back before it expires. */
    offlineHoldMinutes: number
  }
  /** Platform health as adapters report it. */
  platforms: {
    /** Real seconds a platform must stay offline before her Self session is told (short drops stay quiet). */
    noticeAfterSeconds: number
  }
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  groupTriage: z.object({
    windowSeconds: z.number().min(0.01).default(60).description('Real seconds a group\'s buffer of unaddressed messages stays open.'),
    maxBatch: z.natural().min(1).default(30).description('A buffer with this many messages closes at once.'),
    timeoutSeconds: z.number().min(0.01).default(300).description('Real seconds a batch may stay undecided before it is remembered.'),
    model: z.object({ provider: z.string(), model: z.string() }).description('Model of group-triage turns (provider and model); the day triage model when omitted.'),
  }).description('Group triage: buffered group chatter sorted into ignore, remember, or wake.'),
  outbox: z.object({
    delaySeconds: z.number().min(0).default(45).description('Real seconds her initiated message waits before it goes out; 0 sends at once.'),
    notifyOwner: z.boolean().default(false).description('Tell the owner on the owner line about each held message (not for the owner\'s own chat).'),
    offlineHoldMinutes: z.number().min(0.01).default(30).description('Real minutes a held message waits for its platform to come back (after the delay) before it expires; she is told when it does.'),
  }).description('Outbox for messages she starts on her own.'),
  platforms: z.object({
    noticeAfterSeconds: z.number().min(0).default(60).description('Real seconds a platform must stay offline before her Self session gets a notice; it gets another when the platform is back.'),
  }).description('Platform health notices to her Self session.'),
}) as z<Config>

/**
 * Validate life config. Fails loud with `anima/config-invalid`.
 * @param input - raw config.
 */
export function resolveLifeConfig(input: Partial<Config> | undefined): Readonly<Config> {
  let config: Config
  try {
    config = Config((input ?? {}) as Config)
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-life row in cordis.yml.`)
  }
  const model = config.groupTriage.model
  if (model !== undefined && (model.provider === undefined) !== (model.model === undefined)) {
    throw new AnimaError('anima/config-invalid', 'groupTriage.model needs both provider and model, or neither.')
  }
  return Object.freeze(config)
}

/** The group-triage model route, when the config sets one. */
export function groupTriageModel(config: Readonly<Config>): ModelRoute | undefined {
  const { provider, model } = config.groupTriage.model ?? {}
  return provider === undefined || model === undefined ? undefined : { provider, model }
}
