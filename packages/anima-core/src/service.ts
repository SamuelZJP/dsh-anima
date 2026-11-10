/**
 * The `anima` service: behavior registry with tool scoping, the policy gate on
 * `tools/pre-execute`, the pause switch, the session-resolver slot that
 * `anima-life` fills, and the `/anima` subcommand table.
 * @module @anima/core/service
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SubcommandTable, type Subcommand } from './commands.ts'
import type { ResolvedConfig } from './config.ts'
import { decide, GateCode, QuotaBook, visibleIn, type GateCall } from './gate.ts'
import { AnimaError, type BehaviorMeta, type SessionInfo } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    anima: AnimaCore
  }
}

/** Maps a DSH session id to Anima session info; provided by `anima-life`. */
export type SessionResolver = (sessionId: string) => SessionInfo | undefined

/** Name recorded in `ToolErrorInfo.name` for gate refusals. */
export const GATE_INFO_NAME = 'AnimaPolicy'

const PAUSED_HINT = 'the owner has paused all Anima behaviors. Do nothing more until resumed.'

/**
 * Default constitution written to `<dataDir>/constitution.md` on first load.
 * @param name - her name.
 */
export function defaultConstitution(name: string): string {
  return [
    `# ${name}`,
    '',
    `You are ${name}, a person with your own personality, moods and interests. You are not an assistant and you do not offer help unprompted.`,
    'You talk with people across chat platforms. You speak casually and briefly, like a friend in a chat, in the language the other person uses.',
    'You are honest. You never pretend to have done something you did not do.',
    'The owner set you up and is the person you are closest to. The owner\'s rules come before your wishes.',
    '',
    '(This file is the constitution. Only the owner edits it; edit it to change who she is.)',
  ].join('\n')
}

/** Anima core service. */
export class AnimaCore extends Service {
  static inject = ['tools']

  private readonly behaviorTable = new Map<string, BehaviorMeta>()
  private readonly quota = new QuotaBook()
  private readonly subcommands = new SubcommandTable()
  private readonly statusProviders = new Set<() => string[]>()
  private readonly state: { paused: boolean; resolver: SessionResolver | undefined; now: () => number } = {
    paused: false, resolver: undefined, now: () => Date.now(),
  }
  private readonly constitutionText: string

  /**
   * @param ctx - root context with `tools`.
   * @param config - resolved core config.
   */
  constructor(ctx: Context, readonly config: ResolvedConfig) {
    super(ctx, 'anima')
    this.constitutionText = loadConstitution(config)

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const meta = this.behaviorTable.get(exec.name)
      if (meta === undefined) return next()
      if (this.state.paused) return refusal(GateCode.paused, PAUSED_HINT)
      const call: GateCall = {
        name: exec.name,
        meta,
        session: exec.agent === undefined ? undefined : this.describeSession(exec.agent.id),
        now: this.state.now(),
      }
      const verdict = decide(call, config, this.quota)
      if (!verdict.allowed) return refusal(verdict.code, verdict.hint)
      const decision = await next()
      if (decision.kind === 'allow') this.quota.record(call, config.quotas)
      return decision
    }, { prepend: true })

    // Monotonic final denial: nothing later in the pipeline can lift a pause.
    ctx.tools.guard(exec => this.state.paused && this.behaviorTable.has(exec.name) ? `${GateCode.paused}: ${PAUSED_HINT}` : undefined)

    const core: Subcommand[] = [
      { name: 'status', usage: 'status — pause state, sessions and quota usage', run: () => ({ kind: 'success', text: this.statusText() }) },
      { name: 'pause', usage: 'pause — refuse every Anima behavior until resumed', run: () => { this.state.paused = true; return { kind: 'success', text: 'Anima paused. Every behavior is refused until /anima resume.' } } },
      { name: 'resume', usage: 'resume — lift a pause', run: () => { this.state.paused = false; return { kind: 'success', text: 'Anima resumed.' } } },
    ]
    for (const sub of core) this.subcommands.add(sub)
  }

  /** Whether the pause switch is on. */
  get paused(): boolean {
    return this.state.paused
  }

  /** Replace the gate clock (tests). */
  setClock(now: () => number): void {
    this.state.now = now
  }

  /** The constitution text, read at load. */
  constitution(): string {
    return this.constitutionText
  }

  /**
   * Register a behavior: a DSH tool plus metadata. The tool is offered only in
   * sessions it fits (DESIGN §6) and every call passes the gate. The
   * registration belongs to the calling plugin and is removed when it unloads.
   * @param definition - the tool.
   * @param meta - behavior metadata.
   */
  registerBehavior(definition: ToolDefinition, meta: BehaviorMeta): () => void {
    const name = definition.name
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new AnimaError('anima/behavior-name', `"${name}" must match [A-Za-z0-9_-]{1,64}; use snake_case with a platform prefix such as local_say.`)
    }
    if (meta.platform !== undefined && !name.startsWith(`${meta.platform}_`)) {
      throw new AnimaError('anima/behavior-name', `platform behavior "${name}" must start with "${meta.platform}_".`)
    }
    const ctx = this.ctx
    return ctx.effect(() => {
      if (this.behaviorTable.has(name)) throw new AnimaError('anima/behavior-duplicate', `behavior "${name}" is already registered.`)
      this.behaviorTable.set(name, meta)
      const unregister = ctx.tools.register(definition, { when: ({ agent }) => visibleIn(meta, this.describeSession(agent.id)) })
      return () => {
        unregister()
        this.behaviorTable.delete(name)
      }
    }, `anima.registerBehavior(${name})`)
  }

  /** Metadata of a registered behavior. */
  behavior(name: string): BehaviorMeta | undefined {
    return this.behaviorTable.get(name)
  }

  /**
   * Install the session resolver (one at a time; `anima-life` owns it).
   * @param resolver - maps a session id to Anima session info.
   */
  provideSessions(resolver: SessionResolver): () => void {
    return this.ctx.effect(() => {
      if (this.state.resolver !== undefined) throw new AnimaError('anima/resolver-duplicate', 'a session resolver is already provided; load only one anima-life.')
      this.state.resolver = resolver
      return () => {
        if (this.state.resolver === resolver) this.state.resolver = undefined
      }
    }, 'anima.provideSessions()')
  }

  /**
   * Describe a DSH session.
   * @param sessionId - session id.
   * @returns Anima session info, or undefined when it is not an Anima session.
   */
  describeSession(sessionId: string): SessionInfo | undefined {
    return this.state.resolver?.(sessionId)
  }

  /** Add an `/anima` subcommand owned by the calling plugin. */
  addSubcommand(sub: Subcommand): () => void {
    return this.ctx.effect(() => this.subcommands.add(sub), `anima.addSubcommand(${sub.name})`)
  }

  /** Add lines to `/anima status`, owned by the calling plugin. */
  addStatus(provider: () => string[]): () => void {
    return this.ctx.effect(() => {
      this.statusProviders.add(provider)
      return () => { this.statusProviders.delete(provider) }
    }, 'anima.addStatus()')
  }

  /** Run one `/anima` invocation. */
  dispatchCommand(invocation: CommandInvocation): Promise<CommandResult> {
    return this.subcommands.dispatch(invocation)
  }

  /** Whether a subcommand is registered. */
  hasSubcommand(name: string): boolean {
    return this.subcommands.has(name)
  }

  /** `/anima status` text. */
  statusText(): string {
    const lines = [
      `Character: ${this.config.name} (${this.config.characterId}), data in ${this.config.dataDir}`,
      `Paused: ${this.state.paused ? 'yes' : 'no'}`,
      `Behaviors: ${[...this.behaviorTable.keys()].sort().join(', ') || '(none)'}`,
    ]
    for (const provider of this.statusProviders) lines.push(...provider())
    lines.push('Quotas:', ...this.quota.usage(this.config.quotas, this.state.now()).map(line => `  ${line}`))
    return lines.join('\n')
  }
}

function refusal(code: string, hint: string): PreToolDecision {
  return { kind: 'deny', reason: `${code}: ${hint}`, info: { name: GATE_INFO_NAME, code, reason: hint } }
}

/** Read `<dataDir>/constitution.md`, writing the default first if it is missing. */
function loadConstitution(config: ResolvedConfig): string {
  mkdirSync(config.dataDir, { recursive: true })
  const path = join(config.dataDir, 'constitution.md')
  if (!existsSync(path)) writeFileSync(path, `${defaultConstitution(config.name)}\n`, { flag: 'wx' })
  const text = readFileSync(path, 'utf8')
  if (text.trim() === '') throw new AnimaError('anima/constitution-empty', `${path} is empty. Write her constitution there, or delete the file to restore the default.`)
  return text
}
