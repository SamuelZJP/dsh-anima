/**
 * Bilibili adapter configuration. Limits on her behavior (calls per hour,
 * close views per day, frames, video length) live in the core gate's
 * `quotas` and `limits`; this config holds transport pacing, digest sizes
 * and how a close view is made.
 * @module @anima/adapter-bili/config
 */

import { AnimaError, DEFAULT_MODEL, type ModelRoute } from '@anima/core'
import z from '@deepseek-ai/schemastery'

/** Plugin config of `@anima/adapter-bili`. */
export interface Config {
  /** Real milliseconds between two HTTP requests (transport pacing, plus jitter). */
  minGapMs: number
  /** Real seconds one HTTP request may take. */
  requestTimeoutSeconds: number
  /** First back-off after risk control (code -352); doubles up to `maxBackoffSeconds`. */
  backoffSeconds: number
  maxBackoffSeconds: number
  /** Items per page in skim lists. */
  listSize: number
  /** Size caps of the `bili_watch` digest, in characters per section. */
  digest: {
    descriptionChars: number
    subtitleChars: number
    danmakuItems: number
    commentItems: number
    commentChars: number
  }
  /** Play-URL quality id for close views: 16 = 360p, 32 = 480p. */
  quality: number
  /** Close views (tier 2). */
  closeView: {
    /** Off: `bili_view_closely` is not registered and ffmpeg is not needed. */
    enabled: boolean
    /** Frames shown per view; the gate's `limits` cap this too. */
    framesPerView: number
    /** A fallback frame at least every this many seconds of video. */
    fallbackEverySeconds: number
    /** ffmpeg scene-change threshold, 0–1. */
    sceneThreshold: number
    /** Frame width in pixels (height keeps the aspect). */
    frameWidth: number
    /** Vision-capable model of the viewing session. */
    model: ModelRoute
    /** Real seconds the viewing turn may take. */
    timeoutSeconds: number
  }
  /** Download cache under `<dataDir>/bili/cache`; files are deleted after each view. */
  cache: { maxMegabytes: number }
  /** ffmpeg binary. */
  ffmpegPath: string
}

const modelRoute = z.object({
  provider: z.string().default(DEFAULT_MODEL.provider),
  model: z.string().default(DEFAULT_MODEL.model),
})

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  minGapMs: z.number().min(0).default(1500).description('Real milliseconds between Bilibili requests (pacing, plus jitter).'),
  requestTimeoutSeconds: z.number().min(1).default(20),
  backoffSeconds: z.number().min(1).default(60).description('First back-off after Bilibili risk control (-352); doubles each time.'),
  maxBackoffSeconds: z.number().min(1).default(3600),
  listSize: z.natural().min(1).max(30).default(10).description('Videos per page in feed, popular and search.'),
  digest: z.object({
    descriptionChars: z.natural().default(400),
    subtitleChars: z.natural().default(6000),
    danmakuItems: z.natural().default(40),
    commentItems: z.natural().default(10),
    commentChars: z.natural().default(200),
  }).description('Size caps of a watch digest.'),
  quality: z.natural().default(16).description('Play-URL quality id for close views (16 = 360p).'),
  closeView: z.object({
    enabled: z.boolean().default(true).description('Close views need ffmpeg; turn off to skip them.'),
    framesPerView: z.natural().min(1).default(12),
    fallbackEverySeconds: z.number().min(1).default(20),
    sceneThreshold: z.number().min(0).max(1).default(0.3),
    frameWidth: z.natural().min(64).default(512),
    model: modelRoute.description('Vision-capable model of the viewing session.'),
    timeoutSeconds: z.number().min(10).default(300),
  }),
  cache: z.object({ maxMegabytes: z.number().min(1).default(200) }),
  ffmpegPath: z.string().default('ffmpeg'),
}) as unknown as z<Config>

/** Validated config. */
export type ResolvedBiliConfig = Readonly<Config>

/**
 * Validate config. Fails loud with `anima/config-invalid`.
 * @param input - raw config from the loader or a test.
 */
export function resolveBiliConfig(input: unknown): ResolvedBiliConfig {
  try {
    return Object.freeze(Config((input ?? {}) as Config))
  } catch (error: unknown) {
    throw new AnimaError('anima/config-invalid', `${error instanceof Error ? error.message : String(error)}. Check the anima-adapter-bili row.`)
  }
}
