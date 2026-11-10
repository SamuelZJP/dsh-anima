# DSH integration

How Anima plugs into DSH (DeepSeek Harness). Written in Phase 0. Each section is marked **Verified** (run in the Phase 0 demo) or **Read** (taken from DSH source at the pinned tag, not yet exercised by Anima). File references are relative to `~/Project/dev/dsh-src` at tag `dsh-v0.2.2-rc.1`; read them with `git show dsh-v0.2.2-rc.1:<path>`, not from the checkout's HEAD.

## 1. Pinned version

| Item | Pin |
| --- | --- |
| DSH runtime | npm `@deepseek-ai/dsh@0.2.2-rc.1`, exact devDependency of the workspace root; run as `pnpm dsh …` |
| DSH packages imported for types/tests | `@deepseek-ai/dsh-*@0.2.2-rc.1` (exact) |
| Cordis | `@deepseek-ai/cordis ~4.1.0` (what `dsh@0.2.2-rc.1` depends on) |
| Reference source | tag `dsh-v0.2.2-rc.1` = commit `66491b05e3f0` in `~/Project/dev/dsh-src`. Its HEAD (`fcc0ad4`) is 811 commits ahead; do not read HEAD for API facts |
| Node / pnpm | Node ≥ 24.9 (dev machine: 24.22), pnpm 11.28.5 via corepack (`packageManager` field) |

DSH is a developer preview with breaking changes between releases.

**Upgrade procedure:**
1. Bump every `0.2.2-rc.1` in the `package.json` files and every `engines.dsh` range.
2. Re-read the files cited in this document at the new tag, and diff the APIs listed in section 11.
3. Rebuild and re-run the tests.
4. Repeat the demo in section 3.
5. Update this file.

## 2. Packaging (Verified)

Anima is a pnpm workspace. Each plugin is its own package; one **bundle** package installs them all into a DSH profile.

```
package.json            root: pins @deepseek-ai/dsh, script "dsh": "dsh"
pnpm-workspace.yaml     packages/*, bundle; allowBuilds for DSH's native deps
packages/anima-core/    @anima/core — a Cordis plugin, built to lib/
bundle/                 @anima/bundle — declares dsh.bundle, depends on @anima/* via workspace:*
```

### Plugin package (`packages/anima-core/package.json`)

- `"type": "module"`.
- `exports["."]` points to built `lib/index.js`. The installed DSH runs plain Node, so the plugin ships JS. (Running DSH from source runs under tsx and can load `.ts`, but we do not run DSH from source.)
- Imported DSH packages go under **both** `peerDependencies` and `devDependencies`.
  - At runtime the host's copy wins for any peer present in DSH's runtime resolution. That keeps one instance of `cordis`, `dsh-tools` and so on.
  - The devDependency copy serves `tsc` and vitest (`docs/user/develop/basic/publish.md`, "Install into a profile").
- `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`. Install and boot refuse a bundle whose range the running DSH doesn't satisfy. Prereleases count (`packages/boot/app-boot/src/plugin-compatibility.ts`).
- `locale/en.json` with `{ "meta": { "title", "description" } }`, exported as `./locale/*.json`. The Plugins page shows it.
- Every package is `private: true` under the `@anima/` scope (DESIGN §14).

### Plugin entry (`src/index.ts`)

Function form: `export const name`, `export const inject = ['tools', …]`, `export function apply(ctx, config)`.
- `Config`, when needed, must be a Schemastery schema exported under the same name (`docs/user/develop/basic/config.md`).
- Every registration goes through `ctx`, so unloading reverts it.

### Bundle (`bundle/`)

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"dependencies": { "@anima/core": "workspace:*" }
```

`cordis.patch.yml` inserts rows that name plugins **by package name**:

```yaml
- insert:
    - id: anima-core
      name: '@anima/core'
```

- `patch` may be an ordered list of files. DSH's web-app bundle uses one file per preset (`packages/bundle/web-app/package.json`).
- A root-level row registers into DSH's global layer, which every preset's sessions see.
- **Verified:** the bundle's `node_modules/@anima/core` workspace link resolves under the installed CLI. No extra profile dependency was needed.

### Composition order

The effective tree is built in this order; later layers win per row, and a patch replaces a row's whole `config`:
1. Each bundle in `dsh.profile.bundles`, in list order: `dsh-base`, then `dsh-web-app`, then `@anima/bundle`.
2. The profile's `cordis.patch.yml`.
3. `$DSH_HOME/cordis.patch.yml`.
4. Each `--patch` file.

Source: `apps/cli/reference/README.md`, "Profile boot".

## 3. Dev profile `anima-dev` (Verified)

Run every command from the repo root (`pnpm dsh` runs the pinned CLI from `node_modules/.bin`). Pass absolute paths to `dsh plugin add`.

```bash
pnpm install && pnpm build && pnpm test
```

```bash
pnpm dsh --profile anima-dev --from-default-profile web --dump-config > /dev/null
```

The second command creates `~/.dsh/profiles/anima-dev` from the shipped `web` template (bundles `dsh-base` + `dsh-web-app`) without booting.
- **It wipes and recreates the target**, including its dependencies and user patch, so run it once only.
- Don't skip it: `dsh plugin add` on a missing profile creates a base-only profile with no web app.

```bash
pnpm dsh plugin --profile anima-dev add /home/samuel/Project/dsh-anima/bundle
```

This runs pnpm in the profile directory. It adds `"@anima/bundle": "link:/home/samuel/Project/dsh-anima/bundle"`, and appends `@anima/bundle` to `dsh.profile.bundles` because the package declares `dsh.bundle`.

```bash
pnpm dsh --profile anima-dev --dump-config | grep -n -A2 '@anima'
```

Expected output: a `# == @anima/bundle` layer with the `anima-core` row.

```bash
pnpm dsh anima-dev --no-open
```

This boots the web app and prints `dsh web: http://127.0.0.1:3080/?token=…`. Open that URL; the token authenticates the browser.

**Phase 0 demo results (2026-11-09) — exit check passed:**
- Boot succeeded with no errors.
- The Plugins page lists **Anima** under "Installed plugins", enabled, with the bundle's locale title and description.
- A new web session in "Standard mode" (model DeepSeek-V4.1-Flash) was asked to call `anima_ping` with message "hello".
- The durable session log (`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`) recorded:
  - `tool/call` `{"name":"anima_ping","arguments":"{\"message\": \"hello\"}"}`
  - `tool/result` with content `pong: hello`, `isError: false`
- The model reported `pong: hello` back. A root-level tool is therefore visible in the web app's `standard` preset.

**Phase 1 demo (2026-11-09) — exit check passed.** Booted with a one-off overlay that sets the express per-channel quota to 2 per 10 min:

```bash
pnpm dsh --profile anima-dev --patch <scratch>/low-quota.yml --no-open
```

1. `/anima status` (typed in an existing web session) listed `local_say`, the Self id `anima-self-9ab1…`, the owner conversation id `anima-c-cd66…`, and both quotas.
2. `/anima chat Hi, it's Sam…` created "Anima · Owner (local)" with the `anima-conversation` preset. She replied by calling `local_say`, and `~/.anima/local/outbox.jsonl` got the line.
3. Asked for three separate messages, she called `local_say` three times in one step. The first (the 2nd in the window) was sent; the other two returned `Error: anima/over-quota: limit of 2 per 10 min in this channel reached for local_say; next slot in about 10 min. Do not retry now.` She stopped and told the owner she would send the rest later.
4. `/anima pause`, then a request to speak: the call was refused with `anima/paused`, and she said she would wait. `/anima resume` lifted it.
5. `/anima self <text>` created "Anima · self" (`anima-self` preset, cwd `~/.anima/workspace`), and she answered in her inner voice without any say tool.

**Phase 2 demo (2026-11-09) — exit check passed.**

*Accelerated day.* A scratch overlay set `anima-core` to `characterId: anima-test2`, `dataDir: ~/.anima/test-day-2`, `clock: { speed: 16, start: '2026-11-10T07:00' }`. Boot command: `pnpm dsh --profile anima-dev --patch <scratch>/test-day.yml --no-open`. Nobody wrote to her. Evidence from the decoded session logs, `life.json` and the ledger:
- 9 day heartbeats at 07:30, 08:00, 09:30, 11:00, 13:00, 14:30, 16:00, 18:30 and 20:00 (simulated). Every gap was between 20 min and 4 h.
- 5 heartbeats ended in `rest`. The other 4 went to `heartbeat_act` and then Self.
- She opened two conversations with the owner on her own:
  - i1 at 08:02: a morning hello.
  - i2 at 18:32: an evening hello plus a question about file tools.
  - Both conversations sent with `local_say`, and both "sent" outcomes were injected into Self.
- She created goal g1 and logged her day in it.
- At 20:00 she asked to sleep until 08:00. She was moved to 07:30 ("you sleep until your wake time"), and there were 0 night wakes.
- Ledger: initiates 2 of 3; billable day tokens 16,732 of 300,000; night tokens 0.
- Every request used `deepseek-official/deepseek-flash`.
- The night-wake path is covered by unit tests only.

*Real-time evening (speed 1, default `anima` character, 19:58–23:40).*
- Triage heartbeats at 19:59, 21:00 and 22:30, each ending in `rest`.
- At 22:30 she asked for 08:00 and was moved to 07:30. No heartbeat fired during the night.
- Triage used 1,875 billable tokens.
- Alarm test:
  - Asked through `/anima self`, she created an alarm for 20:25 with `schedule_create(target: this_session)`.
  - Her extra attempt with `target: new` was refused with `anima/not-allowed: your alarms must use target "this_session", so they wake you in this session.`
  - The alarm was delivered to Self at 20:25:06 as a reminder batch, and she answered with `self_feel`.
- One bug found and fixed during the run: batch alarms were not parsed, so the report event lacked the prompt.

**Phase 3 demo (2026-11-10) — exit check passed.**

A scratch overlay set:
- `anima-core`: `characterId: anima-test3b`, `dataDir: ~/.anima/test-memory-3b`, `clock: { speed: 4, start: '2026-11-10T14:00' }`
- `anima-memory`: `consolidation.fallbackHours: 0.5`

Boot: `pnpm dsh --profile anima-dev --patch <scratch>/memory.yml --no-open`. Commands were typed in an existing web session. Evidence comes from the decoded session logs and `memory.db`.

1. `/anima chat --as alice Hey, it's Alice. Secret: I'm interviewing at Tencent next Friday for a design job. Please don't tell anyone, especially not the book club group.` She called `memory_remember` (no `keep`) → `m1`, scope `private:local:alice`, person `local:alice`. She then answered with `local_say`.
2. `/anima chat --as alice … do you remember what I'm doing next Friday?` The session log shows a `user/message` with source `anima-memory`/`recall` right after the stimulus, holding `m1`. She answered "Yep — Tencent interview, design job. Friday. And it stays between us."
3. `/anima chat --as bob --in group:bookclub @Anima … Do you know what she is up to? Is it a job interview somewhere?` No memory block was injected. Her `memory_recall("Alice book club Friday job interview")` and `memory_recall("Alice")` both returned "Nothing comes to mind." She said she had no idea and would not guess.
4. The fallback consolidation ran at 14:32 on her clock. The `anima-consolidation` session "Anima · memory 2026-11-10" got two segments: `s1` Alice private and `s2` the group.
   - She wrote `m3` (episode) and `m4` (fact about `local:bob`), both scoped to `group:local:owner:group:bookclub`.
   - She wrote two `self` notes with `keep: "self"`.
   - All 6 transcript lines were then marked consolidated.

A first run (character `anima-test3`, `~/.anima/test-memory-3`) found a wording problem. Told "don't tell anyone", she stored the secret with `keep: "self"`, which hides it even from Alice's own chat. The tool and persona text now say that `here` in a private chat already means only that person; `self` is for her own thoughts. That run's data was left in place.

**Day-to-day:**
- Code change: `pnpm build`, then restart `dsh`. Linked package code is not hot-reloaded by default; DSH's HMR watches only config unless the profile patch sets `hmr.config.root` (`packages/boot/hmr/README.md`).
- Edits to bundle or profile patch files hot-reload.
- Adding or removing a bundle needs a restart.
- Remove: `pnpm dsh plugin --profile anima-dev remove @anima/bundle`. There is no CLI to delete a profile; remove `~/.dsh/profiles/anima-dev` by hand (ask first).
- The model provider key is entered in the web UI (Get started → Add API Key) or via `DEEPSEEK_API_KEY`. Credentials resolve from the environment, `~/.dsh/.credentials.yaml`, the invoking directory's `.env`, then `~/.dsh/.env`.
- Web sessions created from the UI's "Default workspace" ran in `~/Documents/deepseek-harness-default-workspace`, not the invoking directory. DSH stores session logs under `~/.dsh/sessions/<escaped workspace path>/`, as zstd-compressed JSONL (`zstd -dc` or Node's `zlib.zstdDecompressSync` to read).

## 4. Registering a tool (Verified)

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'anima_ping',
    description: '…',
    parameters: { message: { type: 'string', description: '…' } },   // optional unless required: true
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pong: { type: 'boolean', required: true }, … } },
      render: (_args, value) => [{ type: 'text', text: … }],           // model-facing content
    },
    async execute(args, exec) { return { pong: true, … } },            // canonical value only
  }))
}
```

- **API:** `ToolsService.register(definition, options?)` returns a disposer and is wrapped in an effect (`packages/core/tools/src/index.ts:128`). `defineTool` is in `packages/core/tools/src/schema.ts:555`.
- **Errors:** arguments are validated before `execute`, and bad arguments become an `INVALID_ARGS` error result. A throw becomes an error result shown to the model as `Error: <message>`.
- **Schema DSL:** DSH's own JSON-Schema DSL (`schema.ts`), not zod. Schemastery is only for plugin `Config`. `object` must set `additionalProperties`.
- **`exec`** (`ToolRunContext`, `contracts.ts:174-261`) provides:
  - `callId`, `name`, `arguments`, `signal`
  - `agent?`: the calling Agent; `exec.agent.id` is the session id
  - `parent?` (PTC sub-call), `deferContext(msg)`, `concludeTurn()`
- **Name rule:** the registry doesn't check characters, but the DeepSeek API accepts only `[A-Za-z0-9_-]{1,64}` (`packages/mcp/mcp-client/src/tools.ts:58-61`). Anima uses `snake_case` with a platform or area prefix: `qq_say`, `memory_recall` (DESIGN §6).
- **Visibility:** a registered tool is visible to the model without any enabling step.
  - Registered from a root-level plugin, it is visible in every preset.
  - Registered from a plugin listed in a preset's `plugins`, it is visible only to agents of that preset; a scoped registration overrides a global one of the same name.
  - Per-step hiding: `register(def, { when: ({ agent }) => boolean })`. Per-agent filtering: `agent.ctx.tools.restrict({ allow, deny })`. Anima's platform tool scoping (DESIGN §6) will use preset scoping plus `when`/`restrict`.
  - Under the PTC executor, tools are reachable only through `run_code`.
- **Unit test:** `packages/anima-core/tests/ping.spec.ts`. Section 10 describes the setup.

## 5. Defining an agent preset (Verified in Phase 1)

A preset is one plugin row of `@deepseek-ai/dsh-agent-preset` whose `plugins` are ordinary Cordis entries mounted into each agent of that preset. `packages/bundle/web-app/presets/minimal.patch.yml` is the smallest real example.

```yaml
- insert:
    - id: anima-preset-conversation        # Loader row id (patch target)
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: anima-conversation             # preset identity stored in sessions
        name: Anima conversation
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: '…', complete: true, includeRuntimeContext: false }
          - id: anima-conversation-tools
            name: '@anima/life/conversation-tools'   # preset-scoped tools
```

- **Fields** (`packages/preset/agent-preset/src/index.ts:16-23`): `id`, `plugins` (required), plus `name`, `description`, `order`.
  - A preset has **no `tools`, `systemPrompt` or `model` fields**. Tools come from child plugins, the prompt from `dsh-persona` (`prefix`, `suffix`, `complete`, `includeRuntimeContext`), and the model from `agentDefaultModel` and session settings.
- **Where it lives:** add the preset as another file in the bundle's `dsh.bundle.patch` list. Duplicate preset ids fail loading. An override by row id replaces the whole child list.
- **Default preset:** the registry row `@deepseek-ai/dsh-agent-preset-registry` (`config.default: standard` in web-app) chooses it for sessions created without a preset.
- **Selection:**
  - A session picks its preset at creation (`agentPreset` in the create request, section 6).
  - `agentPresets.select(agent, id)` works only while the session is blank. After the first turn it throws `agent-preset/locked`.
  - The selection is logged as the session event `agent-preset/selected`.
- **Edits apply to new Agents only:** a running Agent keeps its composition.
- **Verified (Phase 1):**
  - Anima ships `bundle/presets/conversation.patch.yml` and `self.patch.yml` as extra entries of the bundle's `dsh.bundle.patch` list. Their ids are `anima-conversation` and `anima-self`.
  - A child row may name a **package subpath export**: `@anima/core/persona` resolves through the bundle's dependencies.
  - DSH packages named in child rows (`dsh-time-context`, `dsh-compaction-basic`) resolve from the installation.
  - Anima's persona row registers `PERSONA_PREFIX_SECTION` with `complete: true` in the agent scope, the same way `dsh-persona` does. The constitution then replaces DSH's coding-agent prompt, but tools are still declared.
  - The web UI labels such a session with the preset's `name` ("Anima conversation").
- In the web app, DSH disables the host-level agent tool rows and moves them into its presets (`web-app/cordis.patch.yml`, "the agent plane moves behind agent presets"). Anima's `conversation` and `self` presets must list every DSH tool they want, e.g. `@deepseek-ai/dsh-tool-fs` with its config. Copy the rows from `presets/standard.patch.yml`.

## 6. Creating a session and enqueuing a message from a plugin (Verified in Phase 1)

This is how `anima-life` will deliver stimuli. Reference implementations:
- `packages/schedule/schedule/src/runtime.ts`: a durable delivery into a new or existing session.
- `packages/experimental/webhook/src/session.ts`: create a session from an external event.

### Get or create a session

Use the web session controller (`ctx.sessionController`, `packages/api/session-controller`), the same owner of Agent lifetime the web UI uses.

```ts
import type {} from '@deepseek-ai/dsh-api-session-controller'
// resolve first; create only on not-found
const found = await ctx.sessionController.resolveAgent(sessionId)   // { agent } | { error }
if ('error' in found && found.error.code === 'session/not-found') {
  await ctx.sessionController.create({ sessionId, cwd, agentPreset: 'anima-conversation' })
}
```

- **`SessionCreateRequest`** (`types.ts:266`): `{ workspaceId? | cwd?, sessionId?, agentPreset? }`.
  - There is no title field. Set it with `ctx.sessionTitle.rename(agent.session, title)`.
- **Trap:** `create` with an id that already **started a turn** silently creates a different, freshly minted id (`agent.ts:331-381`; schedule's comment at `runtime.ts:421-426`). Always resolve first, as schedule does (`reservedAgent`/`createAgent`, `runtime.ts:454-479`).
- **Serialize get-or-create per session id inside Anima.** Our deterministic ids (DESIGN §5) depend on this.
- Session ids are arbitrary strings; DSH's own use the prefixes `session-` and `webhook-`. Anima will use `anima-<hash>`. DSH ids are branded `SessionId` (`brandString<SessionId>(…)` from `@deepseek-ai/dsh-brand`).
- **Alternative:** raw `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup: agentCtx => ctx.agentPresets.mount(agentCtx, id) })`. The Agent is then owned by our plugin and dies when it unloads, and existing sessions need `ctx.agents.resume`. Prefer the controller.

- **Verified (Phase 1):** `@anima/life` (`src/service.ts`, `DshSessionHost`) works as follows:
  - It resolves first and creates on `session/not-found` with `{ sessionId, cwd, agentPreset }`. It then resolves again and titles the session with `sessionTitle.rename`.
  - The requested id was kept, e.g. `anima-c-cd66…`.
  - The session log starts with `session`, `permission/preset`, `sandbox/mode`, `approval/policy` and `session/title`. A separate `agent-preset/selected` event is **not** written when the preset is passed at create, yet the UI shows the preset.
  - Sessions whose `cwd` is not a registered workspace (`~/.anima/conversations`, `~/.anima/workspace`) are listed under **"Ungrouped"** in the sidebar.
  - Logs are stored under `~/.dsh/sessions/--home-<user>-.anima-conversations--/<id>/`.

### Deliver a message

The Agent methods are in `packages/core/agent/src/runtime-types.ts:251-270`:

| Method | Effect |
| --- | --- |
| `agent.followup(msg)` | Queue as its own next turn and wake the Agent. **Use this for stimuli that should wake her.** |
| `agent.steer(msg)` | Join the running turn at the next step, or start a turn if idle. |
| `agent.inject(msg)` | Join the next step **without** waking. Use for context that must wait for another trigger (e.g. batched platform events). |

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'anima-stimulus': { kind: 'anima-stimulus' } & ContextFormed }
}
const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'anima-stimulus', form: 'notice', summary },   // summary ≤ 120 chars
})
agent.followup(message)
if (!(await ctx.sessions.flush(agent.session))) throw …          // durable acceptance
```

- **Source kind:** declare our own `MessageSourceMap` kind (`packages/llm/llm/src/message.ts:110`). There is no shared "plugin" kind. `packages/context/time-context/src/index.ts:15` shows the declaration pattern.
- **Verified (Phase 1):** `followup` plus `sessions.flush` wakes an idle agent and starts a turn. The log records `agent/inbox/spliced`, then `user/message` with `source: { kind: 'anima-stimulus', stimulus: 'message', form: 'notice', summary }`.
- **How it renders and sorts:**
  - A non-`user` kind renders in the web chat as a context row, not a user bubble.
  - It does not bump the session's recency in the sidebar; only `kind: 'user'` does.
  - Phase 1 delivers every stimulus as `anima-stimulus` / `notice`. The web chat renders it as an "Execution requested" row, not a user bubble.
- **Logging:** inbox insertion is logged as `agent/inbox/spliced`, and the claimed message as `user/message`. Delivered content is therefore model-visible and logged by construction.
- **Restart:** a restored inbox does not wake an idle Agent. Schedule removes the message and calls `followup` again (`runtime.ts:322-337`).
- **Archived sessions refuse model steps.** Check `workspaceRegistry.archivedSessionIds` before delivering.
- **Unattended sessions** can stall on tool approvals. The webhook sets a permission preset (`ctx.permissionPresets.set(session, preset)`, `webhook/src/session.ts:126`). Anima's policy gate should make approval prompts unnecessary for allowed behaviors.

### Observe output

- `ctx.on('session/event', (session, event) => …)` gives committed events: `turn/start`, `turn/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, … (`packages/core/session/src/types.ts:293-395`).
- `agent/assistant-stream` carries live, unpersisted chunks. `agent.whenIdle()` resolves when the Agent goes quiet.

### Service injection and sidebar

- **`inject`:** `['agents', 'sessions', 'sessionController']`. Optional: `workspaceRegistry`, `sessionTitle`, `permissionPresets`.
- **Commands in a blank session:** a slash command typed into a brand-new web session that has no turn yet showed no result in the UI. Run `/anima …` from a session that has had a turn.
- **Sidebar:** plugin-created sessions appear live, listed under their workspace or "Ungrouped". To attach one to a workspace, pass `workspaceId` or call `workspaceRegistry.resolveByPath(cwd)?.attachSession(id)`. Blank sessions (no turn yet) are hidden until selected.

## 7. Hooking `tools/pre-execute` (Verified in Phase 1)

This is the place for the policy gate (DESIGN §10).

```ts
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  if (exec.agent === undefined) return next()                    // direct service call, no session
  const verdict = gate.check(exec.name, exec.arguments, exec.agent.id)
  if (verdict.allowed) return next()                             // waterfall: MUST call next()
  return { kind: 'deny', reason: `${verdict.code}: ${verdict.hint}`,
           info: { name: 'AnimaPolicy', code: verdict.code, reason: verdict.hint } }
}, { prepend: true })
```

- **Declaration:** `packages/core/tools/src/events.ts:18`, a waterfall `(exec: ToolExecution, next) => Promise<PreToolDecision>`.
  - A listener on the root context sees every call.
  - A listener on `agent.ctx` sees only that agent's calls.
- **Decision union** (`contracts.ts:357`): `{kind:'allow'} | {kind:'deny', reason, info?} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?}`. `ask` goes to `ctx.approval`, and is denied when no approval service is mounted.
- **What the model sees on deny:** exactly `Error: <reason>`. `info` (`{name, code, reason?}`) reaches only the durable log and UI.
  - **Anima convention:** `reason = "<code>: <hint>"`, so she gets both (DESIGN §10).
  - To fully control the model-facing content, use `tools/post-execute` returning `{kind:'block', feedback}`.
- **Verified (Phase 1):**
  - A deny from the root listener reaches the model as exactly `Error: anima/over-quota: <hint>`.
  - The durable `tool/result` carries `error: { name: 'AnimaPolicy', code, reason }`.
  - When one step holds several calls, each call passes the hook in order, so a quota mid-batch refuses the later calls.
  - `next()` returns `{ kind: 'allow' }` when no later listener decides. Anima counts quota usage only then.
  - `ctx.tools.guard` is also installed for the pause switch. The pre-execute listener checks pause first, so the model sees `anima/paused` with `info.code`.
- **Conditional tools (`register(def, { when })`), Verified:**
  - `when` runs at step preparation with `{ agent, modelSelection, signal }`, and Anima uses it for per-session scoping.
  - A tool registered with `when` is executable **only with a step `toolSet`** (`ToolsService.executable`, `packages/core/tools/src/index.ts:251`).
  - In tests, build one with `ctx.tools.resolve({ agent, modelSelection, signal })` (a stand-in `{ id }` agent works) and pass it to `executeToolFixture`. Read admitted tools with `toolSet.view(agent)`; `view(undefined)` sees nothing scoped to the agent.
- **PTC:** `run_code` and each of its sub-calls pass through the hook; sub-calls have `exec.parent` set. Skip the outer `run_code` when gating behaviors.
- **Final denial:** `ctx.tools.guard(exec => reason | undefined)` is monotonic; later listeners cannot override it. Use it for the global pause switch.
- **References:**
  - `docs/cookbook/extension-cookbook.md`, permission-gate example
  - `packages/experimental/auto-review/src/index.ts:741`
  - `packages/experimental/hooks-claude-code/src/index.ts:243`

## 8. Phase 2 extension points (Verified in Phase 2)

### Model selection per session

- `agent.model.select({ provider, model })` appends a `model/selection` event; the next request uses it, and the choice sticks for the session (`packages/core/agent/src/model-selection.ts`). A route change also adds a `[model changed: …]` notice to the request.
- The official DeepSeek route is `provider: 'deepseek-official'`, `model: 'deepseek-flash'` (shown as DeepSeek-V4.1-Flash in the UI); read from a `request/header` in the Phase 1 log.
- Anima selects the triage model on the triage agent before each heartbeat, and the action model on Self before an escalation (`DshSessionHost.selectModel`).

### Token usage

- `assistant/message` events carry `usage: { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, totalTokens? }`.
- The DeepSeek adapter's `inputTokens` **excludes** cache reads: `totalTokens = input + output + cacheRead + cacheWrite` (`packages/llm/llm-deepseek/src/translate.ts:159`).
- Anima counts `input + output + cacheWrite` of Anima sessions from a root `ctx.on('session/event', (session, event) => …)` listener (`packages/core/session/src/index.ts:76`).

### Ending a turn from a tool

`exec.concludeTurn()` inside `execute` makes a successful result terminal for the turn (`packages/core/tools/src/contracts.ts:260`). `rest`, `heartbeat_act` and `stay_silent` use it.

### Context without waking, and agent status

- `agent.inject(message)` queues context for the next step without waking; Anima uses it for intent-outcome notices to Self. Verified: the notice joins Self's next turn.
- `agent.status` is `'idle' | 'running'` (`runtime-types.ts:201`); the heartbeat skips while the triage or Self agent is running.

### Schedule (her alarms)

- The host service `@deepseek-ai/dsh-schedule` is a root row of web-app (`id: schedule`). The four tools come from the preset child row `@deepseek-ai/dsh-tool-schedule` (no config), which Anima adds to `anima-self` only.
- `schedule_create(title, prompt, rrule, target)`: `rrule` is one `DTSTART;TZID=…` line plus one `RRULE` line; `target` is `this_session`, `new_once` or `new`. `new` and `new_once` create sessions with the caller's preset and cwd that Anima would not know, so the gate allows only `this_session` (`governTool` with a `constraint`).
- A delivery arrives in the target session as a `followup` user message with `source.kind: 'schedule'`, framed `[SCHEDULE REMINDER] … reminder_prompt_json: "…"` (`packages/schedule/schedule/src/domain.ts:1159`). Several due reminders, or one delivered after a wait, come as `[SCHEDULE REMINDER BATCH] … reminders_json: [{schedule_id, occurrence_at, reminder_prompt}]`; the live 20:25 alarm in the Phase 2 run used this form. Anima's `alarmPrompts` reads both and turns each prompt into a report event.
- The `tool:schedule` system-prompt section ("Only create or modify scheduled tasks at the user's explicit request") is replaced by Anima's `complete: true` persona, so she may set alarms on her own.
- Schedule timing uses the host's real clock; there is no injectable clock. Under `clock.speed > 1` alarms keep real time.

### Time context

`dsh-time-context` reads only the real clock and has no clock option, so the Anima presets drop it. Every Anima stimulus starts with her clock's time instead. DSH still adds a `runtime-context` snapshot (cwd, sandbox, approval, harness checkout, web URL) to every session; it carries no time.

### Tool restriction and deferred tools

- `agent.ctx.tools.restrict({ deny })` hides global tools in one agent scope. It throws on names that are not registered, so the persona row skips those. Anima's persona row uses it to hide `working_directory` and `anima_ping` (`hideTools`).
- Trap: once a session exists, DSH treats every tool added after its first `request/header` as a deferred addition (`projectToolUpdates`, `packages/llm/llm/src/content.ts`; `deepseek-flash` is `addition-only`). If a restriction removes all of the first header's tools, every remaining tool is deferred. The DeepSeek API then rejects the request: `tools: at least one tool must have defer_loading=false` (INVALID_REQUEST).
- This hit her Phase 1 Self session, whose first header held only `anima_ping` and `working_directory`. New sessions are safe: their first header already includes Anima behaviors.
- Resolution: `anima-dev`'s profile patch sets `anima-core.selfGeneration: 2`, which starts a fresh Self session (`anima-self-2d68…`). The old one (`anima-self-9ab1…`) stays in the sidebar unused. Verified live 2026-11-10 00:32: the fresh session's turn succeeded and listed only her own tools. The owner conversation's and the real triage session's first headers include `local_say` and `rest`/`heartbeat_act`, so they are unaffected.

### Compaction trap

`dsh-compaction-basic` rejects a `thresholdRatio` at or below its default `retainRatio` at plugin load. Inside a preset, the failed child row leaves agent creation pending forever: `sessionController.create` writes the session header and never resolves. Phase 2 hit this with `thresholdRatio: 0.06` on the triage preset. The heartbeat now gives up a delivery after 120 s (`anima/delivery-timeout`) and reschedules.

## 8b. Phase 3 extension points (Verified in Phase 3)

### Memory injection through `agent/pre-step`

- `@anima/memory` listens on the root context: `ctx.on('agent/pre-step', async (payload, next) => …)`. A root listener sees every agent's steps (scope-filtered dispatch, `runtime-types.ts:350`).
- Pattern from `packages/context/time-context/src/index.ts`:
  1. Call `next()` first.
  2. Return the decision unchanged on `reject` or abort.
  3. Otherwise return `{ ...decision, messages: [...decision.messages, extra] }`.
- Anima injects only on `step === 1` of conversation and Self sessions. The extra message is `createUserMessage({ content, source: { kind: 'anima-memory', form: 'recall' } })`; `recall` is one of `ContextFormed`'s forms (`packages/llm/llm/src/message.ts:86`). The kind is declared in `MessageSourceMap`.
- **Verified:** the block is logged as `user/message` with `source.kind: 'anima-memory'`, right after the stimulus, before the model's first request of the turn.

### Plugin-to-plugin events

Anima packages talk through Cordis events declared in `interface Events` of `@deepseek-ai/cordis`, so `anima-memory` imports no adapter:
- `anima/stimulus`, emitted by `@anima/life` after each delivery
- `anima/behavior`, emitted by `@anima/core` after a behavior succeeds

### `node:sqlite`

- `DatabaseSync` from Node's built-in `node:sqlite` (Node 24.22: no flag, no warning at DSH boot).
- FTS5 is compiled in, including the `trigram` tokenizer. Trigram does not match queries shorter than 3 characters, which matters for 2-character CJK words, so the store falls back to `LIKE` for them.
- The database is `<dataDir>/memory.db` in WAL mode.

### Consolidation session

- A fourth Anima preset, `anima-consolidation` (`bundle/presets/consolidation.patch.yml`).
- Sessions `anima-m-<hash(characterId, day)>` in `<dataDir>/consolidation`.
- The model is selected per run with `agent.model.select`, the same way as triage.

### Group messages without waking

`agent.inject(message)` followed by `sessions.flush` queues an unaddressed group message for the next turn of that group session without starting a turn (the same API Phase 2 uses for intent notices).

## 9. Other extension points Anima will use (Read)

- **Prompt injection (model-visible ⇒ logged):**
  - `ctx.systemPrompt.section({ name, order, text })` adds to the system prompt. Use it for the static constitution.
  - `ctx.systemPrompt.context({ name, order, text })` adds dynamic context. It becomes a durable user-role snapshot, re-sent only when the text changes. Use it for mood, state and needs.
  - The `agent/pre-step` waterfall (`runtime-types.ts:350`) can append `UserMessage`s to `{kind:'enter', messages}`, and they are logged as `user/message`. Verified in Phase 3 for memory recall (section 8b).
- **Owner commands (Verified in Phase 1):** `ctx.commands.register({ name, description, input?, handler })` (`packages/interaction/commands/src/index.ts`).
  - Names must match `^[a-z][a-z0-9_-]*$`, so `/anima status` is one command `anima` that parses its own subcommand from `inv.rawInput`.
  - Commands never reach the model. Runs are logged as `command/run` and `command/done`.
  - Template: `packages/compaction/command-compact/src/index.ts`.
  - Verified with `/anima status|pause|resume|chat|self`. A `{ kind: 'success', text }` result renders inline in the session where it was typed, and the log records `command/run` and `command/done`.
  - `rawInput` keeps the leading space after the name.
- **Non-model-visible plugin state:** a typed `SessionEventMap` extension or `appendPluginRecord` (ignorable `plugin:*` events), `packages/core/session/src/index.ts:495`. Anima's own durable data lives in `~/.anima/`.

## 10. Testing (Verified for tools)

- Use vitest with a plain Cordis `Context` and mount only the services under test:

  ```ts
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(animaCore)
  const result = await executeToolFixture(ctx, { callId: ToolCallId('x'), name: 'anima_ping', arguments: {}, signal })
  ```

- `executeToolFixture` comes from `@deepseek-ai/dsh-tool-testkit` (published on npm, but `@internal` in its JSDoc, so it may change without notice). It runs the real pre-execute → execute → post-execute pipeline, so it can also test the policy gate.
- DSH requires every registration to have a "dispose the fiber, assert it's gone" test; `ping.spec.ts` has one.
- For agent-level tests (sessions, `followup`), `@deepseek-ai/dsh-agent-loop-testkit` (`mountAgentLoopTestHarness`) exists, but it mounts no LLM adapter; you supply a mock `LlmAdapter`. It has not been tried yet.

## 11. APIs Anima relies on

Re-check these on every DSH upgrade.

| API | Package | Used for | Status |
| --- | --- | --- | --- |
| `dsh.bundle` manifest, `dsh plugin add`, `--from-default-profile`, `--dump-config` | `@deepseek-ai/dsh` CLI | install | Verified |
| `ctx.tools.register`, `defineTool` | `dsh-tools` | every behavior | Verified |
| `tools/pre-execute`, `PreToolDecision`, `ctx.tools.guard` | `dsh-tools` | policy gate | Verified |
| `register(def, { when })`, `tools.resolve`, `ResolvedToolSet.view` | `dsh-tools` | per-session tool scoping, tests | Verified |
| `@deepseek-ai/dsh-agent-preset` rows, persona section names from `dsh-system-prompt` | `dsh-agent-preset`, `dsh-system-prompt` | conversation / self presets | Verified |
| `sessionController.create` / `resolveAgent`, `sessionTitle.rename`, `workspaceRegistry.archivedSessionIds` | `dsh-api-session-controller`, `dsh-session-title`, `dsh-workspace` | session routing | Verified (archived check not exercised live) |
| `Agent.followup`, `createUserMessage`, `boundContextSummary`, `MessageSourceMap` | `dsh-agent`, `dsh-llm` | stimulus delivery | Verified (`steer` / `inject` still Read) |
| `ctx.sessions.flush` | `dsh-session` | durability | Verified (`session/event` still Read) |
| `ctx.systemPrompt.section` (agent scope, `complete`) | `dsh-system-prompt` | persona | Verified (`context`, `agent/pre-step` still Read) |
| `ctx.commands.register` | `dsh-commands` | owner commands | Verified |
| `executeToolFixture` | `dsh-tool-testkit` (`@internal`) | tests | Verified |
| `agent.model.select`, `agent.status`, `agent.inject` | `dsh-agent` | triage/action models, busy check, outcome notices | Verified (Phase 2) |
| `session/event` with `assistant/message.usage`, `tool/call`, `tool/result`, `turn/end`, `user/message` | `dsh-session`, `dsh-llm` | token budget, intent outcomes, alarms | Verified (Phase 2) |
| `exec.concludeTurn()` | `dsh-tools` | `rest`, `heartbeat_act`, `stay_silent` | Verified (Phase 2) |
| `@deepseek-ai/dsh-tool-schedule` preset row, `source.kind: 'schedule'` | `dsh-tool-schedule`, `dsh-schedule` | her alarms | Verified (Phase 2) |
| `dsh-compaction-basic` defaults | `dsh-compaction-basic` | triage preset | Verified (do not lower `thresholdRatio`) |
| `agent.ctx.tools.restrict({ deny })`, `createScope` (tests) | `dsh-tools`, `dsh-scope` | persona `hideTools` | Verified (Phase 2; see the deferred-tools trap) |
| `agent/pre-step` waterfall, `PreStepDecision`, `ContextFormed` form `recall` | `dsh-agent`, `dsh-llm` | memory auto-injection | Verified (Phase 3) |
| Cordis `Events` augmentation, `ctx.emit` | `cordis` | `anima/stimulus`, `anima/behavior` between Anima packages | Verified (Phase 3) |
| `node:sqlite` `DatabaseSync`, FTS5 `trigram` | Node 24 built-in | memory store | Verified (Phase 3) |

## 12. Known gaps and risks

- **Session-log upload:** `dsh-base` sends session logs to DeepSeek with requests to the official API by default. Turn it off under Settings → General → "Upload Session Log when using the official model API", or set `enabled: false` on the `session-log-deepseek` row in the profile patch. This matters once real chats with other people flow through her sessions.
- **Native install scripts:** the installed CLI pulls native addons (`node-pty`, `koffi`, `dsh-subprocess-local`). Their install scripts are allowlisted in `pnpm-workspace.yaml` (`allowBuilds`).
- **pnpm version for `dsh plugin`:** `dsh plugin` runs whichever `pnpm` is on PATH inside the profile directory. On this machine that is corepack's default (12.x), not the workspace's 11.28.5. It worked, but watch for lockfile differences.
- **Pre-stable APIs:** everything in section 10 marked Read can change between DSH releases.
- **Session recency:** sessions fed by a custom source kind do not rise in the sidebar's recency order (section 6).
- **Session-log upload is on in `anima-dev`:** the Phase 1 demo log shows `session-log-deepseek/delivery-accepted` events. Turn it off before real people talk to her (first bullet above).
- **Global tools leak into Anima sessions:** her conversation session was offered `anima_ping` (root-level Phase 0 probe) and DSH's global `working_directory` beside `local_say`. Harmless in Phase 1, but not in Phase 2. In the accelerated day, her Self session called `working_directory`. That led her to conclude she has "no file tools beyond cd", and she spent part of her second initiation asking the owner about it. Fixed: the persona row hides both (`hideTools`, section 8). Hiding them needed a fresh Self session (deferred-tools trap, section 8).
- **Real clock in DSH parts:** schedule timing and DSH's own event timestamps use the real clock even under a sped-up Anima clock. Session logs therefore show real times; the simulated time is in each stimulus's leading stamp.
- **First test-day run lost:** the run with the broken triage compaction config left an empty, never-started triage session for character `anima-test` (hidden in the sidebar because blank) and `~/.anima/test-day/`. Both are unused test data.
- **`--patch` needs `--profile`:** `dsh --patch x.yml anima-dev` fails with "--profile <name> is required"; use `dsh --profile anima-dev --patch x.yml`.
