/**
 * Goals: kept by her through tools, or set by the owner from outside. She may
 * close any of them.
 * Stored in `<dataDir>/goals.json`.
 * @module @anima/core/goals
 */

import { formatLocal } from './clock.ts'
import { readJson, writeJson } from './ledger.ts'
import { AnimaError } from './types.ts'

/** Who set a goal. */
export type GoalOwner = 'her' | 'owner'
/** Goal status. */
export type GoalStatus = 'open' | 'done' | 'dropped'

/** One goal. */
export interface Goal {
  id: string
  text: string
  owner: GoalOwner
  status: GoalStatus
  /** Due time, epoch ms on her clock. */
  due?: number
  notes: { at: number; text: string }[]
  createdAt: number
  closedAt?: number
  closeReason?: string
}

interface GoalFile {
  next: number
  goals: Goal[]
}

/** File-backed goal store. */
export class GoalStore {
  private readonly data: GoalFile

  /** @param path - JSON file path; `undefined` keeps goals in memory (tests). */
  constructor(private readonly path: string | undefined) {
    this.data = (path === undefined ? undefined : readJson<GoalFile>(path)) ?? { next: 1, goals: [] }
  }

  private save(): void {
    if (this.path !== undefined) writeJson(this.path, this.data)
  }

  /** All goals, newest last. */
  all(): readonly Goal[] {
    return this.data.goals
  }

  /** Open goals, due soonest first, undated last. */
  open(): Goal[] {
    return this.data.goals.filter(goal => goal.status === 'open')
      .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.createdAt - b.createdAt)
  }

  /** Find a goal or throw `anima/goal-not-found`. */
  get(id: string): Goal {
    const goal = this.data.goals.find(entry => entry.id === id)
    if (goal === undefined) throw new AnimaError('anima/goal-not-found', `no goal "${id}". Open goals: ${this.open().map(g => g.id).join(', ') || 'none'}.`)
    return goal
  }

  /** Add an open goal. */
  add(input: { text: string; owner: GoalOwner; due?: number | undefined; now: number }): Goal {
    const text = input.text.trim()
    if (text === '') throw new AnimaError('anima/goal-empty', 'a goal needs text.')
    const goal: Goal = { id: `g${this.data.next++}`, text, owner: input.owner, status: 'open', notes: [], createdAt: input.now, ...input.due === undefined ? {} : { due: input.due } }
    this.data.goals.push(goal)
    this.save()
    return goal
  }

  /** Add a progress note to an open goal. */
  note(id: string, text: string, now: number): Goal {
    const goal = this.get(id)
    if (goal.status !== 'open') throw new AnimaError('anima/goal-closed', `goal ${id} is already ${goal.status}.`)
    goal.notes.push({ at: now, text: text.trim() })
    this.save()
    return goal
  }

  /**
   * Close a goal.
   * @param by - who closes it.
   */
  close(id: string, input: { status: 'done' | 'dropped'; reason?: string | undefined; by: GoalOwner; now: number }): Goal {
    const goal = this.get(id)
    if (goal.status !== 'open') throw new AnimaError('anima/goal-closed', `goal ${id} is already ${goal.status}.`)
    const reason = input.reason?.trim()
    goal.status = input.status
    goal.closedAt = input.now
    if (reason !== undefined && reason !== '') goal.closeReason = reason
    this.save()
    return goal
  }
}

/**
 * One line per goal for reports and commands.
 * @returns e.g. `g2 [owner] ask about the exam (due 2026-11-10 21:00)`.
 */
export function describeGoal(goal: Goal): string {
  const due = goal.due === undefined ? '' : ` (due ${formatLocal(goal.due)})`
  const status = goal.status === 'open' ? '' : ` — ${goal.status}${goal.closeReason === undefined ? '' : `: ${goal.closeReason}`}`
  const note = goal.notes.at(-1)
  return `${goal.id} [${goal.owner === 'owner' ? 'owner' : 'yours'}] ${goal.text}${due}${status}${note === undefined ? '' : ` — last note: ${note.text}`}`
}
