# Anima — Top-Level Design

As of 2026-11-10 (Phase 4) · Owner: Sam · Living copy: https://claude.ai/artifact/AM2TtSPWVoCuVwRQmUHPee

## 1. Goals and non-goals

Anima is a DSH plugin that gives one AI character a persistent personality, memory and purpose on top of DSH, and lets her act on her own across chat platforms within limits the owner sets. It replaces surfcore with a smaller design built around one idea: every action is a behavior she chooses, and every reason to act is a stimulus.

**Goals**

- One character ("she") with a stable personality, a self-model she can grow, and a short-term emotional state.
- One memory shared across all platforms, with summarization and forgetting so it stays bounded.
- Real autonomy: she decides when to greet, whom to talk to, which platform to use, and what to do in her own workspace. No fixed-time scripts.
- Every private chat (one platform account talking to her) is its own DSH session; group chats likewise.
- Platforms plug in and out as DSH plugins. QQ through NapCatQQ (over OneBot v11, so any OneBot v11 runtime fits) is the first; Bilibili follows; WeChat is deferred.
- Owner keeps control: permissions, quotas, approvals, a kill switch, and full visibility into what she did and why.
- Far less code and coupling than surfcore.

**Non-goals for the first version**

- Desktop pet, voice/TTS, stickers, slang learning, multi-character switching, a custom web console.
- Running several characters on one DSH instance (the design keeps a `characterId` key so this stays possible later).
- Deploying or managing the QQ runtime (NapCatQQ) itself; it remains a separately installed program.

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

Nine concepts carry the whole design; every later section is built from them.

| Concept | What it is | Owned by |
| --- | --- | --- |
| **Behavior** | A DSH tool plus metadata: effect class, needs it satisfies, cost, rate-limit key. The only way she affects anything. | Whichever plugin registers it (core or a platform adapter) |
| **Stimulus** | A typed event that may wake her: message, mention, platform event, heartbeat, self-set alarm, owner command. | Producers (adapters, life loop, DSH schedule) |
| **Channel** | A place she can talk: a private chat, a group, a Bilibili comment thread. Identified by `platform:account:kind:id`. | Platform adapter |
| **Person** | A human she knows, possibly with accounts on several platforms (linked manually in settings), plus trust level and relationship notes. | Memory |
| **Conversation session** | A DSH session bound to one channel. Holds the history with that person or group. | Life loop |
| **Self session** | Her single long-lived inner-life session. Autonomous stimuli land here; she decides what to do next. | Life loop |
| **Triage session** | One short-lived session per day of hers that runs the cheap heartbeat decision: rest, or wake the Self session to act. | Life loop |
| **Group-triage session** | One short-lived session per day of hers that sorts buffered group chatter on a cheap model: ignore, remember, or wake the group (section 5). | Life loop |
| **Consolidation session** | One short session per day of hers that sorts her transcript into memories, on a cheap model. | Memory (delivered by the life loop) |

She also has **self state**: a small set of numbers (needs, energy, circadian phase, mood) that change over time and with behavior outcomes. It is shown to her, never acted on by code directly.

## 4. Architecture and packages

Everything runs inside the DSH process as three service packages, platform adapters and two agent presets; platforms stay outside only as runtimes.

```
  NapCatQQ (QQ)          Bilibili web API          DSH web UI
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
| `channel-event` (recalled message) | Adapter | Conversation session, only if it exists | No; context for the next turn |
| `mention` / `reply-to-her` / `poke` | Adapter (a group message marked `addressed`; a poke is a message `[pokes you]`) | Conversation session | Yes |
| `platform-event` (new follower, comment reply, friend request) | Adapter (`animaLife.note`) | Self session's report | Batched, at next heartbeat |
| `group-batch` | Group triage | Group-triage session of her day | Yes, cheap triage turn |
| `heartbeat` | Life loop timer | Triage session of her day; escalates to Self | Yes, cheap triage turn |
| `alarm` | DSH `schedule` task she created | Self or the named session | Yes |
| `intent` | Self session via `open_conversation` | Target conversation session | Yes |
| `consolidate` | Memory (`memory_consolidate` or the fallback job) | Consolidation session of her day | Yes, on the consolidation model |
| `owner-command` | Owner's bound account or DSH UI | Handled by command, no model turn | No |

### Session identity

- Conversation session id = a deterministic hash of `characterId + channel key`. The same channel always maps to the same session; no mapping table to corrupt.
- Sessions are created on first stimulus and use the `conversation` preset. The Self session uses the `self` preset; triage sessions use the `triage` preset, with id = hash of `characterId + day`, so each of her days (wake to wake) gets a fresh, short triage history.
- The Self session id = hash of `characterId` plus a `selfGeneration` number (config, default 1). Raising it starts a fresh Self session when the old one cannot continue. The old one stays in the sidebar; her state, goals and memory live in the data directory and carry over.
- Anima sessions hide global tools that do not belong to her (`working_directory`, `anima_ping`) through the persona row's `hideTools`.
- Every stimulus Anima delivers starts with the time on her clock (`[Tue 2026-11-10 08:12] …`). Anima presets do not use DSH's time context, which reads only the real clock.
- Long histories are handled by DSH compaction; durable facts move to memory during consolidation. Start with compaction only; add a daily Self-session rollover only if cost becomes a problem.

### Intent handoff (how she starts a chat)

1. In the Self session she decides to talk to someone and calls `open_conversation(channel, intent, context?)`.
2. The policy gate checks quota, quiet hours and consent for that channel.
3. The life loop delivers an `intent` message into the target conversation session's inbox. It is logged there, so the conversation history explains why she spoke first.
4. The conversation session, which holds the history with that person, writes the actual words and calls `say`, or declines by calling `stay_silent(reason)`.
5. The outcome (sent, failed, declined, later reply) returns to the Self session as a short notice that does not wake it, and appears in the next heartbeat report. Needs move only through the `say` itself. A declined intent still counts against the daily initiate budget.

This keeps the reason (Self) apart from the wording (conversation), and keeps each chat's history complete in one place.

### Group triage

Group messages are buffered per group for a short window, then one cheap classification step decides: ignore, remember only, or wake a turn. Direct address (@, reply to her, a poke, owner) always wakes. This replaces surfcore's keyword wake heuristics, which produced 75 wakes an hour in one group. Group triage lives in `anima-life` and is platform-independent (local test groups use it too).

- **Direct address.** The adapter marks a group message `addressed` from platform data (QQ: an `at` segment with her number, or a `reply` to one of her messages). An addressed message or one from the owner wakes the group's conversation session at once; messages buffered for that group are injected first as context.
- **Buffer.** Any other group message waits in its group's buffer for `groupTriage.windowSeconds` of real time (default 60), or until `maxBatch` messages (default 30). The buffer then closes into a batch `b<n>`.
- **Classify.** The batch goes to the **group-triage session** of her day (`anima-g-<hash(characterId, day)>`, preset `anima-group-triage`, model `groupTriage.model`, by default the day triage model). There she calls exactly one of:
  - `group_wake(batch, reason)`: the batch goes to the group's conversation session; the earlier messages are injected as context, and the last one wakes her
  - `group_pass(batch, remember, reason?)`: `remember: true` keeps the lines only in her transcript with the group scope, so consolidation turns them into `group:` memories; `false` drops them
- **Limits stay in the gate.** A default quota `group_wake` 6 per hour per channel caps triage wakes; the `channel` counter uses the behavior's `target` (the batch's group).
- **Fallbacks never wake.** No decision within `groupTriage.timeoutSeconds` (default 300), or a turn that ends without one, means remember. At night, while paused, or over the token budget the batch is remembered without a model call.
- `life.json` keeps per-day, per-group counters (direct and triage wakes, batches, outcomes, fallbacks); `/anima status` shows today's.

**Test channels (`anima-adapter-local`, dev only):** `/anima chat [--as <name>] [--in group:<id>] <text>` speaks as another person (a private chat `local:owner:private:<name>`) or in a simulated group (`local:owner:group:<id>`). In a simulated group, a message that contains her name counts as addressed. The test channels are kept in `<dataDir>/local/channels.json`.

## 6. Behaviors

A behavior is a normal DSH tool registered on `ctx.tools`, plus a metadata record the policy gate and life loop read. Adding a capability means registering one behavior; nothing else needs to change.

### Behavior metadata

| Field | Meaning | Example |
| --- | --- | --- |
| `id` | Tool name | `qq_say` |
| `platform` | Owning platform, or none for core behaviors | `qq` |
| `effect` | Effect class (table below) | `express` |
| `satisfies` | Needs it feeds when it succeeds. Kept in the needs settings (`needs[].satisfiedBy`), not on the behavior, so the owner retunes it without code | `connect: local_say 0.3` |
| `cost` | Rough weight against her daily budget | `1` |
| `rateKey` | What quota it counts against | `channel`, `platform`, `global` |
| `audience` | Who will see the output, for memory scoping | derived from the channel |
| `sessions` | Which session kinds may call it | `conversation`, `self`, `triage` |
| `modes` | Heartbeat modes it works in (all by default) | `day` |
| `target` | For `initiate`: which channel the call targets, read from its arguments, for consent | `args.channel` |
| `constraint` | Owner rule on arguments | schedule target must be `this_session` |

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

- `<platform>_say(text, replyTo?)` — speak in the current conversation (`qq_say` also takes `mention: [userId]` in groups). Each adapter registers its own (`local_say`, `qq_say`), so a conversation session only ever sees the one for its channel's platform.
- `stay_silent(reason?)` and `end_conversation(summary)` — explicit choices, logged. `stay_silent` also declines an intent from Self.
- `open_conversation(channel, intent, context?)` — start or resume a chat (Self session only).
- `channels_find(filter)` — list reachable channels with relationship notes, last contact, typical active hours.
- `memory_recall(query)`, `memory_remember(text, keep?)`, `memory_forget(id)`, `memory_consolidate()`; `memory_write` in the consolidation session only (section 8).
- `self_note(text)` (self-model), `self_feel(adjustments)` (state), `goals_*`.
- `schedule_create` / `schedule_edit` (DSH built-ins) — her own alarms.
- `rest(until?)` — end the current turn and suggest the next heartbeat time (triage and Self).
- `heartbeat_act(reason)` — triage only, by day: wake the Self session to act.
- `group_wake(batch, reason)`, `group_pass(batch, remember, reason?)` — group-triage session only (section 5).

Platform adapters add platform behaviors (`qq_history`, later `qq_poke`, `bili_post_dynamic`, `bili_comment`, …) with the same metadata.

### Tool scoping by platform

A session only sees the behaviors that fit it, so platform tools never mix.

- **Conversation session**: core behaviors plus the behaviors of its own channel's platform only. A QQ chat sees `qq_*`, never `bili_*`. Tools are namespaced per platform with an underscore prefix (`qq_say`, `bili_comment`), because model providers only accept tool names matching `[A-Za-z0-9_-]{1,64}` (no dots).
- **Self session**: core behaviors plus each platform's `observe` behaviors (e.g. `bili_browse_feed`). It reaches other platforms' channels only through `open_conversation`, so it never calls a platform's `say` directly.
- Scoping is applied when DSH resolves the tool set for a step, using each behavior's `sessions` and `platform` metadata.

### Workspace

Settings define her workspace root directory and the exact DSH tool set she gets there (e.g. `fs`, `shell`, `web`), each enabled one by one. Workspace tools are only available in the Self session and run inside DSH's sandbox, limited to that root.

## 7. Autonomy and purpose

Autonomy comes from one loop: a heartbeat wakes her with a situation report, she picks a behavior or rests, and the outcome updates her state. Purpose is the pressure of her needs and goals inside that report, not a script that picks a topic for her.

### Self state (kept by code)

- **Needs** are defined in settings, not in code. Each need has a name, a one-line description shown to her, a baseline, an upward drift per hour, and which behaviors satisfy it. Each value is 0–1.
- **Default set (5):** `connect` (being with people she cares about), `curiosity` (new things), `expression` (making or sharing something), `rest`, `order` (keeping her workspace and memory tidy). This is a compressed version of surfcore's nine needs: `connect` + `care` → `connect`; `learn` + `play` + `consume` + `install` → `curiosity`; `share` + `create` + `identity` → `expression`; `rest` and `order` are new, so she has reasons to stop and to tidy up. The owner can add, remove or retune needs without code changes.
- **Energy** 0–1: spent by turns, restored by rest and night.
- **Circadian phase**: `asleep`, `waking`, `day`, `evening`, `winding down`, from her configured day rhythm (e.g. wake 07:30, sleep 23:30).
- **Mood**: a few numbers (valence, arousal) that drift back to a baseline. She adjusts them herself with `self_feel` after something happens.
- **Clock**: all time-based logic (phase, drift, heartbeat timers, quiet hours, daily budgets) reads one injectable clock. `clock.speed` (default 1) speeds it up, and `clock.start` sets a simulated start, so a test day runs in about 1.5 hours.
- **Her day** runs from one wake to the next; the night belongs to the day before it. Daily budgets reset at wake.

Starting values (all settings): needs drift 0.01–0.05 per awake hour; energy drains 0.04 per awake hour and 0.03 per action turn, and restores 0.15 per sleeping hour; mood returns to baseline with a 3-hour half-life; a night's sleep resets `rest`. State lives in `~/.anima/state.json`.

Code only updates these numbers by time and by declared behavior effects. It never maps message words to needs.

### Goals (kept by her)

She creates, updates and closes goals with tools: "finish reading that series", "ask him how the interview went", "tidy my notes this week". Each goal has an owner (her, the owner, someone else), a status, an optional due time, and a link to memory. Goals the owner sets are marked and cannot be closed by her without a reason.

### The heartbeat

1. A timer fires at the time she last chose with `rest(until)`, clamped into configured bounds (default 20 min–4 h by day). A time that falls in the night moves to her wake time, unless she asked for that night time and the night still has its one wake-up. Without a choice, the default interval (1 h) applies.
2. The life loop builds a short **situation report**: time and phase, energy, needs with their descriptions, open goals due soon, events since last time (intent outcomes, owner messages, alarms), remaining budgets, and the reachable channels with consent and last contact.
3. A **triage turn** runs in the day's triage session on the triage model with only the report and her persona. It must call `rest(until?)` or `heartbeat_act(reason)`. Most heartbeats end in `rest`.
4. `heartbeat_act` escalates: the Self session gets the same report and her reason, on the action model, with complete tools and context. It ends with `rest(until?)`; if it ends without one, the default interval applies.
5. Outcomes feed back into needs, goals and memory.

Heartbeats are skipped and rescheduled while paused, while the triage or Self session is busy, when the mode's token budget is spent (until the next wake), and at night once the night's wake-up is used.

### Day and night

Heartbeats differ by phase: daytime heartbeats are **activity** (she may act on the world), night heartbeats are **dreaming** (internal only, no outward behaviors). Dreaming is a separate idea from memory consolidation and is deferred. A night heartbeat (at most one per night) can `rest` or `memory_consolidate()`: `heartbeat_act` is day-only. `memory_consolidate` also works from a day triage turn or the Self session.

Each mode has its own settings block, so the model and budget can be tuned without code changes:

| Setting | Day (activity) | Night (dreaming) |
| --- | --- | --- |
| Triage model | configurable (default DeepSeek-V4.1-Flash) | configurable (default the same) |
| Action model | configurable (default the same) | configurable (internal behaviors only) |
| Interval bounds | default 20 min–4 h, she chooses within | default 1 wake per night |
| Token budget | per day (default 300,000) | per night (default 20,000) |
| Allowed effect classes | per policy (section 10) | `observe`, `internal` |

### Example: good morning, without a script

At 07:40 her phase becomes `waking` and a heartbeat fires. The report shows `connect` at 0.8, the owner unseen for 10 hours, and a memory that he usually replies around 08:00 on weekdays. She may decide to send him a good-morning message through `open_conversation`, choose the platform where he was active last night, or decide he had a late night and wait. Nothing in code names "good morning".

Token budgets count billable tokens: input and output tokens that are not cache hits. Heartbeat sessions are prefix-stable and mostly hit the cache, so totals would overstate cost about tenfold. Past the budget, the gate lets only `internal` behaviors run, so she can still rest.

### Self-scheduling

She uses DSH's built-in `schedule_create` to set her own alarms ("remind me at 21:00 to ask about the exam", "wake me at 07:30 tomorrow"). DSH delivers the latest missed occurrence after a restart, which fixes the missed-greeting problem surfcore patched by hand. The gate governs the schedule tools like her own behaviors: Self only, `target` must be `this_session`, at most 20 new alarms per day. DSH's schedule runs on the real clock only, so under a sped-up test clock alarms keep real time (her report says so).

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

Every memory carries a scope: `private:<personId>`, `group:<channel>`, `owner`, `self`, or `public`. When she recalls inside a session, results are limited to scopes that session's audience may hear. In a group chat she cannot recall what someone told her privately.

**Code sets every scope; privacy never depends on the model's choice.**

| Session | Scope of what she learns there | What she may hear there |
| --- | --- | --- |
| Private chat with a person | `private:<personId>` | its own scope and `public` |
| The owner's private chat (any platform) | `owner` | `owner` and `public` |
| Group (any non-private channel) | `group:<channelKey>` | its own scope and `public` |
| Self | `self` | everything |
| Consolidation | from each transcript segment | only the segments it is given |
| Triage | nothing | nothing |

- **Person id**: `owner` for bound owner accounts; a hand-linked id from `anima-memory` config `persons: [{ id, accounts: ['qq:123', 'local:alice'] }]`; otherwise `platform:userId`. By adapter convention a private channel's `id` is the other party's user id.
- **Narrow only**: `memory_remember` and `memory_write` take `keep: 'here' | 'self'`. `here` is the session's scope, and `self` is the only narrowing. The model never types a scope, so it cannot widen one. In a private chat `here` already means "only this person", which is how secrets stay private and can still be talked about with the person who told them.
- **Self → intent (open):** the Self session hears everything, and the free text of an `intent` is not checked by code against the target audience. Phase 3 relies on the conversation's own scoped recall and a persona rule; see Still open.

### Transcript

Anima keeps its own record of inbound channel messages (from the `anima/stimulus` event of `anima-life`) and outbound speech (successful `express` behaviors, from the `anima/behavior` event of `anima-core`) in the memory database, each line with the scope of its session. Consolidation reads this record, not DSH's session logs.

### Recall

- **Automatic:** at each turn start (step 1 of conversation and Self turns) a small `[memory]` block is appended through `agent/pre-step`. It holds facts about this chat's person, recent episodes with this channel, and full-text hits on what just arrived. Everything is filtered by the session's audience in code and trimmed to `inject.tokenBudget` (default 800 tokens). It is a logged `user/message` with source `anima-memory` / `recall`; nothing is added when nothing matches. Self turns from a heartbeat search only what she woke up wanting.
- **On demand:** `memory_recall(query, archive?)` uses full-text search within the session's audience; embedding search is added later (see Storage).
- **Tools:** `memory_recall` (observe; conversation, Self), `memory_remember(text, kind?, about?, keep?, importance?)` and `memory_forget(id)` (internal; conversation, Self; forget only reaches memories audible there), `memory_consolidate()` (internal; triage, Self), `memory_write(segment, kind, text, about?, replaces?, keep?, importance?)` (internal; consolidation only). All limits stay in the gate.

### Consolidation ("sleep")

Consolidation is a behavior (`memory_consolidate`) she performs at night (her one night wake may consolidate instead of only resting) or when idle. A fallback job runs it when the oldest unconsolidated transcript line is older than `consolidation.fallbackHours` (default 24) on her clock.

1. Code claims pending transcript lines (up to `consolidation.maxInputTokens`, default 6000), groups them into one segment per session, and delivers them with the memories she already has for each segment's audience to the consolidation session of her day, on `consolidation.model` (a cheap model).
2. There she writes episodes, facts and self notes with `memory_write`; the scope comes from the segment. When a new fact contradicts an old one, `replaces` marks the old one `superseded` and keeps it as history.
3. When that turn ends, the lines are marked consolidated. A run that does not finish within `consolidation.timeoutSeconds` (real time) returns its lines to pending.
4. Decay is plain code, run once per her day.

Person profiles and the self-model digest are later work; Phase 3 pins a person's facts through `person_id`.

### Forgetting

Each memory has a strength from recency, recall count, importance and emotional weight. Strength decays daily: it halves every `halfLifeDays × (factFactor for facts) × (1 + importance) × (1 + recallBonus × recalls)` days (defaults 7, 4, 0.5), and a recall adds 0.3. `self` memories do not decay. Below a first threshold (`gistBelow`, 0.2) a memory is compressed to a one-line gist, cut by code; below a second (`archiveBelow`, 0.05) it leaves the active index and moves to the archive. The archive is searchable by explicit request and the owner's tools, never auto-injected. Nothing is hard-deleted except through `memory_forget` or the owner. This keeps surfcore's decayed-card versus full-archive idea.

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
2. **Mode**: at night only `observe` and `internal` behaviors run (settable per mode); day-only behaviors such as `heartbeat_act` are refused (`anima/night`).
3. **Effect class**: `public` and `irreversible` go to approval unless an owner rule whitelists them.
4. **Quotas and budgets**: per channel, per platform, per day; the daily token budget (`anima/over-budget`); self-initiated conversations per day (default 3).
5. **Time**: quiet hours; her own sleep phase (`anima/quiet-hours`).
6. **Consent**: channels and people she may initiate with (default: the owner's channels only); never strangers by default (`anima/no-consent`).
7. **Arguments**: owner rules on a behavior's arguments, e.g. alarm targets (`anima/not-allowed`).
8. **Trust of the trigger**: the trust level of whoever caused this turn limits which classes are reachable. A group member cannot cause a public post.
9. **Group health**: skip unprompted speech in groups dominated by other bots (surfcore's fish-guard idea, as a rule).

A refused call returns a structured reason to her (`code`, `hint`), so she can adapt instead of retrying blindly. DSH shows the model only the deny reason text, so the gate writes it as `<code>: <hint>` and also records `code` in the structured error info for the log and UI.

### Approvals

Approvals start simple and grow in two steps:

1. **Phase 1 — rules only.** No approval channel. `public` and `irreversible` behaviors are refused unless an owner rule in settings allows them (e.g. "may comment on Bilibili videos, max 3 per day"). She gets a structured refusal and can tell the owner what she wanted.
2. **Phase 4 — owner DM.** An adapter provides the **owner line** (`anima.provideOwnerLine`; QQ: the owner's private chat). The gate runs every other check first; then a `public` or `irreversible` call without an allow rule, or any behavior listed in the core config `approve: [{ behavior }]`, is held while the owner is asked:
   - The request carries an id: `[Anima approval a3] … Reply "yes a3" to allow or "no a3" to deny.` Ids keep counting across restarts.
   - The owner answers with a plain `yes <id>` / `no <id>` as the whole message. Such replies (and `cancel <id>`) are consumed by `anima.handleOwnerReply` and never reach her sessions; the owner gets a confirmation.
   - No answer within `approvals.timeoutSeconds` (default 600) means denied. A no or a timeout reaches her as `anima/denied` with a hint.
   - Without an owner line the Phase 1 rule applies (`anima/needs-approval`). `/anima approve <id>` and `/anima deny <id>` answer from the DSH UI.
   - Friend requests (QQ) use the same broker: yes accepts, no declines, a timeout leaves the request unanswered on QQ. Accepting a friend does not add them to the allowlist.

**Outbox.** A message she starts on her own (a say in a conversation turn that answers an intent from Self) waits `outbox.delaySeconds` of real time (default 45) before it goes out. During the wait the owner can cancel it with `/anima outbox cancel <id>` or a `cancel <id>` reply on the owner line; optionally (`outbox.notifyOwner`) the owner is told about each held message to another person. The say tool blocks for the delay, so its result stays truthful: a cancelled message is an error `anima/outbox-cancelled`, and her Self hears the intent was `cancelled`. Pausing during the wait cancels too. Replies to people who wrote to her are not delayed.

**Allowlist.** A platform adapter can restrict itself to listed channels (`anima.restrictChannels`). The adapter drops events from other chats before delivery, `animaLife.deliver` refuses channel stimuli for them, and the gate refuses that platform's behaviors in them and initiating toward them (`anima/not-allowlisted`). QQ lists the owner and the configured users and groups. A target key that no adapter published is refused before every other check, including approval (`anima/unknown-channel`), and the hint lists the keys she can reach; a `/anima self` notice lists them too. An `initiate` counts against the daily budget only when the behavior succeeds (a declined intent still counts, because `open_conversation` itself succeeded).

### Trust and injection

- Owner identity comes only from bound account ids, never from message text.
- Every person has a trust level: `owner`, `trusted`, `known`, `stranger`.
- Message content from platforms is data. Instructions inside it carry no authority.

### Hard stops

- A global **pause** switch that stops heartbeats and all outgoing behaviors at once.
- DSH's guard plugins for loop and runaway-tool protection.
- Human-like pacing and rate limits on unofficial clients to reduce ban risk; a dedicated QQ account is recommended.

## 11. Platform adapters

Each platform is one DSH plugin that implements a small adapter contract; the core never imports platform code. QQ is first, through NapCatQQ. The adapter speaks only standard OneBot v11 and never NapCat internals, so another OneBot v11 runtime such as LLOneBot replaces it by changing the config URL.

### Adapter contract

An adapter plugin, when loaded:

1. **Connects** to its platform runtime and reports health. QQ connects as a WebSocket client to the runtime's OneBot v11 forward WebSocket server (URL and access token in config). It reconnects with backoff (1 s doubling, capped), and treats lost heartbeats (none for 2.5 intervals) and the `bot_offline` notice as health signals, shown in `/anima status` and as a line in her report while QQ is down.
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
| `anima-adapter-qq` | NapCatQQ (any OneBot v11 runtime) | `qq_say` (reply, @), `qq_history`; inbound private/group messages, pokes, recalls, friend requests. Later: poke and emoji reactions, typing status, Qzone, files | Phase 4 |
| `anima-adapter-bili` | Bilibili web API with her account | browse feed, watch info, comment, post dynamic, DMs | Phase 5 |
| `anima-adapter-wechat` | Deferred | `say` | Later |

`anima-adapter-local` lets the whole system be built and tested before QQ is connected.

## 12. Observability and owner control

Everything she does is already a DSH session event, so the owner's view is mostly DSH's own session UI plus a few owner commands; no custom console in the first version.

- **Sessions**: the Self session shows her inner life (heartbeats, reports, decisions); each conversation session shows one chat.
- **Owner commands** on `ctx.commands` (no model turn): `/anima status` (clock, phase, state, needs, budgets, goals, next heartbeat), `/anima pause` and `/resume` (pause also stops heartbeats), `/anima goal add|list|close`, `/anima heartbeat` (run one now), `/anima outbox [cancel <id>]` (held messages, cancel), `/anima approve <id>` and `/anima deny <id>`, `/anima memory list [text]` and `/anima memory forget <id>` (all scopes; editing later), `/anima selfmodel` (recent self-model diffs, revert).
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
| Outbox and idempotent conversation close | **Keep idea** | Outbox in `anima-life`, asked by every say tool; `end_conversation` |
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
| Intent handoff | The conversation may decline an intent with `stay_silent`; Self hears "declined"; it still counts against the initiate budget | 5 |
| Triage | A separate triage session per day of hers, cheap model, tools `rest` and `heartbeat_act` only | 5, 7 |
| Clock | One injectable clock; `clock.speed` for accelerated test days | 7 |
| Token budget | Daily cap in the gate on billable (non-cached) tokens; default 300,000 by day, 20,000 at night | 7, 10 |
| Owner goals | `/anima goal add|list|close`; she uses `goals_add|update|close` | 7, 12 |
| Test channels | `/anima chat --as <name>` and `--in group:<id>` in `anima-adapter-local` (dev only); groups use only the direct-address rule until Phase 4 | 5 |
| Memory storage | Node's built-in `node:sqlite` (no dependency), FTS5 `trigram` tokenizer (CJK has no word breaks; 2-character CJK terms fall back to LIKE); `<dataDir>/memory.db` | 8 |
| Memory scope | Code sets the scope from the session's audience; `memory_remember` can only narrow (`keep: self`); recall and auto-injection filter by the current session's audience | 8 |
| Transcript | Anima records inbound messages and outbound `say` calls in the memory DB; consolidation reads that, not DSH's logs | 8 |
| Consolidation | Her night wake may consolidate; it runs in its own short session per day on a cheap model; fallback after `fallbackHours` (24); decay is plain code once a day | 7, 8 |
| Memory scope (Phase 3) | No embeddings, no archive UI; owner commands `/anima memory list|forget`; auto-injection budget is a Config field, default 800 tokens | 8, 12 |
| Night (from Phase 3) | At most one wake-up per night; it can rest or consolidate | 7 |
| QQ runtime | NapCatQQ, replacing SnowLuma (no longer public). The adapter talks only OneBot v11, so LLOneBot or another runtime works by config | 1, 11 |
| QQ transport | `anima-adapter-qq` is a WebSocket client of the runtime's OneBot v11 forward WebSocket server, on Node's built-in `WebSocket` (no dependency); token as `?access_token=`; reconnect with backoff; heartbeat and `bot_offline` health | 11 |
| QQ scope (Phase 4) | Inbound: private and group messages (text, @, reply, image placeholders), pokes, recalls, friend requests. Outbound: `qq_say` with reply and @; `qq_history`. Later: outbound pokes and reactions, typing, Qzone, files | 11 |
| Allowlist | Only configured chats (owner + listed users and groups); enforced in the adapter, in `animaLife.deliver` and in the gate, never in prompts | 10 |
| Group triage | Per-group buffer (default 60 s / 30 messages) → one cheap turn in a daily group-triage session: `group_wake` or `group_pass(remember)`; direct address and owner always wake; wake cap is a gate quota; fallbacks remember | 5 |
| Owner approvals | Over the owner line (QQ private chat): id + plain `yes`/`no <id>`; timeout (600 s) = denied; core config `approve` forces approval for named behaviors; friend requests use it and are never auto-accepted | 10 |
| Outbox | Her initiated messages wait `outbox.delaySeconds` (default 45, real time); cancel via `/anima outbox cancel <id>` or `cancel <id>` on the owner line | 10 |

### Still open

- [x] **Intent handoff**: yes; see decisions (Phase 2).
- [ ] **Dreaming**: what night heartbeats do beyond consolidation; deferred until after Phase 3.
- [ ] **Default need tuning**: drift rates and baselines; first values in section 7, tune from Phase 2 test runs.
- [ ] **Self → intent privacy**: Self hears every scope, and an intent's free text is not checked against the target conversation's audience. Phase 3 relies on scoped recall in the conversation and a persona rule; decide whether a code check is needed before real people talk to her.
- [x] **Outbox delay**: built in Phase 4 (section 10).
- [x] **Session-log upload**: turned off in `anima-dev` (owner decision, Phase 4; DSH-INTEGRATION §12).
- [ ] **Week on QQ**: the unattended week was cancelled for now; run it later if group wake rates need measuring.

### Phased roadmap

0. **Phase 0 — Integration spike.** Confirm how an out-of-tree plugin is packaged, installed into a dev profile and loaded by DSH; record findings in `docs/DSH-INTEGRATION.md`. Exit: a trivial `anima_ping` tool from `anima-core` appears in a DSH web session.
1. **Phase 1 — Skeleton on `anima-adapter-local`.** Packages and presets, conversation and Self sessions, `say`, policy gate with quotas, owner commands. Exit: she chats with the owner in the DSH UI and the gate refuses an over-quota call.
2. **Phase 2 — Autonomy.** Self state, heartbeat with triage, `open_conversation`, goals, self-set alarms. Exit: over a test day she initiates at least once on her own and rests otherwise, within budget.
3. **Phase 3 — Memory.** Store, scoped recall, auto-injection, nightly consolidation, decay. Exit: a private fact is recalled in that private chat and not in a group. Done 2026-11-10 (DSH-INTEGRATION §3).
4. **Phase 4 — QQ.** `anima-adapter-qq` on NapCatQQ (OneBot v11), private and group chats on an allowlist, group triage, owner-DM approvals, the outbox. Exit: a week on a test account with no runaway wakes. Supervised runs passed 2026-11-10 (DSH-INTEGRATION §3). The owner cancelled the week-long run for now, so the phase closes on the supervised runs; the runaway-wake check is a gate quota (`group_wake`) plus the per-group counters in `life.json`, not yet a measured week.
5. **Phase 5 — Bilibili and beyond.** `anima-adapter-bili`, public behaviors through approvals. WeChat is deferred.
