/**
 * Host half of `@anima/page`: authenticated owner routes the Anima page in
 * DSH's web UI calls (DESIGN §12, docs/DSH-INTEGRATION.md §8e). Every read is
 * an owner view and every write an owner action of the `anima` service, the
 * same functions the `/anima` commands call; actions are logged with source
 * `page`. Settings are read and written through DSH's config editor.
 * @module @anima/page
 */
import type { Context } from '@deepseek-ai/cordis'
import { AnimaError, type ViewParams } from '@anima/core'
import type {} from '@anima/core'
import { registerSettings } from './settings.ts'

export { editableRows, redact, settingsRows, type ConfigEditorLike, type SettingsRow } from './settings.ts'

/** Cordis plugin name. */
export const name = 'anima-page'
/** Services used. */
export const inject = ['anima', 'connection']

/** Path of the view route. */
export const VIEW_PATH = '/api/anima/view'
/** Path of the action route. */
export const ACTION_PATH = '/api/anima/action'

/** One exact route on DSH's `/api` channel (`dsh-client-connection` `ConnectionFetchRoute`). */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH's Connection service; only the exact-route registry is used. */
    connection: { readonly fetch: { register(route: FetchRoute): () => Promise<void> } }
  }
}

/** JSON error body: `{ error: { code, hint } }`. */
function failure(error: unknown): Response {
  if (error instanceof AnimaError) {
    return Response.json({ error: { code: error.code, hint: error.message.replace(`${error.code}: `, '') } }, { status: 400 })
  }
  const text = error instanceof Error ? error.message : String(error)
  const code = /^([a-z]+\/[a-z-]+): /.exec(text)?.[1]
  return Response.json({ error: { code: code ?? 'anima/page-error', hint: code === undefined ? text : text.slice(code.length + 2) } }, { status: code === undefined ? 500 : 400 })
}

/**
 * Handle `GET /api/anima/view?name=<view>&<params>`.
 * @param ctx - context with `anima`.
 * @param request - the request.
 */
export async function handleView(ctx: Context, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url, 'http://anima.invalid')
    const name = url.searchParams.get('name')
    if (name === null || name === '') throw new AnimaError('anima/bad-args', 'the "name" query parameter is required.')
    const params: Record<string, string> = {}
    for (const [key, value] of url.searchParams) if (key !== 'name') params[key] = value
    const value = await ctx.anima.ownerView(name, params as ViewParams)
    return Response.json({ value: value ?? null }, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    return failure(error)
  }
}

/**
 * Handle `POST /api/anima/action` with `{ name, args }`.
 * @param ctx - context with `anima`.
 * @param request - the request.
 */
export async function handleAction(ctx: Context, request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => undefined) as { name?: unknown; args?: unknown } | undefined
    if (body === undefined || typeof body.name !== 'string') throw new AnimaError('anima/bad-args', 'send JSON { "name": "<action>", "args": { … } }.')
    const args = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args as Record<string, unknown> : {}
    const value = await ctx.anima.ownerAction(body.name, args, 'page')
    return Response.json({ value: value ?? null }, { headers: { 'cache-control': 'no-store' } })
  } catch (error: unknown) {
    return failure(error)
  }
}

/**
 * Register the page routes and the Settings surface.
 * @param ctx - root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: VIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleView(ctx, request),
  }), 'anima-page: view route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: ACTION_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleAction(ctx, request),
  }), 'anima-page: action route')
  registerSettings(ctx)
}
