/**
 * Her waking sessions (docs/design/life.md): one DSH session per period of
 * wakefulness. When she falls asleep the next one is prepared and her alarms
 * move into it; the ended one is archived once its last turn is over. Plumbing
 * over a small {@link SessionHost}, so it is testable without DSH.
 * @module @anima/life/waking
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AnimaError, type SessionInfo } from '@anima/core'
import { wakingSessionId } from './identity.ts'
import type { ExtraBlock } from './stimulus.ts'

/** Preset of her waking sessions (bundle/presets/waking.patch.yml). */
export const WAKING_PRESET = 'anima-waking'
/** Preset of sleep's consolidation sessions. */
export const CONSOLIDATION_PRESET = 'anima-consolidation'

/** A model route to select for a session's next requests. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
}

/** The part of a live DSH Agent life uses. */
export interface HostAgent {
  readonly id: string
}

/** What DSH says when asked to archive a session. */
export type ArchiveResult = 'archived' | 'busy'

/** A person in an arrival, for the message source (logged, not model-visible). */
export interface SourcePerson {
  readonly platform: string
  readonly userId: string
  readonly name: string
  readonly owner?: true
}

/** One message delivered into a session. */
export interface Delivery {
  /** Model-facing text. */
  readonly text: string
  /** One-line summary for the collapsed context row. */
  readonly summary: string
  /** Stimulus type, recorded in the source. */
  readonly stimulus: string
  /** Reference recorded in the source. */
  readonly ref?: string | undefined
  /** Content blocks after the text. */
  readonly extra?: readonly ExtraBlock[] | undefined
  /** Channel key of the arrival, recorded in the source (where it came from). */
  readonly channel?: string | undefined
  /** Who wrote in the arrival, recorded in the source. */
  readonly people?: readonly SourcePerson[] | undefined
}

/** One event of a session's durable log, as DSH's persistence returns it. */
export interface LogEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Session operations life needs from DSH. */
export interface SessionHost<A extends HostAgent = HostAgent> {
  /** Live agent of an existing session, or undefined when no session has the id. */
  resolve(sessionId: string): Promise<A | undefined>
  /** Create a session under exactly this id. Returns the id DSH used. */
  create(sessionId: string, spec: { agentPreset: string; cwd: string }): Promise<string>
  /** Whether the session is archived. */
  isArchived(sessionId: string): boolean
  /** Archive a session (its log flushed first); `busy` when DSH refuses because a turn runs or an alarm still targets it. */
  archive(sessionId: string): Promise<ArchiveResult>
  /** The whole durable log of a session (an archived one included). */
  readLog(sessionId: string): Promise<LogEvent[]>
  /** Move every pending alarm that targets one session to another. Returns how many moved. */
  moveAlarms(from: string, to: string): Promise<number>
  /** Set a session's title. */
  rename(agent: A, title: string): void
  /** Deliver a message that starts a turn when idle, or joins the running one at its next step. */
  deliver(agent: A, message: Delivery): Promise<void>
  /** Queue context for the agent's next turn without starting one. */
  inject(agent: A, message: Delivery): Promise<void>
  /** Cancel the agent's running turn, if any. */
  cancel(agent: A): void
  /** Select the model of the agent's next requests. */
  selectModel(agent: A, choice: ModelChoice): void
}

/** Durable state of her waking sessions, kept in `life.json`. */
export interface WakingState {
  /** The session she is awake in, or will wake in while asleep. */
  current?: string | undefined
  /** Whether `current` has had its first arrival (an unopened one was prepared at sleep). */
  opened?: boolean | undefined
  /** Ended sessions still waiting to be archived (their last turn was running). */
  pending: string[]
  /** Earlier waking sessions, newest last (so their ids still read as hers). */
  past: string[]
}

/** Earlier waking session ids kept in `life.json`. */
const PAST_KEPT = 60

/** Options of {@link WakingSessions}. */
export interface WakingOptions {
  readonly characterId: string
  readonly dataDir: string
  readonly model: ModelChoice
  /** Sidebar title of a waking session opened at a time on her clock. */
  readonly title: (at: number) => string
  /** Persist the state after a change. */
  readonly save: () => void
  readonly warn: (message: string) => void
}

/** Her waking sessions. */
export class WakingSessions<A extends HostAgent = HostAgent> {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly host: SessionHost<A>, readonly state: WakingState, private readonly options: WakingOptions) {}

  /** The current waking session id, if there is one. */
  get current(): string | undefined {
    return this.state.current
  }

  /** Whether the current session has had its first arrival. */
  get opened(): boolean {
    return this.state.opened === true
  }

  /**
   * Describe a session id.
   * @returns `waking` (current or an earlier one), or undefined for any other session.
   */
  describe(sessionId: string): SessionInfo | undefined {
    if (sessionId === this.state.current) return { kind: 'waking', current: true }
    if (this.state.pending.includes(sessionId) || this.state.past.includes(sessionId)) return { kind: 'waking', current: false }
    return undefined
  }

  /** Serialize lifecycle steps: create, prepare and archive never interleave. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(step)
    this.chain = next
    return next
  }

  /**
   * The current session's live agent, creating it when there is none (her
   * first waking in this data directory, or a session DSH lost).
   * @param at - now, on her clock (names a new session).
   */
  ensureCurrent(at: number): Promise<A> {
    return this.serial(async () => {
      const id = this.state.current ?? wakingSessionId(this.options.characterId, at)
      if (this.state.current === undefined) {
        this.state.current = id
        this.state.opened = false
        this.options.save()
      }
      return this.make(id)
    })
  }

  private async make(id: string): Promise<A> {
    if (this.host.isArchived(id)) throw new AnimaError('anima/session-archived', `waking session ${id} is archived; nothing can be delivered into it.`)
    const existing = await this.host.resolve(id)
    if (existing !== undefined) return existing
    const cwd = join(this.options.dataDir, 'waking')
    mkdirSync(cwd, { recursive: true })
    const created = await this.host.create(id, { agentPreset: WAKING_PRESET, cwd })
    if (created !== id) throw new AnimaError('anima/session-id-mismatch', `DSH created session ${created} instead of ${id}. Report this; Anima relies on chosen ids.`)
    const agent = await this.host.resolve(id)
    if (agent === undefined) throw new AnimaError('anima/session-missing', `session ${id} was created but cannot be resolved.`)
    this.host.selectModel(agent, this.options.model)
    this.host.rename(agent, 'Anima · next waking')
    return agent
  }

  /** The current session had its first arrival: title it with the time she woke. */
  markOpened(agent: A, at: number): void {
    if (this.state.opened === true) return
    this.state.opened = true
    this.options.save()
    this.host.rename(agent, this.options.title(at))
  }

  /**
   * She fell asleep: prepare the next waking's session, move her alarms into
   * it, and archive the ended one (now, or once its last turn ends).
   * @param at - when she fell asleep, on her clock.
   * @param busy - whether a session is still running a turn.
   * @returns the ended and the prepared session ids, how many alarms moved, and the sessions archived now.
   */
  sleep(at: number, busy: (sessionId: string) => boolean): Promise<{ ended: string | undefined; next: string; alarms: number; archived: string[] }> {
    // The next waking is hers from this moment: nothing that arrives meanwhile goes to the ended one.
    const ended = this.state.current
    const next = wakingSessionId(this.options.characterId, at)
    if (ended !== undefined && ended !== next && !this.state.pending.includes(ended)) this.state.pending.push(ended)
    this.state.current = next
    this.state.opened = false
    this.options.save()
    return this.serial(async () => {
      await this.make(next)
      const alarms = ended !== undefined && ended !== next ? await this.host.moveAlarms(ended, next) : 0
      const archived = await this.archiveNow(busy)
      return { ended, next, alarms, archived }
    })
  }

  /**
   * Archive every ended session whose last turn is over. A session DSH still
   * refuses (a turn runs) stays pending for the next try.
   * @returns the ids archived now.
   */
  archivePending(busy: (sessionId: string) => boolean): Promise<string[]> {
    return this.serial(() => this.archiveNow(busy))
  }

  private async archiveNow(busy: (sessionId: string) => boolean): Promise<string[]> {
    const done: string[] = []
    for (const id of [...this.state.pending]) {
      if (busy(id)) continue
      let result: ArchiveResult
      try {
        result = this.host.isArchived(id) ? 'archived' : await this.host.archive(id)
      } catch (error: unknown) {
        this.options.warn(`anima: could not archive waking session ${id}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (result !== 'archived') continue
      this.state.pending = this.state.pending.filter(p => p !== id)
      this.state.past = [...this.state.past.filter(p => p !== id), id].slice(-PAST_KEPT)
      done.push(id)
    }
    if (done.length > 0) this.options.save()
    return done
  }
}
