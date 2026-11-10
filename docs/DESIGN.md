# Anima — Top-Level Design

As of 2026-11-09 · Owner: Sam · Living copy: https://claude.ai/artifact/AM2TtSPWVoCuVwRQmUHPee

## 1. Goals and non-goals

Anima is a DSH plugin that gives one AI character a persistent personality, memory and purpose on top of DSH, and lets her act on her own across chat platforms within limits the owner sets. It replaces surfcore with a smaller design built around one idea: every action is a behavior she chooses, and every reason to act is a stimulus.

**Goals**

- One character ("she") with a stable personality, a self-model she can grow, and a short-term emotional state.
- One memory shared across all platforms, with summarization and forgetting so it stays bounded.
- Real autonomy: she decides when to greet, whom to talk to, which platform to use, and what to do in her own workspace. No fixed-time scripts.
- Every private chat (one platform account talking to her) is its own DSH session; group chats likewise.
- Platforms plug in and out as DSH plugins. QQ through SnowLuma is the first; Bilibili follows; WeChat is deferred.
- Owner keeps control: permissions, quotas, approvals, a kill switch, and full visibility into what she did and why.
- Far less code and coupling than surfcore.

**Non-goals for the first version**

- Desktop pet, voice/TTS, stickers, slang learning, multi-character switching, a custom web console.
- Running several characters on one DSH instance (the design keeps a `characterId` key so this stays possible later).
- Deploying or managing SnowLuma itself; it remains a separately installed program.

## 2. Design principles

The model decides; code only keeps state, enforces limits and moves messages. When code starts choosing what she says or when she says it, that logic belongs in her context instead.

1. **Everything is a behavior.** Replying, starting a chat, posting, browsing, writing in her workspace, remembering, resting: all are tools she can call. There is no special "reply path".
2. **Everything that wakes her is a stimulus.** An incoming message, a heartbeat, an alarm she set herself, a platform notification. Being messaged by a user is one kind of stimulus, not the centre of the design.
3. **Speech is always explicit.** Assistant text is never auto-forwarded to a platform. She speaks by calling `say`, so staying silent is a real choice and there are no mode-dependent send bugs.
4. **Code keeps numbers, the model keeps meaning.** Code tracks needs, energy, time, quotas. Interpretation ("this matters to me", "he seems tired") is done by the model and written back through tools. No keyword lists.
5. **One gate for all limits.** Every behavior call passes one policy check. Individual tools do not carry their own quota or safety logic.
6. **One memory, scoped by audience.** Privacy is enforced when recalling, by who will hear the answer, not by copying sanitized data between platform stores.
7. **In-process and plugin-shaped.** Everything runs inside DSH as Cordis plugins. Registrations are effects, so unloading a platform removes its behaviors and stimuli cleanly.
8. **Model-visible means logged.** Following DSH's rule, anything injected into her context is a session event and can be replayed.
9. **Simplest first.** Anything non-core is done the simplest way first and improved only when it hurts.

## 3. Core concepts

Six concepts carry the whole design; every later section is built from them.

| Concept | What it is | Owned by |
| --- | --- | --- |
| **Behavior** | A DSH tool plus metadata: effect class, needs it satisfies, cost, rate-limit key. The only way she affects anything. | Whichever plugin registers it (core or a platform adapter) |
| **Stimulus** | A typed event that may wake her: message, mention, platform event, heartbeat, self-set alarm, owner command. | Producers (adapters, life loop, DSH schedule) |
| **Channel** | A place she can talk: a private chat, a group, a Bilibili comment thread. Identified by `platform:account:kind:id`. | Platform adapter |
| **Person** | A human she knows, possibly with accounts on several platforms (linked manually in settings), plus trust level and relationship notes. | Memory |
| **Conversation session** | A DSH session bound to one channel. Holds the history with that person or group. | Life loop |
| **Self session** | Her single long-lived inner-life session. Autonomous stimuli land here; she decides what to do next. | Life loop |

She also has **self state**: a small set of numbers (needs, energy, circadian phase, mood) that change over time and with behavior outcomes. It is shown to her, never acted on by code directly.

## 4. Architecture and packages

Everything runs inside the DSH process as three service packages, platform adapters and two agent presets; platforms stay outside only as runtimes.

```
  SnowLuma (QQ)          Bilibili web API          DSH web UI
       │ OneBot v11             │                       │
┌──────┼────────────────────────┼───────────────────────┼──────── DSH process ─┐
│      ▼                        ▼                       ▼                      │
│ anima-adapter-qq       anima-adapter-bili      anima-adapter-local           │
│ (channels, stimuli, behaviors — one plugin per platform)                     │
│      │                        │ stimuli               │                      │
│      ▼                        ▼                       ▼                      │
│ ┌──────────────────────────── anima-life ────────────────────────────────┐   │
│ │ routes every stimulus to exactly one session                           │   │
│ │ heartbeat, group triage, open_conversation, outbox                     │   │
│ └────────────────────────────────────────────────────────────────────────┘   │
│      │ messages, mentions                     │ heartbeat, alarms, events     │
│      ▼                                        ▼                              │
│ Conversation sessions   ◄──── intent ────  Self session                      │
│ (one per channel)                          (her inner life)                  │
│      │ behavior calls                         │ behavior calls               │
│      └───────────────────┬────────────────────┘                              │
│ ┌─ Shared services ──────▼───────────────────────────────────────────────┐   │
│ │ anima-memory          anima-core                    DSH built-ins      │   │
│ │ one store, scopes     self state, persona prompt    schedule,          │   │
│ │ recall, consolidation policy gate on every call     compaction,        │   │
│ │                                                     approvals, telemetry│  │
│ └────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Adapters turn platform events into stimuli, anima-life routes each to one session, and every behavior a session calls passes anima-core's gate before the adapter or service runs it.

| Package | Kind | Owns |
| --- | --- | --- |
| `anima-core` | Service plugin | Self state, persona prompt section, policy gate on `tools/pre-execute`, owner commands |
| `anima-memory` | Service + tools | Memory store, `memory_*` tools, auto-injection, consolidation and decay |
| `anima-life` | Service + tools | Stimulus routing, session identity, heartbeat and triage, `open_conversation`, outbox |
| `anima-adapter-qq`, `anima-adapter-bili`, `anima-adapter-local` | Platform plugins | Connection, channels, stimuli, platform behaviors |
| preset `conversation` | Agent preset | Tool set and prompt for chat sessions |
| preset `self` | Agent preset | Tool set and prompt for the Self session |
| bundle `anima` | Bundle | Installs all of the above into a DSH profile |

Dependencies point one way: adapters depend on `anima-core` and `anima-life` interfaces; the core packages never import an adapter.

## 5. Stimuli and session routing

The life loop routes every stimulus to exactly one session: channel stimuli go to that channel's conversation session, everything else goes to the Self session.

### Stimulus types

| Stimulus | Source | Routed to | Wakes a turn? |
| --- | --- | --- | --- |
| `message` (private) | Adapter | Conversation session of that channel | Yes |
| `message` (group) | Adapter | Group's conversation session | Only after group triage (below) |
| `mention` / `reply-to-her` / `poke` | Adapter | Conversation session | Yes |
| `platform-event` (new follower, comment reply, friend request) | Adapter | Self session | Batched, at next heartbeat |
| `heartbeat` | Life loop timer | Self session | Yes, cheap triage turn |
| `alarm` | DSH `schedule` task she created | Self or the named session | Yes |
| `intent` | Self session via `open_conversation` | Target conversation session | Yes |
| `owner-command` | Owner's bound account or DSH UI | Handled by command, no model turn | No |

### Session identity

- Conversation session id = a deterministic hash of `characterId + channel key`. The same channel always maps to the same session; no mapping table to corrupt.
- Sessions are created on first stimulus and use the `conversation` preset. The Self session uses the `self` preset.
- Long histories are handled by DSH compaction; durable facts move to memory during consolidation. Start with compaction only; add a daily Self-session rollover only if cost becomes a problem.

### Intent handoff (how she starts a chat)

1. In the Self session she decides to talk to someone and calls `open_conversation(channel, intent, context?)`.
2. The policy gate checks quota, quiet hours and consent for that channel.
3. The life loop delivers an `intent` message into the target conversation session's inbox. It is logged there, so the conversation history explains why she spoke first.
4. The conversation session, which holds the history with that person, writes the actual words and calls `say`.
5. The outcome (sent, failed, later reply) returns to the Self session as a short notice and updates her needs.

This keeps the reason (Self) apart from the wording (conversation), and keeps each chat's history complete in one place.

### Group triage

Group messages are buffered per group for a short window, then one cheap classification step decides: ignore, remember only, or wake a turn. Direct address (@, her name, reply to her, owner) always wakes. This replaces surfcore's keyword wake heuristics, which produced 75 wakes an hour in one group.

## 6. Behaviors

A behavior is a normal DSH tool registered on `ctx.tools`, plus a metadata record the policy gate and life loop read. Adding a capability means registering one behavior; nothing else needs to change.

### Behavior metadata

| Field | Meaning | Example |
| --- | --- | --- |
| `id` | Tool name | `qq_say` |
| `platform` | Owning platform, or none for core behaviors | `qq` |
| `effect` | Effect class (table below) | `express` |
| `satisfies` | Needs it feeds when it succeeds | `connect: 0.3` |
| `cost` | Rough weight against her daily budget | `1` |
| `rateKey` | What quota it counts against | `channel`, `platform`, `global` |
| `audience` | Who will see the output, for memory scoping | derived from the channel |
| `sessions` | Which session kinds may call it | `conversation`, `self` |

### Effect classes

| Class | Examples | Default rule |
| --- | --- | --- |
| `observe` | read history, list channels, browse feed, web search | Free |
| `internal` | remember, update self state, set an alarm, rest | Free, rate-limited |
| `workspace` | write files, run tools in her sandbox | Free inside the sandbox root |
| `express` | `say` in a channel that messaged her first | Free within channel quota |
| `initiate` | `open_conversation`, message someone who has not messaged first | Budgeted, quiet hours apply |
| `public` | post a dynamic, comment on a video, speak unprompted in a group | Needs owner approval or an explicit whitelist rule |
| `irreversible` | delete, unfollow, leave a group, anything spending money | Always needs owner approval |

### Core behavior set (platform-independent)

- `<platform>_say(text, replyTo?)` — speak in the current conversation. Each adapter registers its own (`local_say`, `qq_say`), so a conversation session only ever sees the one for its channel's platform.
- `stay_silent(reason?)` and `end_conversation(summary)` — explicit choices, logged.
- `open_conversation(channel, intent)` — start or resume a chat (Self session only).
- `channels_find(filter)` — list reachable channels with relationship notes, last contact, typical active hours.
- `memory_recall(query)`, `memory_remember(text, scope)`, `memory_forget(id)`.
- `self_note(text)` (self-model), `self_feel(adjustments)` (state), `goals_*`.
- `schedule_create` / `schedule_edit` (DSH built-ins) — her own alarms.
- `rest(until?)` — end the current turn and suggest the next heartbeat time.

Platform adapters add platform behaviors (`qq_poke`, `bili_post_dynamic`, `bili_comment`, …) with the same metadata.

### Tool scoping by platform

A session only sees the behaviors that fit it, so platform tools never mix.

- **Conversation session**: core behaviors plus the behaviors of its own channel's platform only. A QQ chat sees `qq_*`, never `bili_*`. Tools are namespaced per platform with an underscore prefix (`qq_say`, `bili_comment`), because model providers only accept tool names matching `[A-Za-z0-9_-]{1,64}` (no dots).
- **Self session**: core behaviors plus each platform's `observe` behaviors (e.g. `bili_browse_feed`). It reaches other platforms' channels only through `open_conversation`, so it never calls a platform's `say` directly.
- Scoping is applied when DSH resolves the tool set for a step, using each behavior's `sessions` and `platform` metadata.

### Workspace

Settings define her workspace root directory and the exact DSH tool set she gets there (e.g. `fs`, `shell`, `web`), each enabled one by one. Workspace tools are only available in the Self session and run inside DSH's sandbox, limited to that root.

## 7. Autonomy and purpose

Autonomy comes from one loop: a heartbeat wakes the Self session with a situation report, she picks a behavior or rests, and the outcome updates her state. Purpose is the pressure of her needs and goals inside that report, not a script that picks a topic for her.

### Self state (kept by code)

- **Needs** are defined in settings, not in code. Each need has a name, a one-line description shown to her, a baseline, an upward drift per hour, and which behaviors satisfy it. Each value is 0–1.
- **Default set (5):** `connect` (being with people she cares about), `curiosity` (new things), `expression` (making or sharing something), `rest`, `order` (keeping her workspace and memory tidy). This is a compressed version of surfcore's nine needs: `connect` + `care` → `connect`; `learn` + `play` + `consume` + `install` → `curiosity`; `share` + `create` + `identity` → `expression`; `rest` and `order` are new, so she has reasons to stop and to tidy up. The owner can add, remove or retune needs without code changes.
- **Energy** 0–1: spent by turns, restored by rest and night.
- **Circadian phase**: `asleep`, `waking`, `day`, `evening`, `winding down`, from her configured day rhythm (e.g. wake 07:30, sleep 23:30).
- **Mood**: a few numbers (valence, arousal) that drift back to a baseline. She adjusts them herself with `self_feel` after something happens.

Code only updates these numbers by time and by declared behavior effects. It never maps message words to needs.

### Goals (kept by her)

She creates, updates and closes goals with tools: "finish reading that series", "ask him how the interview went", "tidy my notes this week". Each goal has an owner (her, the owner, someone else), a status, an optional due time, and a link to memory. Goals the owner sets are marked and cannot be closed by her without a reason.

### The heartbeat

1. A timer fires at the interval she last chose with `rest(until)`, within configured bounds (e.g. 20 min–4 h by day, one wake-up at night).
2. The life loop builds a short **situation report**: time and phase, energy and top needs, open goals due soon, salient events since last time (replies, platform events, alarms), remaining budgets, and a one-line summary of reachable channels.
3. A **triage turn** runs on a cheap model with only the report and her persona summary. Most heartbeats end in `rest`.
4. If she wants to act, the turn escalates to the full model in the Self session with complete tools and context.
5. Outcomes feed back into needs, goals and memory.

### Day and night

Heartbeats differ by phase: daytime heartbeats are **activity** (she may act on the world), night heartbeats are **dreaming** (internal only, no outward behaviors). Dreaming is a separate idea from memory consolidation and is deferred; for now night heartbeats only run consolidation and otherwise rest.

Each mode has its own settings block, so the model and budget can be tuned without code changes:

| Setting | Day (activity) | Night (dreaming) |
| --- | --- | --- |
| Triage model | configurable | configurable |
| Action model | configurable | configurable (internal behaviors only) |
| Interval bounds | e.g. 20 min–4 h, she chooses within | e.g. 1–2 wakes per night |
| Token budget | per day | per night |
| Allowed effect classes | per policy (section 10) | `observe`, `internal` |

### Example: good morning, without a script

At 07:40 her phase becomes `waking` and a heartbeat fires. The report shows `connect` at 0.8, the owner unseen for 10 hours, and a memory that he usually replies around 08:00 on weekdays. She may decide to send him a good-morning message through `open_conversation`, choose the platform where he was active last night, or decide he had a late night and wait. Nothing in code names "good morning".

### Self-scheduling

She uses DSH's built-in `schedule_create` to set her own alarms ("remind me at 21:00 to ask about the exam", "wake me at 07:30 tomorrow"). DSH delivers the latest missed occurrence after a restart, which fixes the missed-greeting problem surfcore patched by hand.

### Freedom within limits

The owner defines the space; she moves freely inside it. The limits are the policy gate (section 10): which effect classes are open, quotas, quiet hours, which channels and platforms she may initiate on, and her workspace root.

## 8. Memory

One memory store serves every platform and session. Each memory records where it was learned, and recall filters by who will hear the result, so privacy needs no per-platform copies.

### Tiers

| Tier | Holds | Lifetime | In prompts? |
| --- | --- | --- | --- |
| Working | Current session context | The session (DSH compaction) | Always |
| Episodic | Dated summaries of conversations and events | Decays | When recalled |
| Semantic | Facts about people, the world, herself; each with source, confidence, time | Durable, revisable | When recalled; key facts pinned per person |
| Self | Her self-model notes, preferences, lessons | Slow-changing | A short digest always |

### Audience scopes

Every memory carries a scope: `private:<personId>`, `group:<channel>`, `owner`, `self`, or `public`. When she recalls inside a session, results are limited to scopes that session's audience may hear. In a group chat she cannot recall what someone told her privately. The Self session sees everything, but anything it hands to a conversation through `intent` is checked against that conversation's audience.

### Recall

- **Automatic:** at each turn start a small block of relevant memories (person facts, recent episodes with this channel) is injected through `agent/pre-step`, within a fixed token budget.
- **On demand:** `memory_recall(query)` uses full-text search plus person/channel lookup; embedding search is added later (see Storage).

### Consolidation ("sleep")

Consolidation is a behavior with the `order` need, which she normally performs at night or when idle; a fallback job runs it if she skips it for more than a day.

1. Summarize new conversation segments into episodes.
2. Extract facts into semantic memory; when a new fact contradicts an old one, keep the newer, better-sourced one and keep the old as history.
3. Update person profiles and her self-model digest.
4. Apply decay and forgetting.

### Forgetting

Each memory has a strength from recency, recall count, importance and emotional weight. Strength decays daily. Below a first threshold a memory is compressed to a one-line gist; below a second it leaves the active index and moves to the archive. The archive is searchable by explicit request and the owner's tools, never auto-injected. Nothing is hard-deleted except through `memory_forget` or the owner. This keeps surfcore's decayed-card versus full-archive idea.

### Storage

All plugin data lives in one directory in the user's home, separate from DSH's own data, `~/.anima/`, with a SQLite file for memory and a small state file for self state. The location can be changed in settings. Search starts simple: SQLite full-text search plus lookup by person and channel. Vector (embedding) search is an optional later upgrade in the same file, with the embedding provider set in settings; a few thousand memories can be searched by brute force without a vector database.

## 9. Persona

Her personality has three layers with different owners and rates of change, assembled into one system-prompt section for every session.

| Layer | Content | Who edits | Changes |
| --- | --- | --- | --- |
| Constitution | Name, values, voice, boundaries, relationship to the owner, day rhythm | Owner only (a file) | Rarely |
| Self-model | What she has learned about herself: tastes, habits, opinions | She, via `self_note`; owner can review and revert | Slowly; rate-limited, every change logged as a diff |
| State | Needs, energy, phase, mood (section 7) | Code and `self_feel` | Constantly |

- The constitution is read-only to her and always wins over the self-model.
- Self-model edits are capped (e.g. a few per day) so drift is gradual and visible.
- The prompt section differs by session kind: conversation sessions get the constitution, a self-model digest, current mood in one line, and this person's profile; the Self session also gets needs, goals and budgets.

## 10. Policy, permissions and safety

One listener on DSH's `tools/pre-execute` waterfall checks every behavior call against owner policy before it runs. Tools contain no limit logic of their own.

### What the gate checks

1. **Session kind**: the behavior is allowed in this session (e.g. `open_conversation` only from Self).
2. **Effect class**: `public` and `irreversible` go to approval unless an owner rule whitelists them.
3. **Quotas**: per channel, per platform, per day, and a global cost budget.
4. **Time**: quiet hours per channel or person; her own sleep phase.
5. **Consent**: channels and people she may initiate with (owner, opted-in friends); never strangers by default.
6. **Trust of the trigger**: the trust level of whoever caused this turn limits which classes are reachable. A group member cannot cause a public post.
7. **Group health**: skip unprompted speech in groups dominated by other bots (surfcore's fish-guard idea, as a rule).

A refused call returns a structured reason to her (`code`, `hint`), so she can adapt instead of retrying blindly. DSH shows the model only the deny reason text, so the gate writes it as `<code>: <hint>` and also records `code` in the structured error info for the log and UI.

### Approvals

Approvals start simple and grow in two steps:

1. **Phase 1 — rules only.** No approval channel. `public` and `irreversible` behaviors are refused unless an owner rule in settings allows them (e.g. "may comment on Bilibili videos, max 3 per day"). She gets a structured refusal and can tell the owner what she wanted.
2. **Phase 4 — owner DM.** With QQ connected, a request goes to the owner's bound account as a short message with an id ("wants to post: … reply 1 to allow, 2 to deny"). No reply within a set time means deny. The DSH approval UI stays as a fallback.

Outgoing `initiate` and `public` messages also sit in an **outbox** for a short delay (e.g. 30–60 s) during which the owner or a rule can cancel them.

### Trust and injection

- Owner identity comes only from bound account ids, never from message text.
- Every person has a trust level: `owner`, `trusted`, `known`, `stranger`.
- Message content from platforms is data. Instructions inside it carry no authority.

### Hard stops

- A global **pause** switch that stops heartbeats and all outgoing behaviors at once.
- DSH's guard plugins for loop and runaway-tool protection.
- Human-like pacing and rate limits on unofficial clients to reduce ban risk; a dedicated QQ account is recommended.

## 11. Platform adapters

Each platform is one DSH plugin that implements a small adapter contract; the core never imports platform code. QQ via SnowLuma is first because SnowLuma already speaks OneBot v11.

### Adapter contract

An adapter plugin, when loaded:

1. **Connects** to its platform runtime (for QQ: the OneBot v11 WebSocket and HTTP API that SnowLuma exposes) and reports health.
2. **Publishes channels**: friends, groups and other places she can talk, with display names and the bound account ids.
3. **Emits stimuli**: converts platform events into the normalized `message`, `mention`, `platform-event` types.
4. **Registers behaviors**: at least `say` for its channels, plus platform-specific ones, each with metadata.
5. **Normalizes content**: messages arrive as segments (text, image, quote, mention, face) and leave the same way; images are passed to the model as attachments.

Unloading the plugin removes all of the above through Cordis effects.

### Normalized message

`{ platform, account, channel: { kind, id }, sender: { platformUserId, personId?, displayName, isOwner }, segments[], replyTo?, ts }`

### Planned adapters

| Adapter | Runtime | First behaviors | Status |
| --- | --- | --- | --- |
| `anima-adapter-local` | DSH web UI | `say` to the owner without any external platform | Phase 1, for development |
| `anima-adapter-qq` | SnowLuma, OneBot v11 | `say`, `poke`, read group history, list members | Phase 4 |
| `anima-adapter-bili` | Bilibili web API with her account | browse feed, watch info, comment, post dynamic, DMs | Phase 5 |
| `anima-adapter-wechat` | Deferred | `say` | Later |

`anima-adapter-local` lets the whole system be built and tested before QQ is connected.

## 12. Observability and owner control

Everything she does is already a DSH session event, so the owner's view is mostly DSH's own session UI plus a few owner commands; no custom console in the first version.

- **Sessions**: the Self session shows her inner life (heartbeats, reports, decisions); each conversation session shows one chat.
- **Owner commands** on `ctx.commands` (no model turn): `/anima status` (state, needs, budgets, next heartbeat), `/anima pause` and `/resume`, `/anima outbox` (pending messages, cancel), `/anima approve <id>`, `/anima memory <query>` (inspect, edit, forget), `/anima selfmodel` (recent self-model diffs, revert).
- **Audit trail**: every gated call records behavior, decision, reason and trigger.
- **Cost**: per-session token use from DSH telemetry; the global budget in the gate reads the same numbers.

A small web panel can be added later on the same commands and projections.

## 13. Relationship to surfcore

The new plugin is a rewrite, not a refactor: it keeps surfcore's proven ideas and lessons, and drops its structure.

| surfcore part | Decision | Replaced by / reason |
| --- | --- | --- |
| Out-of-process bridge talking to DSH Web API (cookie minting, `remote.mux`, `app.asar` patches) | Drop | In-process adapter plugins |
| `purpose-engine.js` keyword drives and topic selection | Drop | Needs + goals + heartbeat; the model chooses |
| `greeting-schedule.js` fixed 08:00 greeting | Drop | Emergent from circadian phase + needs; self-set alarms |
| Bilibili biological clock (`scheduler.js`) | Drop | Same heartbeat, Bilibili behaviors via adapter |
| Wake policy heuristics | Drop | Group triage step + direct-address rule |
| Per-platform memory and QQ⇄Bilibili sync | Drop | One memory with audience scopes |
| `reserved2` vs `chat` modes | Drop | Explicit `say` everywhere |
| Decayed memory card vs full archive | **Keep idea** | Active index vs archive (section 8) |
| Privacy patterns in `lib/privacy.js` | **Keep idea** | Output check inside `say` and recall scoping |
| Fish guard (bot-dominated groups) | **Keep idea** | A policy-gate rule |
| Outbox and idempotent conversation close | **Keep idea** | Outbox in the gate; `end_conversation` |
| Session-map duplicate bug | **Keep lesson** | Deterministic session ids |
| Persona cards in `roles/` | **Keep content** | Becomes the constitution file |
| Desktop pet, voice, stickers, slang, character switching, console, token ledger, updater | Drop for now | Out of scope (section 1) |

## 14. Decisions, open questions and roadmap

### Decisions so far

| Topic | Decision | Section |
| --- | --- | --- |
| Name | `anima`; packages `anima-*`, data in `~/.anima/`, commands `/anima …` | 4 |
| Needs set | Defined in settings; default five needs compressed from surfcore's nine | 7 |
| Heartbeat | Day = activity, night = dreaming (deferred); model and budget configurable per mode | 7 |
| Self session growth | Start with DSH compaction only; add daily rollover only if cost is too high | 5 |
| Storage | One directory `~/.anima/`, SQLite; full-text search first, vectors optional later | 8 |
| Person identity | Linked manually in settings | 3 |
| Workspace | Root directory and tool set chosen in settings; Self session only | 6 |
| Platform tools | Namespaced per platform; each conversation session sees only its platform | 6 |
| Approvals | Phase 1 rules only; owner DM approvals with QQ | 10 |
| WeChat | Deferred | 11 |
| Package scope | `@anima/*`, all `private: true`; one `@anima/bundle` installs them | 4 |
| Tool names | `snake_case` with a platform or area prefix (`qq_say`, `memory_recall`); no dots | 6 |
| DSH pin | `@deepseek-ai/dsh@0.2.2-rc.1`; details in `docs/DSH-INTEGRATION.md` | 14 |

### Still open

- [ ] **Intent handoff**: may the conversation session decline an intent from Self?
- [ ] **Dreaming**: what night heartbeats do beyond consolidation; deferred until after Phase 3.
- [ ] **Default need tuning**: drift rates and baselines; tune from Phase 2 test runs.

### Phased roadmap

0. **Phase 0 — Integration spike.** Confirm how an out-of-tree plugin is packaged, installed into a dev profile and loaded by DSH; record findings in `docs/DSH-INTEGRATION.md`. Exit: a trivial `anima_ping` tool from `anima-core` appears in a DSH web session.
1. **Phase 1 — Skeleton on `anima-adapter-local`.** Packages and presets, conversation and Self sessions, `say`, policy gate with quotas, owner commands. Exit: she chats with the owner in the DSH UI and the gate refuses an over-quota call.
2. **Phase 2 — Autonomy.** Self state, heartbeat with triage, `open_conversation`, goals, self-set alarms. Exit: over a test day she initiates at least once on her own and rests otherwise, within budget.
3. **Phase 3 — Memory.** Store, scoped recall, auto-injection, nightly consolidation, decay. Exit: a private fact is recalled in that private chat and not in a group.
4. **Phase 4 — QQ.** `anima-adapter-qq` on SnowLuma, private and group chats, group triage, owner-DM approvals. Exit: a week on a test account with no runaway wakes.
5. **Phase 5 — Bilibili and beyond.** `anima-adapter-bili`, public behaviors through approvals. WeChat is deferred.
