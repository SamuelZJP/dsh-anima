/**
 * Self state (docs/design/body.md): needs, energy, mood and sleep pressure. Code moves these numbers only
 * by time and by declared behavior effects; it never reads message words. Pure.
 * @module @anima/core/state
 */

import { INITIAL_PRESSURE, movePressure, type SleepGenes } from './sleep.ts'

/** One need, defined in config. */
export interface NeedSpec {
  /** Short name, e.g. `connect`. */
  name: string
  /** One line shown to her. */
  description: string
  /** Starting value, 0–1. */
  baseline: number
  /** Upward drift per awake hour. */
  driftPerHour: number
  /** Behavior name (or `prefix_*`) → amount the need drops when it succeeds. */
  satisfiedBy: Record<string, number>
}

/** Energy tuning. */
export interface EnergyConfig {
  /** Drain per awake hour. */
  drainPerHour: number
  /** Drain per action turn. */
  perTurn: number
  /** Restore per sleeping hour. */
  restorePerHour: number
}

/** Mood tuning. */
export interface MoodConfig {
  /** Baseline valence, -1–1. */
  valence: number
  /** Baseline arousal, 0–1. */
  arousal: number
  /** Half-life of the drift back to baseline, hours. */
  halfLifeHours: number
}

/** Everything the state math needs. */
export interface StateModel {
  readonly needs: readonly NeedSpec[]
  readonly energy: EnergyConfig
  readonly mood: MoodConfig
  readonly sleep: SleepGenes
  /** Whether she is asleep now: her phase changes only when she falls asleep or wakes, never inside {@link advance}. */
  readonly asleep: () => boolean
}

/** Her current numbers. */
export interface SelfState {
  needs: Record<string, number>
  energy: number
  mood: { valence: number; arousal: number }
  /** Sleep pressure, 0–1 (docs/design/body.md). */
  sleepPressure: number
  /** Simulated time these numbers describe. */
  updatedAt: number
}

/** Default needs (DESIGN §7), starting values to be tuned from test runs. */
export const DEFAULT_NEEDS: NeedSpec[] = [
  { name: 'connect', description: 'being with people you care about', baseline: 0.4, driftPerHour: 0.05, satisfiedBy: { qq_say: 0.3 } },
  { name: 'curiosity', description: 'finding out new things', baseline: 0.3, driftPerHour: 0.03, satisfiedBy: { bili_view_closely: 0.25, bili_watch: 0.15, 'bili_*': 0.05 } },
  { name: 'expression', description: 'making or sharing something of your own', baseline: 0.3, driftPerHour: 0.02, satisfiedBy: {} },
  { name: 'rest', description: 'stopping and resting', baseline: 0.2, driftPerHour: 0.04, satisfiedBy: { rest: 0.1 } },
  { name: 'order', description: 'keeping your workspace, goals and memory tidy', baseline: 0.2, driftPerHour: 0.01, satisfiedBy: { 'goals_*': 0.1 } },
]

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const STEP_MS = 5 * 60_000

/**
 * Fresh state at a time: every need at baseline, full energy, baseline mood.
 * @param model - state model.
 * @param now - epoch ms.
 */
export function initialState(model: StateModel, now: number): SelfState {
  return {
    needs: Object.fromEntries(model.needs.map(need => [need.name, need.baseline])),
    energy: 1,
    mood: { valence: model.mood.valence, arousal: model.mood.arousal },
    sleepPressure: INITIAL_PRESSURE,
    updatedAt: now,
  }
}

/**
 * Move the state forward in time, in steps of at most five minutes, in her
 * current phase: awake, needs drift, energy drains and sleep pressure rises;
 * asleep, energy restores and sleep pressure falls; mood decays toward its
 * baseline throughout.
 * @param state - state at `state.updatedAt`.
 * @param to - target time; earlier times leave the state unchanged.
 * @param model - state model.
 * @returns a new state at `to`.
 */
export function advance(state: SelfState, to: number, model: StateModel): SelfState {
  const next: SelfState = { needs: { ...state.needs }, energy: state.energy, mood: { ...state.mood }, sleepPressure: state.sleepPressure ?? INITIAL_PRESSURE, updatedAt: state.updatedAt }
  for (const need of model.needs) next.needs[need.name] ??= need.baseline
  for (const name of Object.keys(next.needs)) if (!model.needs.some(need => need.name === name)) delete next.needs[name]
  const asleep = model.asleep()
  let t = state.updatedAt
  while (t < to) {
    const step = Math.min(STEP_MS, to - t)
    const hours = step / 3_600_000
    if (asleep) {
      next.energy = clamp(next.energy + model.energy.restorePerHour * hours)
    } else {
      for (const need of model.needs) next.needs[need.name] = clamp(next.needs[need.name]! + need.driftPerHour * hours)
      next.energy = clamp(next.energy - model.energy.drainPerHour * hours)
    }
    next.sleepPressure = movePressure(next.sleepPressure, hours, asleep, model.sleep)
    const decay = model.mood.halfLifeHours > 0 ? 0.5 ** (hours / model.mood.halfLifeHours) : 0
    next.mood.valence = model.mood.valence + (next.mood.valence - model.mood.valence) * decay
    next.mood.arousal = model.mood.arousal + (next.mood.arousal - model.mood.arousal) * decay
    t += step
  }
  next.updatedAt = Math.max(state.updatedAt, to)
  return next
}

/** She woke: sleep satisfied her `rest` need. */
export function wokeUp(state: SelfState, model: StateModel): SelfState {
  const rest = model.needs.find(need => need.name === 'rest')
  return rest === undefined ? state : { ...state, needs: { ...state.needs, rest: rest.baseline } }
}

/**
 * Amount a need drops when a behavior succeeds; `prefix_*` keys match by prefix.
 * @param need - need spec.
 * @param behavior - tool name.
 */
export function satisfaction(need: NeedSpec, behavior: string): number {
  const exact = need.satisfiedBy[behavior]
  if (exact !== undefined) return exact
  for (const [key, amount] of Object.entries(need.satisfiedBy)) {
    if (key.endsWith('*') && behavior.startsWith(key.slice(0, -1))) return amount
  }
  return 0
}

/**
 * Apply a successful behavior to the needs it satisfies.
 * @returns a new state, or the same object when nothing changed.
 */
export function satisfy(state: SelfState, behavior: string, model: StateModel): SelfState {
  let changed = false
  const needs = { ...state.needs }
  for (const need of model.needs) {
    const amount = satisfaction(need, behavior)
    if (amount === 0 || needs[need.name] === undefined) continue
    needs[need.name] = clamp(needs[need.name]! - amount)
    changed = true
  }
  return changed ? { ...state, needs } : state
}

/** Spend one action turn's energy. */
export function spendTurn(state: SelfState, model: StateModel): SelfState {
  return { ...state, energy: clamp(state.energy - model.energy.perTurn) }
}

/**
 * Set mood values she chose, clamped (valence -1–1, arousal 0–1).
 * @returns a new state.
 */
export function feel(state: SelfState, adjust: { valence?: number | undefined; arousal?: number | undefined }): SelfState {
  return {
    ...state,
    mood: {
      valence: adjust.valence === undefined ? state.mood.valence : clamp(adjust.valence, -1, 1),
      arousal: adjust.arousal === undefined ? state.mood.arousal : clamp(adjust.arousal),
    },
  }
}

/**
 * Needs, highest first, with descriptions, for the situation report.
 * @returns lines like `connect 0.80 — being with people you care about`.
 */
export function describeNeeds(state: SelfState, model: StateModel): string[] {
  return [...model.needs]
    .sort((a, b) => (state.needs[b.name] ?? 0) - (state.needs[a.name] ?? 0))
    .map(need => `${need.name} ${(state.needs[need.name] ?? 0).toFixed(2)} — ${need.description}`)
}
