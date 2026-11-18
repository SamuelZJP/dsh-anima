/**
 * What her body allows (docs/design/body.md): whether a behavior exists where
 * she is, whether she is awake for it, whether its target exists, and whether
 * it is bedtime yet. Physiology and plumbing only; every safety limit lives
 * outside the persona, in `anima-guard`. Pure functions; the `tools/pre-execute`
 * listener lives in the service.
 * @module @anima/core/gate
 */

import type { Mode } from './rhythm.ts'
import type { BehaviorMeta, EffectClass, SessionInfo } from './types.ts'

/** Outcome of the body check. */
export type BodyVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly hint: string }

/** Facts of the moment, computed from her clock by the service. */
export interface BodyMoment {
  /** Her mode: awake (`day`) or asleep (`night`). */
  readonly mode: Mode
  /** Effect classes her body can do in each mode (asleep: only inner things). */
  readonly allowedEffects?: Readonly<Record<Mode, readonly EffectClass[]>>
  /** Whether an adapter published a channel. */
  readonly channelKnown?: (channelKey: string) => boolean
  /** Channel keys that exist, listed when a call targets an unknown one. */
  readonly knownChannels?: () => readonly string[]
  /** Before the earliest bedtime of her day: when she woke and the earliest bedtime, `HH:mm`. */
  readonly beforeBedtime?: { readonly woke: string, readonly earliest: string } | undefined
}

/** One behavior call. */
export interface BodyCall {
  readonly name: string
  readonly meta: BehaviorMeta
  /** The calling session, or `undefined` when it is not an Anima session. */
  readonly session: SessionInfo | undefined
  readonly args?: Readonly<Record<string, unknown>>
}

/** Refusal codes of the body check. */
export const GateCode = {
  notAnimaSession: 'anima/not-anima-session',
  wrongSession: 'anima/wrong-session',
  wrongPlatform: 'anima/wrong-platform',
  night: 'anima/night',
  unknownChannel: 'anima/unknown-channel',
  notBedtime: 'anima/not-bedtime',
} as const

/**
 * Whether a behavior's platform fits the session (tool scoping): a
 * conversation sees only its own platform; Self sees only platforms' `observe` behaviors.
 */
function platformFits(meta: BehaviorMeta, session: SessionInfo): boolean {
  if (meta.platform === undefined) return true
  if (session.kind === 'conversation') return session.channel.platform === meta.platform
  return meta.effect === 'observe'
}

/**
 * Whether a behavior is offered to the model in a session.
 * @returns true when the tool should be visible for this step.
 */
export function visibleIn(meta: BehaviorMeta, session: SessionInfo | undefined, mode?: Mode): boolean {
  return session !== undefined && meta.sessions.includes(session.kind) && platformFits(meta, session)
    && (mode === undefined || meta.modes === undefined || meta.modes.includes(mode))
}

/**
 * Whether a behavior only closes the turn with no effect on the world (`end_turn`,
 * `rest`, `group_pass`): nothing outside counts or refuses it, because refusing
 * the close leaves the turn unclosed.
 */
export function quotaExempt(meta: BehaviorMeta): boolean {
  return meta.closes === true && meta.effect === 'internal'
}

/** Session kinds in her words (the primer's names for her places of attention). */
const KIND_ZH: Record<string, string> = {
  self: '你的内心（Self）',
  conversation: '聊天',
  triage: '心跳',
  consolidation: '整理记忆',
  'group-triage': '扫视群聊',
  viewing: '细看',
}

/**
 * Check one call against her body. Checks, in order: Anima session, session
 * kind, platform, mode (asleep), target exists, bedtime.
 */
export function bodyCheck(call: BodyCall, moment: BodyMoment): BodyVerdict {
  const { meta, session, name } = call
  const args = call.args ?? {}
  if (session === undefined) return deny(GateCode.notAnimaSession, `${name} 只在你自己的会话里能用。`)
  if (!meta.sessions.includes(session.kind)) {
    return deny(GateCode.wrongSession, `${name} 在${KIND_ZH[session.kind] ?? session.kind}里用不了；它在这些地方能用：${meta.sessions.map(kind => KIND_ZH[kind] ?? kind).join('、')}。`)
  }
  if (!platformFits(meta, session)) return deny(GateCode.wrongPlatform, `${name} 属于 ${meta.platform}，在这里不能直接用。`)
  const allowed = moment.allowedEffects?.[moment.mode]
  if ((meta.modes !== undefined && !meta.modes.includes(moment.mode)) || (allowed !== undefined && !allowed.includes(meta.effect))) {
    return deny(GateCode.night, moment.mode === 'night'
      ? `你现在睡着了：${name} 要等你醒来才能用，睡着时只能做内心里的事（记忆、休息）。`
      : `${name} 只在夜里能用。`)
  }
  const target = meta.target?.(args)
  if (target !== undefined && moment.channelKnown?.(target) === false) {
    const known = moment.knownChannels?.() ?? []
    return deny(GateCode.unknownChannel, `没有「${target}」这个地方。你能去的地方：${known.length === 0 ? '没有' : known.join('、')}。`)
  }
  if (meta.bedtime === true && moment.beforeBedtime !== undefined) {
    return deny(GateCode.notBedtime, `还不到睡觉的时候：你今天 ${moment.beforeBedtime.woke} 才起床，最早也要到今晚 ${moment.beforeBedtime.earliest} 才睡得着。`)
  }
  return { allowed: true }
}

function deny(code: string, hint: string): BodyVerdict {
  return { allowed: false, code, hint }
}
