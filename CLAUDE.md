# CLAUDE.md — Anima

Anima is a DSH (DeepSeek Harness) plugin that gives one AI character personality, memory and autonomy across chat platforms. Read this file fully before any work.

## Read first

1. `docs/CONSTITUTION.md`: overrides everything, including this file. The Anima plugin is the persona itself: everything in it is her will (a behavior, unrestricted) or her physiology (her body acting by itself, controlled by nobody: not her will, not the outside). Decide which before designing anything, by asking how it works in a human, not by its label. Anything else (rules, limits, management) is outside the persona, in `anima-guard` or DSH, shipped apart from her.
2. `docs/DESIGN.md`: the overview and body map, then the `docs/design/` file for the subsystem you touch.
3. `docs/dsh.md` when you use a DSH API; `docs/ROADMAP.md` for the current phase.
4. Only then read code. The code implements the first design (`docs/history/`) until the roadmap phases replace it.

If the design turns out to be wrong or incomplete while coding, stop and say so, propose the change, and update the matching `docs/design/` file in the same change once agreed. Code and design must not drift apart. Design files state only what is true now; history goes to git or `docs/history/`.

## Reference sources (read-only)

- DSH source: `~/Project/dev/dsh-src`. Read-only reference for APIs and conventions. Start from its `AGENTS.md`, `docs/architecture.md`, `docs/cordis-primer.md`, `docs/cookbook/`, and the README of any package you use. Never edit it.
- `~/Project/dev/surfcore`: the old plugin Anima replaces. Do not read it unless the user asks; when asked, take ideas only, never copy its structure.
- `~/Project/dev/dsh-mnemon`: do not read.

## Working rules

- **One roadmap phase at a time** (`docs/ROADMAP.md`). Do not build ahead of the current phase. A phase is done only when its exit check passes and is demonstrated.
- **Plan before code** for anything beyond a small fix: state what changes, which files, how it will be verified.
- **Simplest first.** Non-core features get the simplest working version; improve only when a real problem shows up.
- **Ask before** deleting files, changing DSH profile or config files under `~/.dsh`, starting anything that sends messages to real platform accounts, or adding a dependency that is not obviously needed.
- **One commit per roadmap phase** during early development, with a message that says what changed per package and why. Commit only when the user asks.

## Architecture rules (from the design)

- The model decides; code keeps state, runs physiology and moves messages. Never add code that chooses what she says or when (no keyword lists, no fixed-time scripts), or that judges what an event means: appraisal, and so emotion, is her cognition.
- No clock rule, count or quota inside the persona (no bedtimes, fixed wake times, daily change limits). Sleep, waking and pace come from her physiology; a rule the owner wants lives in the guard.
- Her prompt states facts about her body and places, never rules, trust rules, privacy fences or nudges about what she usually does.
- Every action is a behavior (a DSH tool + metadata). Speech only via explicit `say`; assistant text is never auto-forwarded.
- Inside the persona, nothing refuses a behavior except physiology. Safety limits, approvals and management live in `anima-guard`; persona packages never import it or `anima-page`.
- **The heartbeat is her self-drive.** It is physiology inside her body, like a human heart: it beats because she is alive, not because anything outside drives it, and nobody controls when it beats or how fast. Not her will: no behavior sets, delays or skips it (no `rest(until)`). Not the outside: no guard admit, owner limit, pause or budget starts, stops, skips or paces it. Its rhythm comes only from her own state (arousal, mood, energy, needs, asleep or awake) through her genes' parameters; those parameters are her body, not rules. It is not an external stimulus or a scheduler that pokes a passive model: it is the root of her autonomy. If the owner worries about cost, the guard acts on what she does to the world, never on her heartbeat.
- **Genes are not rules.** A physiological parameter (a rate, a range, a half-life) is part of her body; a rule restricts a choice. Never describe or build a physiological parameter as an "allowed" limit she or the owner can adjust around.
- **Her sessions only.** Anima acts only in DSH sessions it creates for her (from R4: only her waking sessions). A session opened in DSH's web UI stays plain DSH: no behavior, prompt, recall or stimulus of hers. There is no web UI channel now.
- Core packages (`anima-core`, `anima-life`, `anima-memory`) never import an adapter. Adapters depend on core interfaces only.
- Tool names are `snake_case` with an area or platform prefix (`qq_say`, `memory_recall`).
- Plugin data lives in `~/.anima/` (configurable). Never write into DSH's own data directory except through DSH APIs.

## DSH conventions to follow

Follow `~/Project/dev/dsh-src/AGENTS.md`. The ones that matter most here:

- ESM everywhere, TypeScript `strict`, Node >= 24.9, pnpm workspaces.
- Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()` so unloading reverts it.
- Waterfall listeners (`agent/pre-step`, `tools/pre-execute`, …) must call `next()`.
- Model-visible means logged: anything injected into a model request must come from a session event.
- No hardcoded tunables: deployment choices are validated `Config` fields settable from cordis.yml.
- Misconfiguration fails loud at load. Structured errors with `code` and a human-readable hint.
- DSH is a developer preview with breaking changes: develop against the pinned DSH version recorded in `docs/dsh.md`, and note any API you rely on there.

## Repository layout (target)

```
dsh-anima/
  CLAUDE.md
  docs/                CONSTITUTION.md, DESIGN.md, design/, dsh.md, ROADMAP.md, history/
  packages/
    anima-core/          state and physiology, persona prompt, behavior registry, clock
    anima-life/          waking sessions, stimuli, wait, inbox, heartbeat, sleep and waking
    anima-memory/        long-term memory, recall cues, consolidation in sleep, decay
    anima-adapter-qq/    QQ through a replaceable backend (OneBot v11: NotRainMeow or any OneBot v11 runtime)
    anima-adapter-bili/  Bilibili, read-only (skim, watch, look closely)
    anima-guard/         outside the persona: safety gate, approvals, owner commands, management
    anima-page/          the Anima page in DSH's web UI, over anima-guard
  bundle/                the Anima plugin: installs the persona packages only
  guard-bundle/          installs anima-guard and anima-page, outside the persona, separately
```

## Verification

- Every package has unit tests for its logic (state math, physiology, gate decisions, delivery, recall and decay).
- Each phase ends with a manual demo of its exit check in a DSH dev profile, described in the commit or PR. Sped-up demos use the fake demo platform (`scripts/demo/demo-platform.mjs`), never shipped.
- Report only checks you actually ran.
