# CLAUDE.md — Anima

Anima is a DSH (DeepSeek Harness) plugin that gives one AI character personality, memory and autonomy across chat platforms. Read this file fully before any work.

## Read first

1. `docs/DESIGN.md` — the top-level design. It is the source of truth for concepts, packages and phases. Do not contradict it silently.
2. `docs/DSH-INTEGRATION.md` — how this repo plugs into DSH (written in Phase 0; read it once it exists).
3. Only then read code.

If the design turns out to be wrong or incomplete while coding, stop and say so, propose the change, and update `docs/DESIGN.md` in the same change once agreed. Code and design must not drift apart.

## Reference sources (read-only)

- DSH source: `~/Project/dev/dsh-src`. Read-only reference for APIs and conventions. Start from its `AGENTS.md`, `docs/architecture.md`, `docs/cordis-primer.md`, `docs/cookbook/`, and the README of any package you use. Never edit it.
- `~/Project/dev/surfcore`: the old plugin Anima replaces. Do not read it unless the user asks; when asked, take ideas only, never copy its structure.
- `~/Project/dev/dsh-mnemon`: do not read.

## Working rules

- **One roadmap phase at a time** (DESIGN.md section 14). Do not build ahead of the current phase. A phase is done only when its exit check passes and is demonstrated.
- **Plan before code** for anything beyond a small fix: state what changes, which files, how it will be verified.
- **Simplest first.** Non-core features get the simplest working version; improve only when a real problem shows up.
- **Ask before** deleting files, changing DSH profile or config files under `~/.dsh`, starting anything that sends messages to real platform accounts, or adding a dependency that is not obviously needed.
- **Small commits**, one concern each, with a message that says what changed and why.

## Architecture rules (from the design)

- The model decides; code keeps state, enforces limits and moves messages. Never add code that chooses what she says or when (no keyword lists, no fixed-time scripts).
- Every action is a behavior (a DSH tool + metadata). Speech only via explicit `say`; assistant text is never auto-forwarded.
- All limits live in the one policy gate (`tools/pre-execute` in `anima-core`); tools carry no quota logic of their own.
- Core packages (`anima-core`, `anima-life`, `anima-memory`) never import an adapter. Adapters depend on core interfaces only.
- Platform tools are namespaced (`qq.*`, `bili.*`); a conversation session only gets its own platform's tools.
- Plugin data lives in `~/.anima/` (configurable). Never write into DSH's own data directory except through DSH APIs.

## DSH conventions to follow

Follow `~/Project/dev/dsh-src/AGENTS.md`. The ones that matter most here:

- ESM everywhere, TypeScript `strict`, Node >= 24.9, pnpm workspaces.
- Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()` so unloading reverts it.
- Waterfall listeners (`agent/pre-step`, `tools/pre-execute`, …) must call `next()`.
- Model-visible means logged: anything injected into a model request must come from a session event.
- No hardcoded tunables: deployment choices are validated `Config` fields settable from cordis.yml.
- Misconfiguration fails loud at load. Structured errors with `code` and a human-readable hint.
- DSH is a developer preview with breaking changes: develop against the pinned DSH version recorded in `docs/DSH-INTEGRATION.md`, and note any API you rely on there.

## Repository layout (target)

```
dsh-anima/
  CLAUDE.md
  docs/DESIGN.md
  docs/DSH-INTEGRATION.md
  packages/
    anima-core/          self state, persona prompt, policy gate, owner commands
    anima-life/          stimulus routing, sessions, heartbeat, open_conversation, outbox
    anima-memory/        memory store, recall, consolidation
    anima-adapter-local/ dev adapter over the DSH web UI
  presets/               conversation, self
  bundle/                anima bundle that installs everything into a DSH profile
```

## Verification

- Every package has unit tests for its logic (state math, gate decisions, routing, memory scoping).
- Each phase ends with a manual demo of its exit check in a DSH dev profile, described in the commit or PR.
- Report only checks you actually ran.
