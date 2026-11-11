/**
 * Calls to the page's Host routes (`/api/anima/view`, `/api/anima/action`).
 * Document-relative URLs, so the browser session cookie authenticates them.
 */

/** A failed call, with the Anima error code when the Host gave one. */
export class PageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as { value?: T; error?: { code: string; hint: string } } | undefined
  if (!response.ok || body === undefined || body.error !== undefined) {
    throw new PageError(body?.error?.code ?? `http/${response.status}`, body?.error?.hint ?? response.statusText)
  }
  return body.value as T
}

/**
 * Read one owner view.
 * @param name - view name, e.g. `status`.
 * @param params - query parameters.
 */
export async function view<T>(name: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const query = new URLSearchParams({ name })
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value))
  return parse<T>(await fetch(`api/anima/view?${query.toString()}`, { headers: { accept: 'application/json' } }))
}

/**
 * Run one owner action.
 * @param name - action name, e.g. `pause`.
 * @param args - JSON arguments.
 */
export async function action<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return parse<T>(await fetch('api/anima/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name, args }),
  }))
}
