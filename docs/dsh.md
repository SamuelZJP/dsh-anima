# DSH

What Anima relies on in DSH (DeepSeek Harness). How each API behaved when it was first verified, with file references, is in `history/DSH-INTEGRATION.md`.

## Pinned version

| Item | Pin |
|---|---|
| DSH runtime | npm `@deepseek-ai/dsh@0.2.2-rc.1`, exact devDependency of the workspace root; run as `pnpm dsh …` |
| DSH packages for types and tests | `@deepseek-ai/dsh-*@0.2.2-rc.1`, exact, as both peer and dev dependencies |
| Cordis | `@deepseek-ai/cordis ~4.1.0` |
| Reference source | tag `dsh-v0.2.2-rc.1` (commit `66491b05e3f0`) in `~/Project/dev/dsh-src`. Read it with `git show dsh-v0.2.2-rc.1:<path>`, never from HEAD |
| Node / pnpm | Node ≥ 24.9, pnpm 11.28.5 via corepack |

**Upgrade:** bump every `0.2.2-rc.1` and `engines.dsh` range, re-read the APIs below at the new tag, rebuild, run the tests, repeat the current phase's demo, update this file.

## Packaging

- A pnpm workspace; each plugin is a package under `@anima/` (`private: true`), built to `lib/` (installed DSH runs plain Node).
- Two bundles, because the plugin is the persona and the outside is not part of it. `bundle/` (`@anima/bundle`, the Anima plugin) inserts only the persona rows (core, life, memory, adapters, presets). `guard-bundle/` (`@anima/guard-bundle`) inserts `anima-guard` and `anima-page`. Each declares `dsh.bundle` with a `cordis.patch.yml` that inserts rows by package name; each is added to a profile with `dsh plugin add`.
- Composition order: bundles in `dsh.profile.bundles` order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then each `--patch` file. Later layers replace a row's whole `config`.
- Dev profile: `anima-dev`. Boot with `pnpm dsh --profile anima-dev [--patch x.yml]`.

## APIs relied on

| API | Used for | Status |
|---|---|---|
| `ctx.tools.register`, `defineTool`, `exec.concludeTurn()` | every behavior; closing behaviors | Verified |
| `tools/pre-execute` waterfall, `PreToolDecision` | the guard's gate | Verified |
| `register(def, { when })`, `tools.resolve` | tool visibility | Verified |
| `@deepseek-ai/dsh-agent-preset` rows, `hideTools` | the waking, consolidation and viewing presets | Verified |
| `sessionController.create` / `resolveAgent` | opening a waking session | Verified |
| `Agent.steer`, `Agent.followup`, `Agent.inject`, `createUserMessage` | stimulus delivery | Verified (spike, 2026-11-15: `steer` into an idle agent starts a turn; during a tool call it joins the same turn as the next step after the tool result; `inject` starts no turn and joins the next turn ahead of its waking message) |
| `workspaceRegistry.archiveSession(id, { stopActivity? })`, `archivedSessionIds` | archiving a waking session at sleep | Verified (spike, 2026-11-15). A plain archive is refused (`WorkspaceActiveSessionError`, `activity[].kind` `turn` or `schedule`) while a turn runs or an alarm targets the session; `stopActivity: true` cancels the turn and **deletes** those alarms. A wake into an archived session ends as `turn/end` `blocked`, with no request, and the message is not logged as a `user/message` |
| `schedule.create`, `schedule.edit({ action: 'update', patch: { target } })`, `schedule.view` | moving her alarms into the next waking's session before the ended one is archived | Verified (spike, 2026-11-15): a moved alarm fires into the other session and starts a turn there (`user/message` with `source.kind: 'schedule'`) |
| `sessionPersistence.open(id, 'read')` → `handle.read(0)`, `handle.close()` | reading an archived waking session's log (consolidation, R5) | Verified (spike, 2026-11-15): after `sessions.flush`, the full log of an archived session reads back. `sessionQuery.readSurface` returns only the current model surface (10 of 39 events), not the log. `sessionQuery.traceSession` returns lineage, not events |
| `agent/pre-step` waterfall, `ContextFormed` form `recall` | memories coming to mind; the waking context and the `[闹钟]` line at an alarm's first step | Verified (recall); waking context: unit-tested, R4 exit demo |
| `session/event` (`turn/start`, `turn/end` with `reason`, `user/message`, `tool/call`, `tool/result`, usage) | whether a turn runs in her waking session (overwhelming sleep waits for it; archive after the last turn), budgets, activity log | Verified |
| `ctx.systemPrompt.section`, `.context`, `suppressRuntimeContext()` | prompt structure | Verified |
| `ctx.commands.register` | owner commands | Verified |
| `ctx.get('schedule')`: `create` (`timing: { kind: 'after' }`, `target: { kind: 'session' }`), `list`, `edit` (`delete`); deliveries carry `source.kind: 'schedule'` | her alarms (`alarm_set`, `alarm_list`, `alarm_cancel`; DSH's own `schedule_*` tools are not in her presets) | Unit-tested with a fake service; the service is in `dsh-base` |
| `dsh-compaction-basic` | working memory fading | Verified in triage use; not reached in an 11-hour waking (below) |
| `ImageBlock` in messages and tool results, `ctx.attachments.saveImage`, `resolveModelInfo().inputModalities` | `qq_look`, close views | Verified / read |
| `ctx.connection.fetch.register`, client slots `sidebar.panellist` and `main`, `dsh.client` manifest | `anima-page` | Verified |
| `ctx.configEditor` | Settings tab | Verified |
| Cordis `Events` augmentation, `ctx.emit`, `ctx.bail` | events between Anima packages; the outside's hooks `anima/admit`, `anima/owner-message`, `anima/friend-request` (first non-undefined answer wins) | Verified (bail: R1 unit tests) |
| `ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', request: { parent, agentPreset, agentOptions, prompt } })` | a close view's perception as a subagent of her waking session | Verified (spike, 2026-11-24): started from inside a tool's `execute` with `exec.agent` as parent, on its own bare preset and `deepseek-flash`, with a text and an image attachment in `prompt`; the tool awaits `result.output` (5.5 s). The child saw the image. The parent gets no message from it, only a `subagent/catalog` event; its turn goes on after the tool result. The child is a durable session of its own, offered only global tools without a `when` that matches it (`working_directory`) |
| `node:sqlite` `DatabaseSync`, FTS5 `trigram` | memory store | Verified |
| `executeToolFixture` (`dsh-tool-testkit`, `@internal`) | tests | Verified |

**Long wakings (R4 exit demo, `deepseek-flash`, clock at 30×):** an 11-hour waking (16 turns: heartbeats, three chats, alarms) used 15.5k uncached input, 265k cache-read and 4.6k output tokens, with no compaction; a 7-hour evening (13 turns) 8.9k, 215k and 3.5k. A full 16-hour waking was not reached (she went to bed after 11 hours); its compaction is still unobserved.

The spike that verified the session rows above (2026-11-15) is `scripts/spikes/r2-spike.mjs` (overlay: `scripts/spikes/r2-overlay.mjs`; every Anima row off, two throwaway sessions on a bare preset). The subagent row was verified by `scripts/spikes/r4-spike.mjs` (overlay `r4-overlay.mjs`, the same way).

## Models

- **DeepSeek sees images.** Her usual model, DeepSeek-V4.1-Flash (DSH id `deepseek-flash`), is natively multimodal, and DSH's default DeepSeek catalog declares `inputModalities: ['text', 'image']` for it. Later DeepSeek versions will most likely see too. So `qq_look` and close views work on her own chat model; `anima/no-vision` only comes up on a route whose catalog entry lacks `image`. At the pin, that includes DSH's `deepseek-v4-pro` entry.

## Traps

- **Compaction config:** `dsh-compaction-basic` rejects a `thresholdRatio` at or below its `retainRatio` at load. Inside a preset that leaves agent creation pending forever. Do not lower `thresholdRatio`.
- **Deferred tools:** a session keeps the tool set it was created with. After changing `hideTools`, start a fresh session.
- **Working-directory line:** required at the pin; `suppressRuntimeContext` removes every other runtime context, and DSH restores this one.
- **Tool names:** providers accept only `[A-Za-z0-9_-]{1,64}`.
- **Real clock:** DSH's schedule and event timestamps use the real clock even under a sped-up Anima clock. `alarm_set` turns her clock's time into a real delay, so her alarms ring at her time.
- **`--patch` needs `--profile`.**
- **Session-log upload** is on by default in `dsh-base`; turn it off in any profile where real people talk to her.
- **`dsh plugin`** runs whichever `pnpm` is on PATH in the profile directory.
- **Sidebar recency:** sessions fed by a custom source kind do not rise in the sidebar's order.
- **Moving an alarm posts a notice:** `schedule.edit` with a new target adds a `[SCHEDULE CHANGE]` user message (source `schedule`) to the target session. It is not a delivery: only a message carrying `reminder_prompt_json` / `reminders_json` is an alarm ringing.
- **An alarm during a turn waits:** an alarm that comes due while a turn runs in its session is delivered after that turn ends, as a new turn there. If she fell asleep at the end of that turn, it lands in the ended waking; life rejects that step and rings it in her current waking.
