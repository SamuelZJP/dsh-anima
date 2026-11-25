/**
 * Self state (docs/design/body.md): needs, energy, mood and sleep pressure. Code moves these numbers only
 * by time, by sleep and by the energy her behaviors spend; it never reads message words and never judges
 * what an event means. What satisfied a need, and how she feels, is her appraisal (`self_feel`). Pure.
 * @module @anima/core/state
 */

import { INITIAL_PRESSURE, movePressure, type SleepGenes } from './sleep.ts'
import type { BehaviorMeta, EffectClass } from './types.ts'

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
}

/** Her energy (genes). */
export interface EnergyConfig {
  /** Drain per awake hour. */
  drainPerHour: number
  /** Restore per awake hour while no turn runs (idling), on top of the drain. */
  idleRestorePerHour: number
  /** Restore per sleeping hour. */
  restorePerHour: number
  /** Below this, only behaviors that cost no energy run. */
  exhausted: number
  /** Energy one call spends, by effect class. */
  costs: Record<EffectClass, number>
  /** Energy one call spends, by behavior name (or `prefix_*`), over its effect class. */
  behaviorCosts: Record<string, number>
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
  /** Whether she is awake and no turn runs (idling); defaults to never. */
  readonly idle?: () => boolean
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

/** Default needs (docs/design/body.md), starting values to be tuned from test runs. */
export const DEFAULT_NEEDS: NeedSpec[] = [
  { name: 'connect', description: 'being with people you care about', baseline: 0.4, driftPerHour: 0.05 },
  { name: 'curiosity', description: 'finding out new things', baseline: 0.3, driftPerHour: 0.03 },
  { name: 'expression', description: 'making or sharing something of your own', baseline: 0.3, driftPerHour: 0.02 },
  { name: 'rest', description: 'stopping and resting', baseline: 0.2, driftPerHour: 0.04 },
  { name: 'order', description: 'keeping your workspace, goals and memory tidy', baseline: 0.2, driftPerHour: 0.01 },
]

/** Default energy genes: a quiet waking day costs about 0.5; speaking and looking cost a little each. */
export const DEFAULT_ENERGY: EnergyConfig = {
  drainPerHour: 0.03,
  idleRestorePerHour: 0.05,
  restorePerHour: 0.15,
  exhausted: 0.1,
  costs: { observe: 0.005, internal: 0, workspace: 0.01, express: 0.015, initiate: 0.02, public: 0.02, irreversible: 0.02 },
  behaviorCosts: { bili_view_closely: 0.06, bili_watch: 0.02 },
}

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
 * current phase: awake, needs drift, energy drains (and restores a little
 * while she idles) and sleep pressure rises; asleep, energy restores and sleep
 * pressure falls; mood decays toward its baseline throughout.
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
  const idle = !asleep && (model.idle?.() ?? false)
  let t = state.updatedAt
  while (t < to) {
    const step = Math.min(STEP_MS, to - t)
    const hours = step / 3_600_000
    if (asleep) {
      next.energy = clamp(next.energy + model.energy.restorePerHour * hours)
    } else {
      for (const need of model.needs) next.needs[need.name] = clamp(next.needs[need.name]! + need.driftPerHour * hours)
      next.energy = clamp(next.energy + ((idle ? model.energy.idleRestorePerHour : 0) - model.energy.drainPerHour) * hours)
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
 * Energy one call of a behavior spends: its name (or `prefix_*`) in
 * `behaviorCosts`, else its effect class in `costs`. Physiology: what the
 * call does to her body, never what it means.
 */
export function energyCost(name: string, meta: Pick<BehaviorMeta, 'effect'>, energy: EnergyConfig): number {
  const exact = energy.behaviorCosts[name]
  if (exact !== undefined) return exact
  for (const [key, amount] of Object.entries(energy.behaviorCosts)) {
    if (key.endsWith('*') && name.startsWith(key.slice(0, -1))) return amount
  }
  return energy.costs[meta.effect] ?? 0
}

/** Whether she is too tired for anything that costs energy. */
export function exhausted(state: Pick<SelfState, 'energy'>, energy: EnergyConfig): boolean {
  return state.energy < energy.exhausted
}

/**
 * Spend energy on something she did: energy falls, and sleep pressure rises
 * with it (`sleep.perEnergy`), so a busy stretch makes her sleepy sooner.
 * @returns a new state, or the same object when the amount is 0.
 */
export function spend(state: SelfState, amount: number, model: StateModel): SelfState {
  if (!(amount > 0)) return state
  return {
    ...state,
    energy: clamp(state.energy - amount),
    sleepPressure: clamp(state.sleepPressure + amount * model.sleep.perEnergy),
  }
}

/**
 * Set need levels she chose after her own appraisal (`self_feel`), clamped
 * 0–1. Unknown names are left out.
 * @returns a new state and the names that changed.
 */
export function setNeeds(state: SelfState, levels: readonly { name: string; level: number }[], model: StateModel): { state: SelfState; unknown: string[] } {
  const needs = { ...state.needs }
  const unknown: string[] = []
  for (const { name, level } of levels) {
    if (!model.needs.some(need => need.name === name) || !Number.isFinite(level)) unknown.push(name)
    else needs[name] = clamp(level)
  }
  return { state: { ...state, needs }, unknown }
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
