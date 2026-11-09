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
2. Re-read the files cited in this document at the new tag, and diff the APIs listed in section 10.
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
- **Unit test:** `packages/anima-core/tests/ping.spec.ts`. Section 9 describes the setup.

## 5. Defining an agent preset (Read)

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
- In the web app, DSH disables the host-level agent tool rows and moves them into its presets (`web-app/cordis.patch.yml`, "the agent plane moves behind agent presets"). Anima's `conversation` and `self` presets must list every DSH tool they want, e.g. `@deepseek-ai/dsh-tool-fs` with its config. Copy the rows from `presets/standard.patch.yml`.

## 6. Creating a session and enqueuing a message from a plugin (Read)

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
- **How it renders and sorts:**
  - A non-`user` kind renders in the web chat as a context row, not a user bubble.
  - It does not bump the session's recency in the sidebar; only `kind: 'user'` does.
  - Decide per stimulus type in Phase 1.
- **Logging:** inbox insertion is logged as `agent/inbox/spliced`, and the claimed message as `user/message`. Delivered content is therefore model-visible and logged by construction.
- **Restart:** a restored inbox does not wake an idle Agent. Schedule removes the message and calls `followup` again (`runtime.ts:322-337`).
- **Archived sessions refuse model steps.** Check `workspaceRegistry.archivedSessionIds` before delivering.
- **Unattended sessions** can stall on tool approvals. The webhook sets a permission preset (`ctx.permissionPresets.set(session, preset)`, `webhook/src/session.ts:126`). Anima's policy gate should make approval prompts unnecessary for allowed behaviors.

### Observe output

- `ctx.on('session/event', (session, event) => …)` gives committed events: `turn/start`, `turn/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, … (`packages/core/session/src/types.ts:293-395`).
- `agent/assistant-stream` carries live, unpersisted chunks. `agent.whenIdle()` resolves when the Agent goes quiet.

### Service injection and sidebar

- **`inject`:** `['agents', 'sessions', 'sessionController']`. Optional: `workspaceRegistry`, `sessionTitle`, `permissionPresets`.
- **Sidebar:** plugin-created sessions appear live, listed under their workspace or "Ungrouped". To attach one to a workspace, pass `workspaceId` or call `workspaceRegistry.resolveByPath(cwd)?.attachSession(id)`. Blank sessions (no turn yet) are hidden until selected.

## 7. Hooking `tools/pre-execute` (Read)

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
- **PTC:** `run_code` and each of its sub-calls pass through the hook; sub-calls have `exec.parent` set. Skip the outer `run_code` when gating behaviors.
- **Final denial:** `ctx.tools.guard(exec => reason | undefined)` is monotonic; later listeners cannot override it. Use it for the global pause switch.
- **References:**
  - `docs/cookbook/extension-cookbook.md`, permission-gate example
  - `packages/experimental/auto-review/src/index.ts:741`
  - `packages/experimental/hooks-claude-code/src/index.ts:243`

## 8. Other extension points Anima will use (Read)

- **Prompt injection (model-visible ⇒ logged):**
  - `ctx.systemPrompt.section({ name, order, text })` adds to the system prompt. Use it for the static constitution.
  - `ctx.systemPrompt.context({ name, order, text })` adds dynamic context. It becomes a durable user-role snapshot, re-sent only when the text changes. Use it for mood, state and needs.
  - The `agent/pre-step` waterfall (`runtime-types.ts:350`) can append `UserMessage`s to `{kind:'enter', messages}`, and they are logged as `user/message`. Use it for per-turn memory recall. Pattern: `packages/context/time-context/src/index.ts`.
- **Owner commands:** `ctx.commands.register({ name, description, input?, handler })` (`packages/interaction/commands/src/index.ts`).
  - Names must match `^[a-z][a-z0-9_-]*$`, so `/anima status` is one command `anima` that parses its own subcommand from `inv.rawInput`.
  - Commands never reach the model. Runs are logged as `command/run` and `command/done`.
  - Template: `packages/compaction/command-compact/src/index.ts`.
- **Non-model-visible plugin state:** a typed `SessionEventMap` extension or `appendPluginRecord` (ignorable `plugin:*` events), `packages/core/session/src/index.ts:495`. Anima's own durable data lives in `~/.anima/`.

## 9. Testing (Verified for tools)

- Use vitest with a plain Cordis `Context` and mount only the services under test:

  ```ts
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(animaCore)
  const result = await executeToolFixture(ctx, { callId: ToolCallId('x'), name: 'anima_ping', arguments: {}, signal })
  ```

- `executeToolFixture` comes from `@deepseek-ai/dsh-tool-testkit` (published on npm, but `@internal` in its JSDoc, so it may change without notice). It runs the real pre-execute → execute → post-execute pipeline, so it can also test the policy gate.
- DSH requires every registration to have a "dispose the fiber, assert it's gone" test; `ping.spec.ts` has one.
- For agent-level tests (sessions, `followup`), `@deepseek-ai/dsh-agent-loop-testkit` (`mountAgentLoopTestHarness`) exists, but it mounts no LLM adapter; you supply a mock `LlmAdapter`. It has not been tried yet.

## 10. APIs Anima relies on

Re-check these on every DSH upgrade.

| API | Package | Used for | Status |
| --- | --- | --- | --- |
| `dsh.bundle` manifest, `dsh plugin add`, `--from-default-profile`, `--dump-config` | `@deepseek-ai/dsh` CLI | install | Verified |
| `ctx.tools.register`, `defineTool` | `dsh-tools` | every behavior | Verified |
| `tools/pre-execute`, `PreToolDecision`, `ctx.tools.guard` | `dsh-tools` | policy gate | Read |
| `@deepseek-ai/dsh-agent-preset` rows, `dsh-persona` | `dsh-agent-preset`, `dsh-persona` | conversation / self presets | Read |
| `sessionController.create` / `resolveAgent` | `dsh-api-session-controller` | session routing | Read |
| `Agent.followup` / `steer` / `inject`, `createUserMessage`, `MessageSourceMap` | `dsh-agent`, `dsh-llm` | stimulus delivery | Read |
| `ctx.sessions.flush`, `session/event` | `dsh-session` | durability, observation | Read |
| `ctx.systemPrompt.section` / `context`, `agent/pre-step` | `dsh-system-prompt`, `dsh-agent` | persona, state, memory injection | Read |
| `ctx.commands.register` | `dsh-commands` | owner commands | Read |
| `executeToolFixture` | `dsh-tool-testkit` (`@internal`) | tests | Verified |

## 11. Known gaps and risks

- **Session-log upload:** `dsh-base` sends session logs to DeepSeek with requests to the official API by default. Turn it off under Settings → General → "Upload Session Log when using the official model API", or set `enabled: false` on the `session-log-deepseek` row in the profile patch. This matters once real chats with other people flow through her sessions.
- **Native install scripts:** the installed CLI pulls native addons (`node-pty`, `koffi`, `dsh-subprocess-local`). Their install scripts are allowlisted in `pnpm-workspace.yaml` (`allowBuilds`).
- **pnpm version for `dsh plugin`:** `dsh plugin` runs whichever `pnpm` is on PATH inside the profile directory. On this machine that is corepack's default (12.x), not the workspace's 11.28.5. It worked, but watch for lockfile differences.
- **Pre-stable APIs:** everything in section 10 marked Read can change between DSH releases.
- **Session recency:** sessions fed by a custom source kind do not rise in the sidebar's recency order (section 6).
