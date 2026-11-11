/**
 * Frame extraction for close views with the system `ffmpeg`: the first
 * frame, frames at scene changes, and a fallback frame every N seconds,
 * scaled down; then K of them spread over time.
 * @module @anima/adapter-bili/frames
 */

import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { AnimaError } from '@anima/core'

/** One extracted frame. */
export interface Frame {
  readonly file: string
  /** Seconds into the video. */
  readonly t: number
}

/**
 * Check that ffmpeg runs. Fails loud at load, since a close view needs it.
 * @param ffmpeg - binary name or path.
 * @returns the first line of `ffmpeg -version`.
 */
export function checkFfmpeg(ffmpeg: string): string {
  try {
    const out = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
    return out.split('\n')[0] ?? 'ffmpeg'
  } catch (error: unknown) {
    throw new AnimaError('anima/ffmpeg-missing', `"${ffmpeg}" does not run (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Close views on Bilibili need ffmpeg: install it (WSL2/Ubuntu: sudo apt install ffmpeg), set ffmpegPath in the anima-adapter-bili row, or set closeView.enabled: false.`)
  }
}

/** Options of one extraction. */
export interface ExtractOptions {
  readonly ffmpeg: string
  readonly input: string
  readonly outDir: string
  /** Fallback frame at least every this many seconds. */
  readonly everySeconds: number
  /** Scene-change threshold, 0–1. */
  readonly sceneThreshold: number
  readonly width: number
  /** Most candidate frames ffmpeg writes. */
  readonly maxCandidates: number
  readonly signal?: AbortSignal | undefined
}

/** The ffmpeg arguments of an extraction (exported for tests). */
export function ffmpegArgs(options: ExtractOptions): string[] {
  const select = `select='isnan(prev_selected_t)+gt(scene\\,${options.sceneThreshold})+gte(t-prev_selected_t\\,${options.everySeconds})'`
  return [
    '-hide_banner', '-nostats', '-loglevel', 'info', '-i', options.input, '-an', '-sn',
    '-vf', `${select},scale=${options.width}:-2,showinfo`,
    '-fps_mode', 'vfr', '-frames:v', String(options.maxCandidates), '-q:v', '5',
    join(options.outDir, 'f%03d.jpg'),
  ]
}

/**
 * Run ffmpeg and return the candidate frames with their timestamps (from `showinfo`).
 * @returns frames in time order.
 */
export function extractFrames(options: ExtractOptions): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffmpeg, ffmpegArgs(options), { stdio: ['ignore', 'ignore', 'pipe'], ...options.signal === undefined ? {} : { signal: options.signal } })
    const times: number[] = []
    let tail = ''
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = /Parsed_showinfo.*\bpts_time:\s*([0-9.]+)/.exec(line)
        if (match !== null) times.push(Number(match[1]))
        else tail = line
      }
    })
    child.on('error', error => reject(new AnimaError('anima/ffmpeg-failed', `ffmpeg did not start: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new AnimaError('anima/ffmpeg-failed', `ffmpeg exited with ${code}: ${tail.trim()}`))
      resolve(times.map((t, i) => ({ file: join(options.outDir, `f${String(i + 1).padStart(3, '0')}.jpg`), t })))
    })
  })
}

/**
 * Pick `k` frames spread over time.
 * @param frames - candidates in time order.
 */
export function pickSpread(frames: readonly Frame[], k: number): Frame[] {
  if (frames.length <= k) return [...frames]
  if (k <= 1) return frames.slice(0, Math.max(0, k))
  const picked = new Set<number>()
  for (let i = 0; i < k; i++) picked.add(Math.round((i * (frames.length - 1)) / (k - 1)))
  return [...picked].sort((a, b) => a - b).map(i => frames[i]!)
}
