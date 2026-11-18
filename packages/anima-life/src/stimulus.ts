/**
 * Stimuli and routing (DESIGN §5): channel stimuli go to that channel's
 * conversation session, heartbeats to the day's triage session or to Self,
 * everything else to the Self session.
 * @module @anima/life/stimulus
 */

import { channelKey, formatLocal, placeName, type ChannelRef } from '@anima/core'
import { consolidationSessionId, conversationSessionId, groupTriageSessionId, selfSessionId, triageSessionId, viewingSessionId } from './identity.ts'
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
    /**
     * Why an unaddressed group message wakes her (set by life): she chose it in
     * group triage, with her reason, or it came in the attention window after
     * she spoke there (DESIGN §5, §6).
     */
    readonly via?: { readonly kind: 'triage'; readonly reason: string } | { readonly kind: 'attention' } | undefined
  }
  | {
    /**
     * Several chat messages handed to her at once (DESIGN §5, "Bursts and the
     * inbox", Phase 9): a settled private burst, a group burst, an addressed
     * group message with the buffered messages before it, or messages held in
     * her inbox. One logged arrival with one answer line; she answers the whole.
     */
    readonly type: 'burst'
    readonly channel: PublishedChannel
    /** Messages in time order; the newest is last. */
    readonly messages: readonly Extract<Stimulus, { type: 'message' }>[]
    /** How many of the first messages arrived while she slept or was paused (from the inbox). */
    readonly held?: number | undefined
    /** Why it was held: asleep or paused. */
    readonly heldWhy?: 'asleep' | 'paused' | undefined
    /** Self's note when she answers from the inbox (`inbox_answer`). */
    readonly note?: string | undefined
    /** Why an unaddressed group burst wakes her (attention window, triage). */
    readonly via?: { readonly kind: 'triage'; readonly reason: string } | { readonly kind: 'attention' } | undefined
    readonly ts: number
  }
  | {
    /**
     * Something that happened in a channel that needs no answer (a recalled
     * message). Joins that conversation's next turn as context, only when the
     * session already exists; never wakes, never creates a session.
     */
    readonly type: 'channel-event'
    readonly channel: PublishedChannel
    readonly text: string
    readonly ts: number
  }
  | {
    /** Buffered group messages for the cheap group triage decision (DESIGN §5). */
    readonly type: 'group-batch'
    /** Her day key, naming the group-triage session. */
    readonly day: string
    /** Batch id, e.g. `b12`. */
    readonly batch: string
    readonly channel: PublishedChannel
    readonly text: string
    readonly ts: number
  }
  | {
    /** A notice for her inner life, e.g. from the owner via `/anima self`. */
    readonly type: 'notice'
    readonly text: string
    readonly ts: number
  }
  | {
    /** A heartbeat: the situation report, to the triage session of her day or to Self. */
    readonly type: 'heartbeat'
    readonly to: 'triage' | 'self'
    /** Her day key, naming the triage session. */
    readonly day: string
    readonly text: string
    readonly ts: number
  }
  | {
    /** Self decided to start a conversation (DESIGN §5 intent handoff). */
    readonly type: 'intent'
    readonly channel: PublishedChannel
    readonly intentId: string
    readonly intent: string
    readonly context?: string | undefined
    /** Real seconds her message waits in the outbox, where the owner can cancel it; 0 or absent when it goes at once. */
    readonly heldSeconds?: number | undefined
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
  | {
    /** A close look at a video she chose: text plus frames, to a short viewing session (DESIGN §11). */
    readonly type: 'view'
    /** Viewing key, naming the session (e.g. `bili:BV1xx:3`). */
    readonly key: string
    /** Session title suffix, e.g. the video title. */
    readonly title: string
    readonly text: string
    /** Frames and their captions, in time order. */
    readonly parts: readonly ExtraBlock[]
    readonly ts: number
  }

/** Where a stimulus goes. */
export type Route =
  | { readonly kind: 'conversation'; readonly sessionId: string; readonly channel: PublishedChannel; readonly channelKey: string }
  | { readonly kind: 'self'; readonly sessionId: string }
  | { readonly kind: 'triage'; readonly sessionId: string; readonly day: string }
  | { readonly kind: 'consolidation'; readonly sessionId: string; readonly day: string }
  | { readonly kind: 'group-triage'; readonly sessionId: string; readonly day: string }
  | { readonly kind: 'viewing'; readonly sessionId: string; readonly title: string }

/**
 * Whether a stimulus wakes a turn by default. Group messages wake only when
 * they address her or come from the owner (DESIGN §5); channel events never do.
 * (Life sends other group messages through group triage first.)
 */
export function wakes(stimulus: Stimulus): boolean {
  if (stimulus.type === 'channel-event') return false
  if (stimulus.type !== 'message' || stimulus.channel.kind !== 'group') return true
  return stimulus.addressed === true || stimulus.sender.isOwner
}

/**
 * Route one stimulus to exactly one session.
 * @param characterId - character identity.
 * @param stimulus - the stimulus.
 * @param selfGeneration - Self session generation.
 * @param conversationGeneration - conversation session generation.
 * @returns the target session.
 */
export function route(characterId: string, stimulus: Stimulus, selfGeneration = 1, conversationGeneration = 1): Route {
  switch (stimulus.type) {
    case 'message':
    case 'burst':
    case 'channel-event':
    case 'intent': {
      const key = channelKey(stimulus.channel)
      return { kind: 'conversation', sessionId: conversationSessionId(characterId, key, conversationGeneration), channel: stimulus.channel, channelKey: key }
    }
    case 'heartbeat':
      return stimulus.to === 'triage'
        ? { kind: 'triage', sessionId: triageSessionId(characterId, stimulus.day), day: stimulus.day }
        : { kind: 'self', sessionId: selfSessionId(characterId, selfGeneration) }
    case 'notice':
      return { kind: 'self', sessionId: selfSessionId(characterId, selfGeneration) }
    case 'consolidate':
      return { kind: 'consolidation', sessionId: consolidationSessionId(characterId, stimulus.day), day: stimulus.day }
    case 'group-batch':
      return { kind: 'group-triage', sessionId: groupTriageSessionId(characterId, stimulus.day), day: stimulus.day }
    case 'view':
      return { kind: 'viewing', sessionId: viewingSessionId(characterId, stimulus.key), title: stimulus.title }
  }
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
 * the primer; each states the facts of the arrival (DESIGN §5 table) and never
 * whether she should answer. The router adds the "how to answer here" line to
 * waking conversation arrivals.
 * @returns e.g. `[QQ 私聊「Sam」] Sam（主人）对你说: hello`.
 */
export function stimulusText(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': {
      const { channel } = stimulus
      const where = `[${placeName(channel)}]`
      if (channel.kind !== 'group') return `${where} ${senderLabel(stimulus)} 对你说: ${stimulus.text}`
      if (stimulus.addressed === true) return `${where} ${senderLabel(stimulus)} 叫你（群里所有人都会看到你的回答）: ${stimulus.text}`
      const via = stimulus.via
      const line = `${where} ${senderLabel(stimulus)}: ${stimulus.text}`
      if (via?.kind === 'triage') return `${line}\n（没有人叫你；是你在扫视群聊时决定来看看${via.reason === '' ? '' : `，你的理由：${via.reason}`}。）`
      if (via?.kind === 'attention') return `${line}\n（这条没有叫你；你刚在这个群里说过话，所以它直接到了你这里。）`
      return line
    }
    case 'burst':
      return burstText(stimulus)
    case 'channel-event':
      return `[${placeName(stimulus.channel)}] [事件] ${stimulus.text}（只是上下文，不需要回答。）`
    case 'group-batch':
      return `[群聊批次 ${stimulus.batch}]\n${stimulus.text}`
    case 'notice':
      return `[通知] ${stimulus.text}`
    case 'heartbeat':
      return `[心跳]\n${stimulus.text}`
    case 'intent': {
      const { channel } = stimulus
      const held = stimulus.heldSeconds ?? 0
      return [
        `[来自 Self 的意图]（${stimulus.intentId}）你在自己的内心决定来 ${placeName(channel)} 开口。对方没有发消息给你。`,
        `你想要的：${stimulus.intent}`,
        ...stimulus.context === undefined || stimulus.context === '' ? [] : [`背景：${stimulus.context}`],
        held > 0 ? `你发出的消息会先在发件箱里等 ${held} 秒，主人在这期间可以取消。Self 会知道结果。` : 'Self 会知道结果。',
      ].join('\n')
    }
    case 'consolidate':
      return `[整理记忆]\n${stimulus.text}`
    case 'view':
      return `[细看]\n${stimulus.text}`
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
 * @returns e.g. `[QQ 私聊「Sam」] Sam（主人）发来 3 条：\n  08:01 [msg 1] 在吗\n…`.
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
  const head = `[${placeName(channel)}] ${counts.size === 1 && !group ? `${[...counts.values()][0]!.name}发来 ${messages.length} 条` : `${messages.length} 条消息（${who}）`}：`
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
  const via = stimulus.via
  if (via?.kind === 'triage') notes.push(`（没有人叫你；是你在扫视群聊时决定来看看${via.reason === '' ? '' : `，你的理由：${via.reason}`}。）`)
  if (via?.kind === 'attention') notes.push('（你刚在这个群里说过话，所以这些直接到了你这里。）')
  if (stimulus.note !== undefined && stimulus.note !== '') notes.push(`（你在内心里想的：${stimulus.note}）`)
  return [head, ...lines, ...notes].join('\n')
}

/**
 * The "how to answer here" line of a waking conversation arrival (DESIGN §5),
 * from her actual tools.
 * @param channel - the conversation's channel.
 * @param say - this chat's say tool, when one is registered.
 * @param ender - the closing tool without speech (`end_turn`), when registered.
 */
export function answerLine(channel: ChannelRef, say: string | undefined, ender: string | undefined): string {
  const who = channel.kind === 'group' ? '群里所有人都看得到' : '只有对方看得到'
  const speak = say === undefined ? '这里没有说话的工具' : `用 ${say} 说话（${who}）`
  return `在这里回应：${speak}${ender === undefined ? '' : `，或用 ${ender} 结束不说`}。只写文字没有人看得到。`
}

/** One-line summary shown on the collapsed context row. */
export function stimulusSummary(stimulus: Stimulus): string {
  switch (stimulus.type) {
    case 'message': return `${stimulus.sender.displayName} on ${stimulus.channel.platform}: ${stimulus.text}`
    case 'notice': return `Notice: ${stimulus.text}`
    case 'heartbeat': return stimulus.to === 'triage' ? 'Heartbeat' : 'Heartbeat: acting'
    case 'intent': return `Intent: ${stimulus.intent}`
    case 'burst': return `${stimulus.messages.length} messages in ${stimulus.channel.display}${stimulus.held === undefined || stimulus.held === 0 ? '' : ` (${stimulus.held} from the inbox)`}`
    case 'consolidate': return 'Consolidating memories'
    case 'channel-event': return `Event in ${stimulus.channel.display}: ${stimulus.text}`
    case 'group-batch': return `Group batch ${stimulus.batch}: ${stimulus.channel.display}`
    case 'view': return `Viewing closely: ${stimulus.title}`
  }
}

/** Reference recorded in the message source, so session events can be tied back (intent id). */
export function stimulusRef(stimulus: Stimulus): string | undefined {
  if (stimulus.type === 'intent') return stimulus.intentId
  if (stimulus.type === 'consolidate') return stimulus.run
  if (stimulus.type === 'group-batch') return stimulus.batch
  if (stimulus.type === 'view') return stimulus.key
  return undefined
}
