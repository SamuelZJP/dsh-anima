/**
 * The Bilibili endpoints Anima uses, mapped to plain data. Endpoint findings
 * (which need login or WBI) are recorded in this package's README.
 * @module @anima/adapter-bili/api
 */

import { AnimaError } from '@anima/core'
import type { BiliClient } from './client.ts'
import { parseDanmaku, parseDuration, parseSubtitle, type CommentItem, type TimedText, type VideoItem } from './digest.ts'

/** Video info from `x/web-interface/view`. */
export interface VideoInfo extends VideoItem {
  readonly aid: number
  readonly cid: number
  readonly category?: string | undefined
  readonly coins?: number | undefined
  readonly favorites?: number | undefined
  readonly replies?: number | undefined
  readonly parts: number
  readonly durationSeconds: number
}

/** A page of a skim list and the cursor for the next one. */
export interface Page {
  readonly items: VideoItem[]
  /** Pass back to get the next page; undefined at the end. */
  readonly next?: string | undefined
}

/** Subtitles of a video and where they came from. */
export interface Subtitles {
  readonly lines: TimedText[]
  readonly note: string
}

const BVID = /^BV[0-9A-Za-z]{10}$/

/** Check a bvid argument. */
export function checkBvid(bvid: string): string {
  const id = bvid.trim()
  if (!BVID.test(id)) throw new AnimaError('anima/bad-args', `"${bvid}" is not a bvid like BV1xx411c7mD; take it from a feed, popular or search line.`)
  return id
}

interface RawArchive {
  bvid?: string
  title?: string
  desc?: string
  duration?: number | string
  owner?: { name?: string }
  stat?: { view?: number; like?: number; danmaku?: number; coin?: number; favorite?: number; reply?: number }
  pubdate?: number
}

function fromArchive(v: RawArchive): VideoItem {
  return {
    bvid: v.bvid ?? '', title: v.title ?? '', author: v.owner?.name ?? '?',
    durationSeconds: parseDuration(v.duration), views: v.stat?.view, likes: v.stat?.like, danmaku: v.stat?.danmaku,
    description: v.desc, pubdate: v.pubdate,
  }
}

/** Typed endpoint calls over a {@link BiliClient}, with a short view-info cache. */
export class BiliApi {
  private readonly views = new Map<string, { info: VideoInfo; at: number }>()

  constructor(readonly client: BiliClient, private readonly now: () => number = Date.now) {}

  /** Popular videos (public). */
  async popular(page: number, size: number): Promise<Page> {
    const body = await this.client.request<{ list?: RawArchive[]; no_more?: boolean }>('/x/web-interface/popular', { ps: size, pn: page })
    const items = (body.data?.list ?? []).map(fromArchive)
    return { items, next: body.data?.no_more === true ? undefined : String(page + 1) }
  }

  /** Video search (public; WBI `search/all/v2`, whose video group answers without login). */
  async search(keyword: string, page: number, size: number): Promise<Page> {
    const body = await this.client.request<{ result?: { result_type?: string; data?: { bvid?: string; title?: string; author?: string; duration?: string; play?: number; like?: number; danmaku?: number; video_review?: number; description?: string; pubdate?: number }[] }[]; numPages?: number }>(
      '/x/web-interface/wbi/search/all/v2', { keyword, page }, { wbi: true },
    )
    const videos = (body.data?.result ?? []).find(group => group.result_type === 'video')?.data ?? []
    const items = videos.slice(0, size).map(v => ({
      bvid: v.bvid ?? '', title: v.title ?? '', author: v.author ?? '?', durationSeconds: parseDuration(v.duration),
      views: v.play, likes: v.like, danmaku: v.danmaku ?? v.video_review, description: v.description, pubdate: v.pubdate,
    }))
    const pages = body.data?.numPages ?? 0
    return { items, next: page < pages ? String(page + 1) : undefined }
  }

  /** New videos from uploaders her account follows (needs login). */
  async feed(offset: string | undefined, size: number): Promise<Page> {
    const body = await this.client.request<{ items?: { modules?: { module_author?: { name?: string; pub_ts?: number }; module_dynamic?: { major?: { archive?: { bvid?: string; title?: string; desc?: string; duration_text?: string; stat?: { play?: string; danmaku?: string } } } } } }[]; offset?: string; has_more?: boolean }>(
      '/x/polymer/web-dynamic/v1/feed/all', { type: 'video', ...offset === undefined || offset === '' ? {} : { offset } },
    )
    const items: VideoItem[] = []
    for (const item of body.data?.items ?? []) {
      const archive = item.modules?.module_dynamic?.major?.archive
      if (archive?.bvid === undefined) continue
      items.push({
        bvid: archive.bvid, title: archive.title ?? '', author: item.modules?.module_author?.name ?? '?',
        durationSeconds: parseDuration(archive.duration_text), views: countText(archive.stat?.play), danmaku: countText(archive.stat?.danmaku),
        description: archive.desc, pubdate: item.modules?.module_author?.pub_ts,
      })
    }
    return { items: items.slice(0, size), next: body.data?.has_more === true ? body.data.offset : undefined }
  }

  /** Video info, cached for 10 minutes (the gate's facts and the tool share it). */
  async view(bvid: string): Promise<VideoInfo> {
    const cached = this.views.get(bvid)
    if (cached !== undefined && this.now() - cached.at < 600_000) return cached.info
    const body = await this.client.request<RawArchive & { aid?: number; cid?: number; tname?: string; pages?: { cid?: number; duration?: number }[] }>('/x/web-interface/view', { bvid })
    const v = body.data
    if (v?.cid === undefined || v.aid === undefined) throw new AnimaError('anima/bili-error', `${bvid} has no playable part.`)
    const info: VideoInfo = {
      ...fromArchive(v), aid: v.aid, cid: v.cid, category: v.tname === '' ? undefined : v.tname,
      coins: v.stat?.coin, favorites: v.stat?.favorite, replies: v.stat?.reply,
      parts: Array.isArray(v.pages) ? v.pages.length : 1,
      // `duration` is the total of all parts; she watches part 1 (its cid), so its length is what counts.
      durationSeconds: Number(v.pages?.find(page => page.cid === v.cid)?.duration ?? v.pages?.[0]?.duration ?? v.duration ?? 0),
    }
    this.views.set(bvid, { info, at: this.now() })
    if (this.views.size > 200) this.views.delete(this.views.keys().next().value!)
    return info
  }

  /** Subtitles: a CC track first, else an AI track; Chinese preferred. */
  async subtitles(info: VideoInfo): Promise<Subtitles> {
    const body = await this.client.request<{ subtitle?: { subtitles?: { lan?: string; lan_doc?: string; subtitle_url?: string; ai_type?: number }[] }; need_login_subtitle?: boolean }>(
      '/x/player/wbi/v2', { bvid: info.bvid, cid: info.cid, aid: info.aid }, { wbi: true },
    )
    const tracks = (body.data?.subtitle?.subtitles ?? []).filter(track => (track.subtitle_url ?? '') !== '')
    if (tracks.length === 0) {
      return { lines: [], note: body.data?.need_login_subtitle === true && !this.client.login.isLogin ? 'none without login' : 'none' }
    }
    const isAi = (lan: string | undefined) => (lan ?? '').startsWith('ai-')
    const zh = (lan: string | undefined) => (lan ?? '').replace(/^ai-/, '').startsWith('zh')
    const ranked = [...tracks].sort((a, b) => Number(isAi(a.lan)) - Number(isAi(b.lan)) || Number(zh(b.lan)) - Number(zh(a.lan)))
    const track = ranked[0]!
    const lines = parseSubtitle(await this.client.text(track.subtitle_url!))
    return { lines, note: `${isAi(track.lan) ? 'AI' : 'CC'} ${track.lan_doc ?? track.lan ?? ''}`.trim() }
  }

  /** Danmaku of a video's first part. */
  async danmaku(info: VideoInfo): Promise<TimedText[]> {
    return parseDanmaku(await this.client.text(this.client.url(`/x/v1/dm/list.so?oid=${info.cid}`)))
  }

  /** Comments: hot first (`mode` 3), with the cursor for more. */
  async comments(info: VideoInfo, offset: string | undefined): Promise<{ items: CommentItem[]; next?: string | undefined }> {
    const body = await this.client.request<{ replies?: RawReply[] | null; top_replies?: RawReply[] | null; cursor?: { is_end?: boolean; pagination_reply?: { next_offset?: string } } }>(
      '/x/v2/reply/wbi/main', { oid: info.aid, type: 1, mode: 3, plat: 1, pagination_str: JSON.stringify({ offset: offset ?? '' }) }, { wbi: true },
    )
    const raw = [...offset === undefined ? body.data?.top_replies ?? [] : [], ...body.data?.replies ?? []]
    const items = raw.map(r => ({ author: r.member?.uname ?? '?', text: r.content?.message ?? '', likes: r.like ?? 0, replies: r.rcount }))
    const next = body.data?.cursor?.is_end === true ? undefined : body.data?.cursor?.pagination_reply?.next_offset
    return { items, next }
  }

  /** A single-file mp4 stream URL at a quality (16 = 360p). */
  async playUrl(info: VideoInfo, quality: number): Promise<{ url: string; bytes: number; quality: number }> {
    const body = await this.client.request<{ quality?: number; durl?: { url?: string; size?: number }[] }>(
      '/x/player/wbi/playurl', { bvid: info.bvid, cid: info.cid, qn: quality, fnval: 1, platform: 'html5', high_quality: 0 }, { wbi: true },
    )
    const first = body.data?.durl?.[0]
    if (first?.url === undefined) throw new AnimaError('anima/bili-error', `${info.bvid} has no single-file stream at quality ${quality}.`)
    return { url: first.url, bytes: first.size ?? 0, quality: body.data?.quality ?? quality }
  }
}

interface RawReply {
  member?: { uname?: string }
  content?: { message?: string }
  like?: number
  rcount?: number
}

/** Feed counts come as text (`1.2万`). */
export function countText(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const match = /^([0-9.]+)\s*(万|亿)?$/.exec(text.trim())
  if (match === null) return undefined
  return Math.round(Number(match[1]) * (match[2] === '亿' ? 1e8 : match[2] === '万' ? 1e4 : 1))
}
