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
 * `group-triage` sorts buffered group chatter: ignore, remember, or wake (DESIGN §5);
 * `viewing` looks closely at frames of a video she chose and writes a note (DESIGN §11).
 */
export type SessionKind = 'conversation' | 'self' | 'triage' | 'consolidation' | 'group-triage' | 'viewing'

/** All session kinds. */
export const SESSION_KINDS: readonly SessionKind[] = ['conversation', 'self', 'triage', 'consolidation', 'group-triage', 'viewing']

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
  | { readonly kind: 'viewing' }
  | { readonly kind: 'conversation'; readonly channel: ChannelRef; readonly channelKey: string }

/** Behavior metadata read by the gate and tool scoping (DESIGN §6). */
export interface BehaviorMeta {
  /** Owning platform; omitted for core behaviors. */
  readonly platform?: string
  /** Effect class. */
  readonly effect: EffectClass
  /**
   * Weight counted against quotas; defaults to 1. A function reads it from the
   * call's arguments (a say with a list of messages costs one per message).
   */
  readonly cost?: number | ((args: Readonly<Record<string, unknown>>) => number)
  /**
   * Whether a successful call closes the conversation turn (DESIGN §6, Turn
   * shape): the core wrapper then concludes the turn. A say closes unless
   * `more: true`; `end_turn` always closes; gestures and observe calls never do.
   */
  readonly closes?: boolean | ((args: Readonly<Record<string, unknown>>) => boolean)
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
  /**
   * Numeric facts about a call (e.g. a video's `durationSeconds`), checked
   * against the owner's `limits` rules before it runs. Failing to find the
   * facts refuses the call with the error's message.
   */
  readonly facts?: (args: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, number>>>
}

/** Quota weight of one call (DESIGN §10). */
export function costOf(meta: BehaviorMeta, args: Readonly<Record<string, unknown>> = {}): number {
  const cost = typeof meta.cost === 'function' ? meta.cost(args) : meta.cost ?? 1
  return Number.isFinite(cost) && cost > 0 ? cost : 1
}

/** Whether a successful call closes the turn (DESIGN §6, Turn shape). */
export function closesTurn(meta: BehaviorMeta, args: Readonly<Record<string, unknown>> = {}): boolean {
  return typeof meta.closes === 'function' ? meta.closes(args) : meta.closes === true
}

/**
 * The messages of a say call (DESIGN §6): `text`, then each of `also`, in order;
 * blank ones are dropped. A list passed as `text` is accepted too.
 * @param args - the say's arguments.
 */
export function sayMessages(args: Readonly<Record<string, unknown>>): string[] {
  const items = [...Array.isArray(args.text) ? args.text : [args.text], ...Array.isArray(args.also) ? args.also : []]
  return items.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item !== '')
}

/**
 * Parameters and metadata every platform say shares (DESIGN §6, Turn shape):
 * `text` is the message, `also` further messages sent after it, and `more`
 * keeps the turn open. `text` is a plain string, not a string-or-list union:
 * with a `oneOf` there, DeepSeek-Flash wrote the string unquoted
 * (`{"text": 在的}`), which DSH rejects as invalid JSON (Phase 8 check). A say
 * closes the turn unless `more: true`, costs one quota unit however many
 * messages it sends (per-message cost spent the owner chat's hourly quota in
 * eight replies during the supervised QQ hour), and reports how many messages
 * it sends as the `messages` fact (owner `limits`, 5 by default).
 */
export const SAY_PARAMETERS = {
  text: { type: 'string', required: true, description: 'The message, exactly as it should appear.' },
  also: { type: 'array', items: { type: 'string' }, description: 'Optional further messages, sent one after another after text.' },
  more: { type: 'boolean', description: 'true keeps this turn open after sending (you want to do something else first). Omit it for a normal reply: the say ends your turn.' },
} as const

/** Say metadata shared by every platform (see {@link SAY_PARAMETERS}). */
export const SAY_META = {
  closes: (args: Readonly<Record<string, unknown>>) => args.more !== true,
  facts: async (args: Readonly<Record<string, unknown>>) => ({ messages: sayMessages(args).length }),
} satisfies Partial<BehaviorMeta>

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
