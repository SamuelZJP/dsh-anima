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
- `bundle/` declares `dsh.bundle` with a `cordis.patch.yml` that inserts rows by package name.
- Composition order: bundles in `dsh.profile.bundles` order, then the profile's `cordis.patch.yml`, then `$DSH_HOME/cordis.patch.yml`, then each `--patch` file. Later layers replace a row's whole `config`.
- Dev profile: `anima-dev`. Boot with `pnpm dsh --profile anima-dev [--patch x.yml]`.

## APIs relied on

| API | Used for | Status |
|---|---|---|
| `ctx.tools.register`, `defineTool`, `exec.concludeTurn()` | every behavior; closing behaviors | Verified |
| `tools/pre-execute` waterfall, `PreToolDecision` | the guard's gate | Verified |
| `register(def, { when })`, `tools.resolve` | tool visibility | Verified |
| `@deepseek-ai/dsh-agent-preset` rows, `hideTools` | the day-session preset | Verified |
| `sessionController.create` / `resolveAgent` | opening the day session | Verified |
| `Agent.steer`, `Agent.followup`, `Agent.inject`, `createUserMessage` | stimulus delivery | `followup`, `inject` verified; `steer` read |
| `agent/pre-step` waterfall, `ContextFormed` form `recall` | memories coming to mind | Verified |
| `agent/turn-stopping` (serial; `steer` inside runs another step) | close reminders | Read |
| `session/event` (`turn/end` with `reason`, `user/message`, `tool/call`, `tool/result`, usage) | budgets, activity log | Verified |
| `ctx.systemPrompt.section`, `.context`, `suppressRuntimeContext()` | prompt structure | Verified |
| `ctx.commands.register` | owner commands | Verified |
| `dsh-tool-schedule` row, `source.kind: 'schedule'` | her alarms | Verified |
| `dsh-compaction-basic` | working memory fading | Verified in triage use; not yet over a full day |
| `ImageBlock` in messages and tool results, `ctx.attachments.saveImage`, `resolveModelInfo().inputModalities` | `qq_look`, close views | Verified / read |
| `ctx.connection.fetch.register`, client slots `sidebar.panellist` and `main`, `dsh.client` manifest | `anima-page` | Verified |
| `ctx.configEditor` | Settings tab | Verified |
| Cordis `Events` augmentation, `ctx.emit`, `ctx.bail` | events between Anima packages; the outside's hooks `anima/admit`, `anima/owner-message`, `anima/friend-request` (first non-undefined answer wins) | Verified (bail: R1 unit tests) |
| `node:sqlite` `DatabaseSync`, FTS5 `trigram` | memory store | Verified |
| `executeToolFixture` (`dsh-tool-testkit`, `@internal`) | tests | Verified |

**Needed by the redesign, not yet checked:**
- Reading an archived session's full event log from a plugin, for consolidation in sleep.
- Archiving a session from a plugin.
- One session running a whole day: compaction behaviour and cost over many hours.

## Traps

- **Compaction config:** `dsh-compaction-basic` rejects a `thresholdRatio` at or below its `retainRatio` at load. Inside a preset that leaves agent creation pending forever. Do not lower `thresholdRatio`.
- **Deferred tools:** a session keeps the tool set it was created with. After changing `hideTools`, start a fresh session.
- **Working-directory line:** required at the pin; `suppressRuntimeContext` removes every other runtime context, and DSH restores this one.
- **Tool names:** providers accept only `[A-Za-z0-9_-]{1,64}`.
- **Real clock:** DSH's schedule and event timestamps use the real clock even under a sped-up Anima clock.
- **`--patch` needs `--profile`.**
- **Session-log upload** is on by default in `dsh-base`; turn it off in any profile where real people talk to her.
- **`dsh plugin`** runs whichever `pnpm` is on PATH in the profile directory.
- **Sidebar recency:** sessions fed by a custom source kind do not rise in the sidebar's order.
