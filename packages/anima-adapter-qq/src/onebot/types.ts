/**
 * The loose OneBot v11 shapes the OneBot backend reads. Only this folder knows them.
 * @module @anima/adapter-qq/onebot/types
 */

/** One OneBot message segment. */
export interface OneBotSegment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/** A OneBot event or a message as `get_msg` and the history actions return it. */
export interface OneBotEvent {
  readonly post_type?: string
  readonly message_type?: string
  readonly notice_type?: string
  readonly request_type?: string
  readonly meta_event_type?: string
  readonly sub_type?: string
  readonly message_id?: number | string
  readonly user_id?: number | string
  readonly group_id?: number | string
  readonly target_id?: number | string
  readonly operator_id?: number | string
  readonly self_id?: number | string
  readonly message?: unknown
  readonly sender?: { readonly user_id?: number | string; readonly nickname?: string; readonly card?: string }
  readonly comment?: string
  readonly flag?: string
  readonly time?: number
  readonly interval?: number
  readonly status?: { readonly online?: boolean; readonly good?: boolean }
  readonly status_text?: string
  readonly tag?: string
  readonly [key: string]: unknown
}
