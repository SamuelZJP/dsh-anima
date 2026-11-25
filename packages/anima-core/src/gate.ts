/**
 * What her body allows (docs/design/body.md): whether a behavior exists where
 * she is, whether she is awake for it, whether she has the energy for it, and
 * whether its target exists.
 * Physiology and plumbing only; every safety limit lives outside the persona,
 * in `anima-guard`. Pure functions; the `tools/pre-execute` listener lives in the service.
 * @module @anima/core/gate
 */

import type { BehaviorMeta, SessionInfo } from './types.ts'

/** Outcome of the body check. */
export type BodyVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Facts of the moment, from her body and the channels that exist. */
export interface BodyMoment {
  /** Whether she is asleep. */
  readonly asleep: boolean
  /** Whether she is too tired for anything that costs energy. */
  readonly exhausted?: boolean
  /** Whether an adapter published a channel. */
  readonly channelKnown?: (channelKey: string) => boolean
  /** Channel keys that exist, listed when a call targets an unknown one. */
  readonly knownChannels?: () => readonly string[]
}

/** One behavior call. */
export interface BodyCall {
  readonly name: string
  readonly meta: BehaviorMeta
  /** The calling session, or `undefined` when it is not an Anima session. */
  readonly session: SessionInfo | undefined
  readonly args?: Readonly<Record<string, unknown>>
  /** Energy the call would spend. */
  readonly energy?: number
}

/** Refusal codes of the body check. */
export const GateCode = {
  notAnimaSession: 'anima/not-anima-session',
  wrongSession: 'anima/wrong-session',
  asleep: 'anima/asleep',
  exhausted: 'anima/exhausted',
  unknownChannel: 'anima/unknown-channel',
} as const

/**
 * Whether a behavior is offered to the model in a session.
 * @returns true when the tool should be visible for this step.
 */
export function visibleIn(meta: BehaviorMeta, session: SessionInfo | undefined): boolean {
  return session !== undefined && meta.sessions.includes(session.kind)
}

/**
 * Whether a behavior only closes the turn with no effect on the world (`end_turn`,
 * `rest`): nothing outside counts or refuses it, because refusing the close
 * leaves the turn unclosed.
 */
export function quotaExempt(meta: BehaviorMeta): boolean {
  return meta.closes === true && meta.effect === 'internal'
}

/** Session kinds in her words. */
const KIND_ZH: Record<string, string> = {
  waking: '醒着的时候',
  consolidation: '睡着时整理记忆的时候',
}

/**
 * Check one call against her body. Checks, in order: Anima session, session
 * kind, awake and with energy for it (in a waking session), target exists.
 */
export function bodyCheck(call: BodyCall, moment: BodyMoment): BodyVerdict {
  const { meta, session, name } = call
  const args = call.args ?? {}
  if (session === undefined) return deny(GateCode.notAnimaSession, `${name} 只在你自己的会话里能用。`)
  if (!meta.sessions.includes(session.kind)) {
    return deny(GateCode.wrongSession, `${name} 在${KIND_ZH[session.kind] ?? session.kind}用不了；它在这些时候能用：${meta.sessions.map(kind => KIND_ZH[kind] ?? kind).join('、')}。`)
  }
  if (session.kind === 'waking' && moment.asleep) return deny(GateCode.asleep, `你睡着了：${name} 要等你醒来才能用。`)
  if (session.kind === 'waking' && moment.exhausted === true && (call.energy ?? 0) > 0) {
    return deny(GateCode.exhausted, `你太累了，做不动 ${name}。不费力的事还能做；精力在闲着和睡着时会恢复。`)
  }
  const target = meta.target?.(args)
  if (target !== undefined && moment.channelKnown?.(target) === false) {
    const known = moment.knownChannels?.() ?? []
    return deny(GateCode.unknownChannel, `没有「${target}」这个地方。你能去的地方：${known.length === 0 ? '没有' : known.join('、')}。`)
  }
  return { allowed: true }
}

function deny(code: string, hint: string): BodyVerdict {
  return { allowed: false, code, hint }
}
