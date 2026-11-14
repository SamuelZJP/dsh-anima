/**
 * The owner surface (docs/design/outside.md): every view, action and `/anima`
 * subcommand the owner has, in one place. They read and act on the persona
 * through its services; the page and the commands call the same actions, and
 * every action is logged with its source.
 * @module @anima/guard/surface
 */

import { AnimaError, channelKey, describeDiff, describeGoal, formatLocal, optionalStringArg, parseWhen, stringArg, type Goal, type PlatformView, type SelfDiff } from '@anima/core'
import type { Memory } from '@anima/memory'
import { memoryLine } from '@anima/memory'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { AnimaGuard } from './service.ts'

/**
 * Register the owner surface on a guard.
 * @param guard - the guard service.
 * @param ctx - the guard's context.
 */
export function registerSurface(guard: AnimaGuard, ctx: Context): void {
  const core = ctx.anima

  // ---- views ----
  guard.addOwnerView('status', () => guard.statusView())
  guard.addOwnerView('platforms', () => platformViews(ctx))
  guard.addOwnerView('goals', () => ({ goals: core.goals.all() }))
  guard.addOwnerView('approvals', () => ({
    ownerLine: core.ownerLine?.name ?? null,
    pending: guard.approvals.list().map(p => ({ id: p.id, summary: p.summary })),
  }))
  guard.addOwnerView('selfmodel', () => ({ entries: core.selfModel.entries(), diffs: core.selfModel.diffs().reverse() }))
  guard.addOwnerView('constitution', () => ({ text: core.constitution(), path: core.constitutionPath }))
  guard.addOwnerView('activity', (params) => {
    const days = guard.activity.days()
    const day = params.day ?? core.dayKey()
    return { day, days, summary: guard.daySummary(day), records: guard.activity.read(day) }
  })
  guard.addOwnerView('owner', () => guard.ownerNames())
  guard.addOwnerView('outbox', () => ({
    delaySeconds: guard.config.outbox.delaySeconds,
    held: guard.outbox.list().map(m => ({ id: m.id, display: m.display, channelKey: m.channelKey, intentId: m.intentId, text: m.text, sendsAt: m.sendsAt, offlineSince: m.offlineSince ?? null })),
  }))
  // ---- actions ----
  guard.addOwnerAction('pause', () => {
    guard.setPaused(true)
    return { paused: true }
  })
  guard.addOwnerAction('resume', () => {
    guard.setPaused(false)
    return { paused: false }
  })
  guard.addOwnerAction('wake', () => {
    const result = core.wakeByOwner()
    if (result.woken) guard.log({ type: 'woken', ...result.until === undefined ? {} : { until: result.until } })
    return result
  })
  guard.addOwnerAction('approve', args => ({ answered: guard.approvals.answer(stringArg(args, 'id').toLowerCase(), true) }))
  guard.addOwnerAction('deny', args => ({ answered: guard.approvals.answer(stringArg(args, 'id').toLowerCase(), false) }))
  guard.addOwnerAction('goal.add', (args) => {
    const now = core.clock.now()
    const dueText = optionalStringArg(args, 'due')
    let due = typeof args.dueAt === 'number' ? args.dueAt : undefined
    if (dueText !== undefined) {
      due = parseWhen(dueText, now)
      if (due === undefined) throw new AnimaError('anima/bad-time', `"${dueText}" is not a time like 2026-11-10 21:00 or 21:00.`)
    }
    return core.goals.add({ text: stringArg(args, 'text'), owner: 'owner', due, now })
  })
  guard.addOwnerAction('goal.close', args => core.goals.close(stringArg(args, 'id'), {
    status: args.status === 'dropped' ? 'dropped' : 'done',
    reason: optionalStringArg(args, 'reason'),
    by: 'owner',
    now: core.clock.now(),
  }))
  guard.addOwnerAction('selfmodel.revert', args => core.selfModel.revert(stringArg(args, 'id'), optionalStringArg(args, 'reason') ?? 'reverted by the owner', core.clock.now(), Date.now()))
  guard.addOwnerAction('constitution.save', (args) => {
    const text = args.text
    if (typeof text !== 'string') throw new AnimaError('anima/bad-args', '"text" must be a string.')
    return core.saveConstitution(text)
  })
  guard.addOwnerAction('outbox.cancel', args => ({ cancelled: guard.outbox.cancel(stringArg(args, 'id')) }))
  // Memory management, while the memory plugin is loaded.
  ctx.inject(['animaMemory'], (ctx) => {
    const store = ctx.animaMemory.store
    guard.addOwnerView('memory', (params) => {
      const status = params.status === 'archived' || params.status === 'superseded' || params.status === 'all' ? params.status : 'active'
      const limit = Math.min(200, Math.max(1, Number(params.limit ?? 50) || 50))
      const offset = Math.max(0, Number(params.offset ?? 0) || 0)
      const page = store.browse({ query: params.query, scope: params.scope, status, limit, offset })
      return { ...page, limit, offset, counts: store.counts(), scopes: store.scopes(), pending: store.pendingCount() }
    }, ctx)
    guard.addOwnerAction('memory.forget', args => ({ forgotten: store.forget(stringArg(args, 'id')) }), ctx)
    guard.addSubcommand({
      name: 'memory',
      usage: 'memory list [text] | memory forget <id> — inspect or delete memories (all scopes)',
      run: async (args) => {
        const [verb = '', ...rest] = args.split(/\s+/)
        const text = rest.join(' ').trim()
        switch (verb.toLowerCase()) {
          case 'list': {
            const all = await guard.ownerView('memory', { query: text, status: 'all', limit: '50' }).then(v => (v as { memories: Memory[] }).memories)
            if (all.length === 0) return { kind: 'success', text: 'No memories.' }
            return { kind: 'success', text: all.map(memory => `${memoryLine(memory, true)}${memory.status === 'active' ? '' : ` [${memory.status}${memory.replacedBy === undefined ? '' : ` by ${memory.replacedBy}`}]`}`).join('\n') }
          }
          case 'forget': {
            if (text === '') return { kind: 'error', text: 'Usage: /anima memory forget <id>' }
            const { forgotten } = await guard.ownerAction('memory.forget', { id: text }, 'command') as { forgotten: boolean }
            return forgotten ? { kind: 'success', text: `Deleted ${text}.` } : { kind: 'error', text: `No memory "${text}".` }
          }
          default:
            return { kind: 'error', text: 'Usage: /anima memory list [text] | memory forget <id>' }
        }
      },
    }, ctx)
  })

  // ---- subcommands ----
  const action = (name: string, args: Readonly<Record<string, unknown>> = {}) => guard.ownerAction(name, args, 'command')
  guard.addSubcommand({ name: 'status', usage: 'status — state, budgets, sessions and quota usage', run: () => ({ kind: 'success', text: guard.statusText() }) })
  guard.addSubcommand({
    name: 'pause', usage: 'pause — refuse every Anima behavior and stop heartbeats until resumed',
    run: async () => { await action('pause'); return { kind: 'success', text: 'Anima paused. Every behavior is refused and heartbeats stop until /anima resume.' } },
  })
  guard.addSubcommand({ name: 'resume', usage: 'resume — lift a pause', run: async () => { await action('resume'); return { kind: 'success', text: 'Anima resumed.' } } })
  guard.addSubcommand({
    name: 'wake', usage: 'wake — wake her on purpose while she sleeps (only the owner can)',
    run: async () => {
      const result = await action('wake') as { woken: boolean; until?: number }
      return { kind: 'success', text: result.woken ? `She is awake now, until she sleeps again or ${formatLocal(result.until!)}.` : 'She is not asleep.' }
    },
  })
  const answer = async (args: string, approve: boolean): Promise<CommandResult> => {
    const id = args.trim().toLowerCase()
    if (!/^a\d+$/.test(id)) return { kind: 'error', text: `Usage: /anima ${approve ? 'approve' : 'deny'} <id>, e.g. a3. Pending: ${guard.approvals.list().map(p => p.id).join(', ') || 'none'}` }
    const { answered } = await action(approve ? 'approve' : 'deny', { id }) as { answered: boolean }
    return answered ? { kind: 'success', text: `${approve ? 'Allowed' : 'Denied'} ${id}.` } : { kind: 'error', text: `No pending request ${id}.` }
  }
  guard.addSubcommand({ name: 'approve', usage: 'approve <id> — allow a pending approval request (same as replying "yes <id>" on the owner line)', run: args => answer(args, true) })
  guard.addSubcommand({ name: 'deny', usage: 'deny <id> — deny a pending approval request', run: args => answer(args, false) })
  guard.addSubcommand({
    name: 'goal', usage: 'goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason] — owner goals',
    run: async (args) => {
      const [verb = '', ...rest] = args.split(/\s+/)
      const text = args.slice(verb.length).trim()
      switch (verb.toLowerCase()) {
        case 'add': {
          const match = /^([\s\S]*?)\s+due\s+(.+)$/.exec(text)
          const body = match === null ? text : match[1]!
          let dueAt: number | undefined
          if (match !== null) {
            dueAt = parseWhen(match[2]!, core.clock.now())
            if (dueAt === undefined) return { kind: 'error', text: `"${match[2]}" is not a time like 2026-11-10 21:00 or 21:00.` }
          }
          const goal = await action('goal.add', { text: body, ...dueAt === undefined ? {} : { dueAt } }) as Goal
          return { kind: 'success', text: `Added ${describeGoal(goal)}` }
        }
        case 'list': {
          const all = core.goals.all()
          return { kind: 'success', text: all.length === 0 ? 'No goals.' : all.map(describeGoal).join('\n') }
        }
        case 'close': {
          const [id] = rest
          if (id === undefined) return { kind: 'error', text: 'Usage: /anima goal close <id> [reason]' }
          const reason = text.slice(id.length).trim()
          const goal = await action('goal.close', { id, ...reason === '' ? {} : { reason } }) as Goal
          return { kind: 'success', text: `Closed ${describeGoal(goal)}` }
        }
        default:
          return { kind: 'error', text: 'Usage: /anima goal add <text> [due <YYYY-MM-DD HH:mm>] | goal list | goal close <id> [reason]' }
      }
    },
  })
  guard.addSubcommand({
    name: 'selfmodel', usage: 'selfmodel [list] | selfmodel revert <dId> [reason] — her self-model notes and recent changes',
    run: async (args) => {
      const [verb = 'list', id, ...rest] = args.split(/\s+/).filter(word => word !== '')
      if (verb === 'list') {
        const entries = core.selfModel.entries()
        const diffs = core.selfModel.diffs().slice(-10)
        return {
          kind: 'success',
          text: [
            `Self-model notes (${entries.length}):`,
            ...entries.length === 0 ? ['  none yet'] : entries.map(e => `  ${e.id} [${e.section}] ${e.text}`),
            'Recent changes:',
            ...diffs.length === 0 ? ['  none yet'] : diffs.map(d => `  ${describeDiff(d)} — ${formatLocal(d.at)}, ${d.by}: ${d.reason}`),
          ].join('\n'),
        }
      }
      if (verb === 'revert' && id !== undefined) {
        const diff = await action('selfmodel.revert', { id, reason: rest.join(' ') || 'reverted by the owner' }) as SelfDiff
        return { kind: 'success', text: `Reverted: ${describeDiff(diff)}` }
      }
      return { kind: 'error', text: 'Usage: /anima selfmodel [list] | selfmodel revert <dId> [reason]' }
    },
  })
  guard.addSubcommand({
    name: 'outbox', usage: 'outbox [cancel <id>] — list her held initiated messages, or cancel one before it goes out',
    run: async (args) => {
      const [verb = '', id = ''] = args.split(/\s+/)
      if (verb === '') {
        const held = guard.outbox.list()
        if (held.length === 0) return { kind: 'success', text: `The outbox is empty (delay ${guard.config.outbox.delaySeconds} s).` }
        return { kind: 'success', text: held.map(m => `${m.id} → ${m.display} in ${Math.max(0, Math.round((m.sendsAt - Date.now()) / 1000))} s (intent ${m.intentId}): ${m.text}`).join('\n') }
      }
      if (verb.toLowerCase() !== 'cancel' || id === '') return { kind: 'error', text: 'Usage: /anima outbox [cancel <id>]' }
      const { cancelled } = await action('outbox.cancel', { id }) as { cancelled: boolean }
      return cancelled ? { kind: 'success', text: `Cancelled ${id.toLowerCase()}.` } : { kind: 'error', text: `No message ${id} in the outbox.` }
    },
  })
  // What needs her life loop, while it is loaded.
  ctx.inject(['animaLife'], (ctx) => {
    const life = ctx.animaLife
    guard.addOwnerView('inbox', () => ({
      channels: life.inbox.entries().map(({ key, channel, messages }) => ({
        key, display: channel.display,
        messages: messages.map(m => ({ ts: m.ts, sender: m.sender.displayName, isOwner: m.sender.isOwner, text: m.text, addressed: m.addressed === true, reason: m.reason })),
      })),
    }), ctx)

    guard.addOwnerAction('heartbeat', async () => {
      await life.beat()
      return { day: core.dayKey() }
    }, ctx)

    guard.addSubcommand({
      name: 'self', usage: 'self [text] — open her Self session; with text, deliver it there as an owner notice',
      run: async (args) => {
        if (args === '') {
          const agent = await life.router.ensureSelf()
          return { kind: 'success', text: `Self session: ${agent.id}. It shows in the sidebar after its first turn; use /anima self <text> to start one.` }
        }
        // A notice comes without a situation report, so it names the channels she can reach.
        const reachable = life.router.known().map(({ channel }) => `${channel.display}: "${channelKey(channel)}"`)
        const text = `The owner says: ${args}\nChannels you can reach: ${reachable.join('; ') || 'none'}.`
        const id = await life.deliver({ type: 'notice', text, ts: core.clock.now() })
        return { kind: 'success', text: `Delivered to the Self session ${id}.` }
      },
    }, ctx)
    guard.addSubcommand({
      name: 'heartbeat', usage: 'heartbeat — run a heartbeat now instead of at the scheduled time',
      run: async () => {
        await action('heartbeat')
        return { kind: 'success', text: `Heartbeat delivered to the triage session of ${core.dayKey()}.` }
      },
    }, ctx)
    guard.addSubcommand({
      name: 'inbox', usage: 'inbox — messages waiting for her while she sleeps or is paused',
      run: () => {
        const entries = life.inbox.entries()
        if (entries.length === 0) return { kind: 'success', text: 'Her inbox is empty.' }
        return {
          kind: 'success',
          text: entries.flatMap(({ key, channel, messages }) => [
            `${channel.display} (${key}): ${messages.length}`,
            ...messages.map(m => `  ${formatLocal(m.ts)} ${m.sender.displayName}${m.addressed === true ? ' (@her)' : ''} [${m.reason}]: ${m.text}`),
          ]).join('\n'),
        }
      },
    }, ctx)
  })

  // The `/anima` command itself, while DSH's commands service is present.
  ctx.inject(['commands'], (ctx) => {
    ctx.effect(() => ctx.commands.register({
      name: 'anima',
      description: 'Anima owner controls: /anima help lists subcommands',
      input: { hint: 'status | pause | resume | goal … | selfmodel … | chat <text> | self [text] | outbox | approve <id> | help' },
      handler: invocation => guard.dispatch(invocation),
    }), 'animaGuard.command')
  })
}

/** Every platform's view, for the Platforms tab. */
async function platformViews(ctx: Context): Promise<{ platform: string; title: string; view: PlatformView }[]> {
  const views = []
  for (const provider of ctx.anima.platforms()) {
    let view: PlatformView
    try {
      view = await provider.view()
    } catch (error: unknown) {
      view = { health: 'down', summary: `status failed: ${error instanceof Error ? error.message : String(error)}`, details: {} }
    }
    views.push({ platform: provider.platform, title: provider.title, view })
  }
  return views
}
