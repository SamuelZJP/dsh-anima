/**
 * Group unread buffers (docs/design/life.md, Groups): a group message that does
 * not address her waits in its group's buffer until she looks. People do not
 * read every unread line in every group; she doesn't either. What she never
 * looked at, she never perceived. In memory only: a restart loses unread lines,
 * as an app restart would lose a scroll position.
 * @module @anima/life/groups
 */

import { channelKey } from '@anima/core'
import type { MessageStimulus, PublishedChannel } from './stimulus.ts'

/** One buffered line. */
interface Line {
  readonly message: MessageStimulus
  /** She has seen it (glanced, read, or it came with a burst). */
  seen: boolean
}

/** One group's buffer. */
interface Buffer {
  readonly channel: PublishedChannel
  readonly lines: Line[]
  /** Lines since she last read the group. */
  unread: number
}

/** What `groups_glance` shows of one group. */
export interface Glance {
  readonly key: string
  readonly channel: PublishedChannel
  readonly unread: number
  /** Latest lines, oldest first. */
  readonly latest: readonly MessageStimulus[]
}

/** Per-group buffers of unaddressed messages. */
export class GroupBuffers {
  private readonly buffers = new Map<string, Buffer>()

  /** @param max - lines kept per group (`groups.bufferMessages`). */
  constructor(private readonly max: number) {}

  /** Keep one unaddressed group message, unread. */
  add(message: MessageStimulus): void {
    const key = channelKey(message.channel)
    const buffer = this.buffers.get(key) ?? { channel: message.channel, lines: [], unread: 0 }
    buffer.lines.push({ message, seen: false })
    buffer.unread = Math.min(buffer.unread + 1, this.max)
    if (buffer.lines.length > this.max) buffer.lines.splice(0, buffer.lines.length - this.max)
    this.buffers.set(key, buffer)
  }

  /**
   * Groups with unread lines, most unread first, each with its latest lines.
   * The shown lines count as seen; the groups stay unread until she reads them.
   * @param lines - latest lines per group (`groups.glanceLines`).
   * @returns the glance, and the lines she sees now for the first time.
   */
  glance(lines: number): { groups: Glance[]; fresh: MessageStimulus[] } {
    const fresh: MessageStimulus[] = []
    const groups = [...this.buffers].filter(([, buffer]) => buffer.unread > 0)
      .sort((a, b) => b[1].unread - a[1].unread)
      .map(([key, buffer]) => {
        const shown = buffer.lines.slice(-Math.min(lines, buffer.unread))
        for (const line of shown) if (!line.seen) { line.seen = true; fresh.push(line.message) }
        return { key, channel: buffer.channel, unread: buffer.unread, latest: shown.map(line => line.message) }
      })
    return { groups, fresh }
  }

  /**
   * Read one group: up to `count` lines ending just before message `before`
   * (or the newest), oldest first. Reading marks the group read.
   * @returns the lines and those she sees for the first time, or undefined for a group with no buffer.
   */
  read(key: string, count: number, before?: string): { channel: PublishedChannel; lines: MessageStimulus[]; fresh: MessageStimulus[]; earlier: boolean } | undefined {
    const buffer = this.buffers.get(key)
    if (buffer === undefined) return undefined
    let end = buffer.lines.length
    if (before !== undefined && before !== '') {
      const index = buffer.lines.findIndex(line => line.message.messageId === before)
      if (index >= 0) end = index
    }
    const start = Math.max(0, end - count)
    const shown = buffer.lines.slice(start, end)
    const fresh = shown.filter(line => !line.seen).map(line => line.message)
    for (const line of shown) line.seen = true
    buffer.unread = 0
    return { channel: buffer.channel, lines: shown.map(line => line.message), fresh, earlier: start > 0 }
  }

  /**
   * The group's unseen lines, taken into a burst that reaches her (an @ of her,
   * the attention window): they count as seen and the group as read.
   */
  takeUnseen(key: string): MessageStimulus[] {
    const buffer = this.buffers.get(key)
    if (buffer === undefined) return []
    const unseen = buffer.lines.filter(line => !line.seen)
    for (const line of unseen) line.seen = true
    buffer.unread = 0
    return unseen.map(line => line.message)
  }

  /** Unread lines per group key (status). */
  unread(): Record<string, number> {
    return Object.fromEntries([...this.buffers].filter(([, b]) => b.unread > 0).map(([key, b]) => [key, b.unread]))
  }
}
