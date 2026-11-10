/**
 * Shared Anima vocabulary: effect classes, session kinds, channels and behavior metadata (DESIGN §3, §6).
 * @module @anima/core/types
 */

/** Effect class of a behavior; the gate's default rule depends on it (DESIGN §6). */
export type EffectClass = 'observe' | 'internal' | 'workspace' | 'express' | 'initiate' | 'public' | 'irreversible'

/** All effect classes, in increasing order of reach. */
export const EFFECT_CLASSES: readonly EffectClass[] = ['observe', 'internal', 'workspace', 'express', 'initiate', 'public', 'irreversible']

/**
 * Kind of an Anima session. `triage` runs the cheap heartbeat decision (DESIGN §7);
 * `consolidation` sorts a night's transcript into memories (DESIGN §8);
 * `group-triage` sorts buffered group chatter: ignore, remember, or wake (DESIGN §5).
 */
export type SessionKind = 'conversation' | 'self' | 'triage' | 'consolidation' | 'group-triage'

/** All session kinds. */
export const SESSION_KINDS: readonly SessionKind[] = ['conversation', 'self', 'triage', 'consolidation', 'group-triage']

/** A place she can talk, identified by `platform:account:kind:id` (DESIGN §3). */
export interface ChannelRef {
  /** Platform id, also the tool-name prefix (`local`, `qq`). */
  readonly platform: string
  /** Her account on that platform. */
  readonly account: string
  /** Channel kind, e.g. `private` or `group`. */
  readonly kind: string
  /** Platform-side id of the chat. */
  readonly id: string
}

/**
 * Stable channel key `platform:account:kind:id`.
 * @param ref - the channel.
 * @returns the key used for session identity and quotas.
 */
export function channelKey(ref: ChannelRef): string {
  return `${ref.platform}:${ref.account}:${ref.kind}:${ref.id}`
}

/** What Anima knows about a DSH session; `undefined` means it is not an Anima session. */
export type SessionInfo =
  | { readonly kind: 'self' }
  | { readonly kind: 'triage' }
  | { readonly kind: 'consolidation' }
  | { readonly kind: 'group-triage' }
  | { readonly kind: 'conversation'; readonly channel: ChannelRef; readonly channelKey: string }

/** Behavior metadata read by the gate and tool scoping (DESIGN §6). */
export interface BehaviorMeta {
  /** Owning platform; omitted for core behaviors. */
  readonly platform?: string
  /** Effect class. */
  readonly effect: EffectClass
  /** Weight counted against quotas; defaults to 1. */
  readonly cost?: number
  /** Session kinds that may call it. */
  readonly sessions: readonly SessionKind[]
  /** Heartbeat modes it works in; all when omitted. */
  readonly modes?: readonly ('day' | 'night')[]
  /**
   * The channel key the call targets, read from its arguments. Used for
   * initiate consent and the allowlist, and as the counter of `per: channel`
   * quotas when the calling session is not that channel's conversation.
   */
  readonly target?: (args: Readonly<Record<string, unknown>>) => string | undefined
  /** Owner policy on arguments: a hint when these arguments are not allowed. */
  readonly constraint?: (args: Readonly<Record<string, unknown>>) => string | undefined
}

/** Structured Anima error with a stable `code` and a human-readable hint in the message. */
export class AnimaError extends Error {
  /**
   * @param code - stable error code, e.g. `anima/config-invalid`.
   * @param message - what went wrong and how to fix it.
   */
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'AnimaError'
  }
}
