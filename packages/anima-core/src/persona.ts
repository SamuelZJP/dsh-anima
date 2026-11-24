/**
 * Per-session persona prompt (DESIGN §9), mounted as a child row of every
 * Anima preset: constitution, then the Chinese environment primer. Like `dsh-persona`, it
 * shadows the deployment persona inside that agent's scope only, and makes it
 * the complete system prompt so DSH's coding-agent guidance does not apply.
 * It also hides global tools that do not belong in her sessions.
 * @module @anima/core/persona
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { primerText, viewingText, type PlaceFacts } from './primer.ts'
import type { SessionKind } from './types.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from './service.ts'

/** Cordis plugin name. */
export const name = 'anima-persona'
/** Services used. */
export const inject = ['systemPrompt', 'anima', 'tools']

/**
 * Global tools hidden by default. `working_directory` let her look at her
 * workspace without any file tool; she concluded she could not work there.
 */
export const DEFAULT_HIDDEN_TOOLS: readonly string[] = ['working_directory', 'anima_ping']

/** Child-row config: which session kind this preset serves (`viewing`: a close view's subagent, not an Anima session). */
export interface Config {
  kind: SessionKind | 'viewing'
  /** Global tools hidden in this session (names that are not registered are skipped). */
  hideTools: string[]
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  kind: z.union([z.const('waking'), z.const('consolidation'), z.const('viewing')]).required(),
  hideTools: z.array(z.string()).default([...DEFAULT_HIDDEN_TOOLS]).description('Global tools hidden in this session; unregistered names are skipped.'),
}) as z<Config>

/**
 * Assemble the persona prompt (DESIGN §9): constitution, her world, this place, session rules.
 * @param constitution - the owner's constitution text.
 * @param facts - the session's facts, or just its kind (no channel, no tools).
 * @returns the complete system prompt text.
 */
export function personaText(constitution: string, facts: PlaceFacts | SessionKind): string {
  return primerText(constitution, typeof facts === 'string' ? { kind: facts, tools: [] } : facts)
}

/** Name of the self-model context contribution. */
export const SELF_MODEL_CONTEXT = 'anima-self-model'
const SELF_MODEL_ORDER = 50

function prefixSection(ctx: Context, constitution: string, kind: SessionKind | 'viewing'): () => void {
  return ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    // "This place" is generated per session from the places she can reach and her tools.
    text: context => kind === 'viewing' ? viewingText(constitution) : personaText(constitution, ctx.anima.placeFacts((context as { agent?: { id: string } }).agent?.id, kind)),
    interpolate: false,
    complete: true,
  })
}

/**
 * Register the persona sections in the mounting agent scope.
 * @param ctx - an agent scope context (preset child).
 * @param config - session kind.
 */
export function apply(ctx: Context, config: Config): void {
  // The prefix is re-registered when the owner saves a new constitution, so
  // running sessions get it on their next request.
  let current = ctx.anima.constitution()
  let disposePrefix = ctx.effect(() => prefixSection(ctx, current, config.kind), 'anima-persona.section()')
  ctx.on('anima/constitution', (text) => {
    if (text === current) return
    current = text
    disposePrefix()
    disposePrefix = ctx.effect(() => prefixSection(ctx, current, config.kind), 'anima-persona.section()')
  })
  // Her self-model digest: a logged context snapshot, re-sent only when it changes (DESIGN §9).
  if (config.kind !== 'viewing') {
    // Every note with its id: she may change one, awake or in sleep's consolidation.
    const full = true
    ctx.effect(() => ctx.systemPrompt.context({
      name: SELF_MODEL_CONTEXT,
      order: SELF_MODEL_ORDER,
      text: () => ctx.anima.selfModel.digest(full),
      interpolate: false,
      required: true,
    }), 'anima-persona.selfModel()')
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SUFFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    text: '',
  }), 'anima-persona.suffix()')
  // No coding-agent context (DESIGN §9): DSH drops every runtime context not marked required
  // (sandbox, approval policy, harness checkout, Web GUI URL). The working-directory line is
  // required at the pinned DSH and is restored on every request, so it stays (DSH-INTEGRATION §11).
  ctx.effect(() => ctx.systemPrompt.suppressRuntimeContext(), 'anima-persona.suppressRuntimeContext()')
  // tools.restrict rejects unknown names, and which global tools exist depends on the profile.
  const hidden = config.hideTools.filter(name => ctx.tools.get(name) !== undefined)
  if (hidden.length > 0) ctx.effect(() => ctx.tools.restrict({ deny: hidden }), 'anima-persona.restrict()')
}
