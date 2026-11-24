/**
 * Stimuli (docs/design/life.md): what reaches her waking session from the
 * world, and their model-facing text. Facts only; nothing says whether to answer.
 * @module @anima/life/stimulus
 */

import { channelKey, formatLocal, placeName, type ChannelRef } from '@anima/core'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Extra content blocks a stimulus carries after its text (images of a close view). */
export type ExtraBlock = Extract<ContentBlock, { type: 'text' | 'image' }>

/** A channel an adapter publishes, with a display name. */
export interface PublishedChannel extends ChannelRef {
  /** Human-readable name, e.g. `Owner (local)`. */
  readonly display: string
  /** Whether this is the owner's own channel (from bound account ids, never message text). */
  readonly isOwner?: boolean
  /** A fact line about this channel for the environment primer (Chinese), e.g. who reads it. */
  readonly note?: string
}

/** Who sent a message. */
export interface Sender {
  readonly platformUserId: string
  readonly displayName: string
  /** From bound account ids only, never from message text. */
  readonly isOwner: boolean
}

/** Stimuli. */
export type Stimulus =
  | {
    readonly type: 'message'
    readonly channel: PublishedChannel
    readonly sender: Sender
    readonly text: string
    /** Epoch milliseconds on her clock. */
    readonly ts: number
    /**
     * Group messages only: whether it addresses her directly (@, her name,
     * reply to her). Set by the adapter from platform data. Unaddressed group
     * messages are context and do not wake a turn (DESIGN §5).
     */
    readonly addressed?: boolean
    /** Platform message id, so she can reply to it. */
    readonly messageId?: string | undefined
    /** An unaddressed group message reaches her because it came in the attention window after she spoke there (set by life). */
    readonly via?: { readonly kind: 'attention' } | undefined
  }
  | {
    /**
     * Several chat messages handed to her at once: a settled private burst, a
     * group burst, an addressed group message with the unread lines before it,
     * or held inbox messages with the new ones. One logged arrival.
     */
    readonly type: 'burst'
    readonly channel: PublishedChannel
    /** Messages in time order; the newest is last. */
    readonly messages: readonly Extract<Stimulus, { type: 'message' }>[]
    /** How many of the first messages arrived while she slept or was paused (from the inbox). */
    readonly held?: number | undefined
    /** Why it was held: asleep or paused. */
    readonly heldWhy?: 'asleep' | 'paused' | undefined
    /** An unaddressed group burst reaches her in the attention window. */
    readonly via?: { readonly kind: 'attention' } | undefined
    readonly ts: number
  }
  | {
    /**
     * Something that happened in a channel that needs no answer (a recalled
     * message). Joins her next turn as context; starts nothing.
     */
    readonly type: 'channel-event'
    readonly channel: PublishedChannel
    readonly text: string
    readonly ts: number
  }
  | {
    /**
     * A notice: a platform went down or came back (context, starts nothing),
     * or the owner's words from outside (`/anima self`), which start a turn.
     */
    readonly type: 'notice'
    readonly text: string
    /** Whether it starts a turn. */
    readonly wake?: boolean | undefined
    readonly ts: number
  }
  | {
    /** A beat of her heart, awake: her state (docs/design/body.md). */
    readonly type: 'heartbeat'
    readonly text: string
    readonly ts: number
  }
  | {
    /** She woke (her body, the owner, or her first waking): the first arrival of a waking session. */
    readonly type: 'waking'
    readonly text: string
    readonly ts: number
  }
  | {
    /** Sort unconsolidated conversation into memories (DESIGN §8), in the day's consolidation session. */
    readonly type: 'consolidate'
    /** Her day key, naming the consolidation session. */
    readonly day: string
    readonly text: string
    /** Reference recorded in the message source (the consolidation run id). */
    readonly run: string
    readonly ts: number
  }

/**
 * Whether a stimulus starts a turn. Group messages do only when they address
 * her or come from the owner; channel events and platform notices never do.
 * (Life keeps other group messages in the group's unread buffer.)
 */
export function wakes(stimulus: Stimulus): boolean {
  if (stimulus.type === 'channel-event') return false
  if (stimulus.type === 'notice') return stimulus.wake === true
  if (stimulus.type !== 'message' || stimulus.channel.kind !== 'group') return true
  return stimulus.addressed === true || stimulus.sender.isOwner
}

/** Where an arrival happened: its place and channel key, e.g. `[QQ 私聊「Sam」 qq:1:private:2]`. */
export function whereOf(channel: ChannelRef & { readonly display?: string }): string {
  return `[${placeName(channel)} ${channelKey(channel)}]`
}

/**
 * How a message names its sender: in groups with the user id and message id,
 * so she can mention or reply (`Alice [qq 10001, msg 5521]`).
 */
export function senderLabel(stimulus: Extract<Stimulus, { type: 'message' }>): string {
  const { channel, sender } = stimulus
  const name = `${sender.displayName}${sender.isOwner ? '（主人）' : ''}`
  if (channel.kind === 'private') return stimulus.messageId === undefined ? name : `${name} [msg ${stimulus.messageId}]`
  const ids = [`${channel.platform} ${sender.platformUserId}`, ...stimulus.messageId === undefined ? [] : [`msg ${stimulus.messageId}`]]
  return `${name} [${ids.join(', ')}]`
}

/**
 * Model-facing text of a stimulus, without the clock stamp. In Chinese, like
 * the primer; each states the facts of the arrival and never whether she
 * should answer.
 * @returns e.g. `[QQ 私聊「Sam」 qq:1:private:2] Sam（主人）对你说: hello`.
 */
export function stimulusText(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': {
      const { channel } = stimulus
      const where = whereOf(channel)
      if (channel.kind !== 'group') return `${where} ${senderLabel(stimulus)} 对你说: ${stimulus.text}`
      if (stimulus.addressed === true) return `${where} ${senderLabel(stimulus)} 叫你（群里所有人都会看到你的回答）: ${stimulus.text}`
      const line = `${where} ${senderLabel(stimulus)}: ${stimulus.text}`
      if (stimulus.via?.kind === 'attention') return `${line}\n（这条没有叫你；你刚在这个群里说过话，所以它直接到了你这里。）`
      return line
    }
    case 'burst':
      return burstText(stimulus)
    case 'channel-event':
      return `${whereOf(stimulus.channel)} [事件] ${stimulus.text}（只是上下文，不需要回答。）`
    case 'notice':
      return `[通知] ${stimulus.text}`
    case 'heartbeat':
      return `[心跳]\n${stimulus.text}`
    case 'waking':
      return `[醒来]\n${stimulus.text}`
    case 'consolidate':
      return `[整理记忆]\n${stimulus.text}`
  }
}

/** `HH:mm` of a time on her clock, with the date when it is not the day of `ref`. */
function timeOf(t: number, ref: number): string {
  const text = formatLocal(t)
  return text.slice(0, 10) === formatLocal(ref).slice(0, 10) ? text.slice(11) : text.slice(5)
}

/**
 * The burst format (DESIGN §5): who sent how many, then each message with its
 * time and id, oldest first. Messages from her inbox are marked as arrived
 * while she slept or was paused.
 * @returns e.g. `[QQ 私聊「Sam」 qq:1:private:2] Sam（主人）发来 3 条：\n  08:01 [msg 1] 在吗\n…`.
 */
export function burstText(stimulus: Extract<Stimulus, { type: 'burst' }>): string {
  const { channel, messages } = stimulus
  const last = messages.at(-1)?.ts ?? stimulus.ts
  const counts = new Map<string, { name: string; count: number }>()
  for (const message of messages) {
    const name = `${message.sender.displayName}${message.sender.isOwner ? '（主人）' : ''}`
    const entry = counts.get(message.sender.platformUserId) ?? { name, count: 0 }
    entry.count += 1
    counts.set(message.sender.platformUserId, entry)
  }
  const who = [...counts.values()].map(({ name, count }) => `${name} ${count} 条`).join('，')
  const group = channel.kind === 'group'
  const head = `${whereOf(channel)} ${counts.size === 1 && !group ? `${[...counts.values()][0]!.name}发来 ${messages.length} 条` : `${messages.length} 条消息（${who}）`}：`
  const held = stimulus.held ?? 0
  const lines = messages.map((message, index) => {
    const label = group ? senderLabel(message) : message.messageId === undefined ? '' : `[msg ${message.messageId}]`
    const call = group && message.addressed === true ? ' 叫你' : ''
    const mark = index < held ? `（${stimulus.heldWhy === 'paused' ? '暂停时收到' : '你睡着时收到'}）` : ''
    const who = label === '' ? '' : `${label}${call}${group ? ':' : ''}`
    return `  ${[`${timeOf(message.ts, last)}${mark}`, who, message.text].filter(part => part !== '').join(' ')}`
  })
  const notes: string[] = []
  // Held messages reach her only once she can act again; say so, so she does not answer as if still asleep.
  const now = stimulus.heldWhy === 'paused' ? '主人已经让你继续了' : '你现在已经醒了'
  if (held > 0) notes.push(held === messages.length ? `（这些是${stimulus.heldWhy === 'paused' ? '主人让你暂停时' : '你睡着时'}收到的，发送时间如上；${now}。）` : `（前 ${held} 条是${stimulus.heldWhy === 'paused' ? '暂停时' : '你睡着时'}收到的；${now}。）`)
  if (group && messages.some(m => m.addressed === true)) notes.push('（群里所有人都会看到你的回答。）')
  if (stimulus.via?.kind === 'attention') notes.push('（你刚在这个群里说过话，所以这些直接到了你这里。）')
  return [head, ...lines, ...notes].join('\n')
}

/** One-line summary shown on the collapsed context row. */
export function stimulusSummary(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': return `${stimulus.sender.displayName} on ${stimulus.channel.platform}: ${stimulus.text}`
    case 'notice': return `Notice: ${stimulus.text}`
    case 'heartbeat': return 'Heartbeat'
    case 'waking': return 'Waking'
    case 'burst': return `${stimulus.messages.length} messages in ${stimulus.channel.display}${stimulus.held === undefined || stimulus.held === 0 ? '' : ` (${stimulus.held} from the inbox)`}`
    case 'consolidate': return 'Consolidating memories'
    case 'channel-event': return `Event in ${stimulus.channel.display}: ${stimulus.text}`
  }
}

/** Reference recorded in the message source (the consolidation run id). */
export function stimulusRef(stimulus: Stimulus): string | undefined {
  return stimulus.type === 'consolidate' ? stimulus.run : undefined
}

/** A chat message stimulus. */
export type MessageStimulus = Extract<Stimulus, { type: 'message' }>
