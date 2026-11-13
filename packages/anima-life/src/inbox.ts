/**
 * Her inbox (DESIGN §5, "Bursts and the inbox", Phase 9): chat messages that
 * arrived while she was asleep or paused, held per channel in
 * `<dataDir>/inbox.json` so they survive a restart. Nothing expires on a timer;
 * a channel's messages leave when she answers from the inbox or when that chat
 * reaches her again.
 * @module @anima/life/inbox
 */

import { channelKey, formatLocal, readJson, writeJson } from '@anima/core'
import type { MessageStimulus } from './group-triage.ts'
import type { PublishedChannel, Sender } from './stimulus.ts'

/** One held message. */
export interface HeldMessage {
  readonly sender: Sender
  readonly text: string
  /** When it was sent, on her clock. */
  readonly ts: number
  readonly messageId?: string | undefined
  readonly addressed?: boolean | undefined
  /** Why it was held. */
  readonly reason: 'asleep' | 'paused'
}

/** One channel's held messages. */
export interface InboxEntry {
  readonly channel: PublishedChannel
  readonly messages: HeldMessage[]
}

interface InboxFile {
  channels: Record<string, InboxEntry>
}

/** Persistent per-channel inbox. */
export class Inbox {
  private readonly file: InboxFile

  /** @param path - `<dataDir>/inbox.json`. */
  constructor(private readonly path: string) {
    this.file = { channels: {}, ...readJson<InboxFile>(path) }
  }

  /** Hold one message. */
  hold(message: MessageStimulus, reason: HeldMessage['reason']): void {
    const key = channelKey(message.channel)
    const entry = this.file.channels[key] ?? { channel: message.channel, messages: [] }
    entry.messages.push({
      sender: message.sender, text: message.text, ts: message.ts, reason,
      ...message.messageId === undefined ? {} : { messageId: message.messageId },
      ...message.addressed === undefined ? {} : { addressed: message.addressed },
    })
    this.file.channels[key] = { channel: message.channel, messages: entry.messages }
    this.save()
  }

  /** Channels with held messages, oldest first message first. */
  entries(): (InboxEntry & { key: string })[] {
    return Object.entries(this.file.channels)
      .filter(([, entry]) => entry.messages.length > 0)
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => a.messages[0]!.ts - b.messages[0]!.ts)
  }

  /** One channel's held messages (a copy). */
  peek(key: string): readonly HeldMessage[] {
    return [...this.file.channels[key]?.messages ?? []]
  }

  /** Why a channel's messages were held: `paused` only when every one came during a pause. */
  why(key: string): 'asleep' | 'paused' {
    const messages = this.file.channels[key]?.messages ?? []
    return messages.length > 0 && messages.every(m => m.reason === 'paused') ? 'paused' : 'asleep'
  }

  /** Take one channel's held messages out of the inbox, as message stimuli. */
  take(key: string): MessageStimulus[] {
    const entry = this.file.channels[key]
    if (entry === undefined || entry.messages.length === 0) return []
    delete this.file.channels[key]
    this.save()
    return entry.messages.map(m => ({
      type: 'message', channel: entry.channel, sender: m.sender, text: m.text, ts: m.ts,
      ...m.messageId === undefined ? {} : { messageId: m.messageId },
      ...m.addressed === undefined ? {} : { addressed: m.addressed },
    }))
  }

  /** Total held messages. */
  size(): number {
    return this.entries().reduce((n, entry) => n + entry.messages.length, 0)
  }

  private save(): void {
    writeJson(this.path, this.file)
  }
}

/**
 * The inbox summary line of her report (DESIGN §5): who sent how many, per
 * channel, with the last time, e.g. `收件箱：Sam 3 条（最后 01:12），测试群 @你 1 条`.
 * @returns undefined when the inbox is empty.
 */
export function inboxSummary(entries: readonly (InboxEntry & { key: string })[]): string | undefined {
  if (entries.length === 0) return undefined
  const parts = entries.map(({ channel, messages }) => {
    const last = formatLocal(messages.at(-1)!.ts).slice(11)
    const name = channel.kind === 'group' ? `${channel.display} @你` : channel.display
    return `${name} ${messages.length} 条（最后 ${last}，channel "${channelKey(channel)}"）`
  })
  return `收件箱：${parts.join('，')}。用 inbox_read 看，用 inbox_answer 交给那个聊天去回。`
}
