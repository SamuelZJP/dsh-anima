/**
 * Anima core plugin. Phase 0 registers only the `anima_ping` integration probe.
 * @module @anima/core
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'anima-core'
/** Services used by the plugin. */
export const inject = ['tools']

/** Name of the integration probe tool. */
export const PING_TOOL = 'anima_ping'

/**
 * Register Anima core contributions.
 * @param ctx - context providing the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: PING_TOOL,
    description: 'Check that the Anima plugin is loaded. Returns "pong", echoing the optional message.',
    parameters: {
      message: { type: 'string', description: 'Optional text to echo back.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pong: { type: 'boolean', required: true, description: 'Always true.' },
          echo: { type: 'string', description: 'The message argument, when given.' },
          at: { type: 'string', required: true, description: 'Host time of the call, ISO 8601.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.echo === undefined ? 'pong' : `pong: ${value.echo}` }],
    },
    async execute(args) {
      return {
        pong: true,
        ...args.message === undefined ? {} : { echo: args.message },
        at: new Date().toISOString(),
      }
    },
  }))
}
