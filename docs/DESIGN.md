# Anima — Top-Level Design

As of 2026-11-11 (Phase 6) · Owner: Sam · Living copy: https://claude.ai/artifact/AM2TtSPWVoCuVwRQmUHPee

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

- Desktop pet, voice/TTS, stickers, slang learning, multi-character switching, a standalone web console. The owner's view is a page inside DSH's own web UI (section 12), not a separate app.
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

Ten concepts carry the whole design; every later section is built from them.

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
| **Viewing session** | One short session per close view of a video: frames in on a vision model, one text note out (section 11). | Life loop (asked by an adapter) |

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
| `anima-page` | Owner page (Host routes + browser bundle) | The Anima page in DSH's web UI (section 12); reads and writes only through `anima-core`'s owner surface |
| preset `conversation` | Agent preset | Tool set and prompt for chat sessions |
| preset `self` | Agent preset | Tool set and prompt for the Self session |
| bundle `anima` | Bundle | Installs all of the above into a DSH profile |

Dependencies point one way: adapters depend on `anima-core` and `anima-life` interfaces; the core packages never import an adapter. `anima-page` depends on `anima-core` only.

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
| `view` | An adapter's close view (`animaLife.view`) | A new viewing session | Yes, on the viewing model |
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
| `sessions` | Which session kinds may call it | `conversation`, `self`, `triage`, `viewing` |
| `modes` | Heartbeat modes it works in (all by default) | `day` |
| `target` | For `initiate`: which channel the call targets, read from its arguments, for consent | `args.channel` |
| `constraint` | Owner rule on arguments | schedule target must be `this_session` |
| `facts` | Numeric facts about a call, found before it runs and checked against the owner's `limits` (section 10) | a video's `durationSeconds`, `frames` |

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
- `viewing_note(note)` — viewing session only: her note on a close view; it ends the viewing (section 11).

Platform adapters add platform behaviors (`qq_history`, `bili_watch`, later `qq_poke`, `bili_comment`, …) with the same metadata.

### Tool scoping by platform

A session only sees the behaviors that fit it, so platform tools never mix.

- **Conversation session**: core behaviors plus the behaviors of its own channel's platform only. A QQ chat sees `qq_*`, never `bili_*`. Tools are namespaced per platform with an underscore prefix (`qq_say`, `bili_comment`), because model providers only accept tool names matching `[A-Za-z0-9_-]{1,64}` (no dots).
- **Self session**: core behaviors plus each platform's `observe` behaviors (e.g. `bili_feed`, `bili_watch`). It reaches other platforms' channels only through `open_conversation`, so it never calls a platform's `say` directly.
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
| Self | Her self-model (section 9): lasting tastes, habits and opinions, kept with `self_note`. Passing thoughts about herself stay `self`-kind memories | Slow-changing | The self-model digest always; `self` memories when recalled |

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
| Viewing | nothing (its note comes back to the adapter) | nothing |

- **Person id**: `owner` for bound owner accounts; a hand-linked id from `anima-memory` config `persons: [{ id, accounts: ['qq:123', 'local:alice'] }]`; otherwise `platform:userId`. By adapter convention a private channel's `id` is the other party's user id.
- **Narrow only**: `memory_remember` and `memory_write` take `keep: 'here' | 'self'`. `here` is the session's scope, and `self` is the only narrowing. The model never types a scope, so it cannot widen one. In a private chat `here` already means "only this person", which is how secrets stay private and can still be talked about with the person who told them.
- **Observations**: what she watches or reads on her own reaches memory through `animaMemory.observe`, with scope `public` (public content, so any chat may hear it) or `self`. The adapter picks one of those two; nothing wider can be named. A plain observation is a transcript line that consolidation sorts (its own segment, "things you watched or read on your own"); text the model already wrote, such as a viewing note, is stored at once as an episode.
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
2. There she writes episodes, facts and passing thoughts about herself with `memory_write`; the scope comes from the segment. What she learned that is lasting about her own tastes, habits or opinions goes to her self-model with `self_note` (Phase 6), which this session offers with the full self-model and its note ids. When a new fact contradicts an old one, `replaces` marks the old one `superseded` and keeps it as history.
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

- The constitution is read-only to her and always wins over the self-model. It lives in `<dataDir>/constitution.md`; the owner edits it there or on the Anima page. A save keeps the previous text as `constitution.md.bak`, and running sessions get the new text on their next request.
- **Self-model (Phase 6).** Short notes in four sections (`tastes`, `habits`, `opinions`, `other`), kept in `<dataDir>/self-model.json`. She edits them with `self_note(section, text?, replaces?, reason)`: text alone adds a note, `replaces` with text changes one, `replaces` alone removes one. Limits: `selfModel.maxEntries` (40) and `maxEntryChars` (200).
- **Every change is a diff** in `<dataDir>/self-model-log.jsonl`: id `d<n>`, time on her clock and real time, who (`her` or `owner`), op, note id, text before and after, reason, session. The owner reverts a diff with `/anima selfmodel revert <dId>` or on the page; a revert is itself a diff, and is refused when the note changed again since.
- **Where notes come from:** Self, conversations and the consolidation session may call `self_note`. In the Phase 6 demo she kept her self-knowledge as `self`-kind memories during consolidation (as Phase 3 told her to), never in the self-model, so consolidation now offers `self_note` for lasting traits and keeps `memory_write kind: self` for passing thoughts (owner decision, 2026-11-11).
- **In her report:** every situation report carries one factual line, "Your self-model: N notes, last changed … self_note keeps what you learn about your own tastes, habits and opinions; only a few changes a day." It was added in the Phase 6 demo: with only the tool and the digest, she described a new habit in chat and never recorded it in about half a simulated day. Like the Bilibili line, it states what exists and never suggests what to note.
- **The cap is a gate quota:** `self_note` 3 per 24 h by default (`quotas`), so drift is gradual and visible.
- **Digest in prompts:** the persona row adds the self-model as a DSH prompt context (`anima-self-model`), a logged snapshot re-sent only when its text changes. Self gets every note with its id; conversation sessions get a short digest (newest first, `selfModel.digestChars`, 600); other session kinds get none. It is framed under the constitution: "Your constitution above always wins over this."
- The prompt differs by session kind: conversation sessions get the constitution and the self-model digest (current mood in one line and person profiles are later work); the Self session also gets needs, goals and budgets through its situation reports.

## 10. Policy, permissions and safety

One listener on DSH's `tools/pre-execute` waterfall checks every behavior call against owner policy before it runs. Tools contain no limit logic of their own.

### What the gate checks

1. **Session kind**: the behavior is allowed in this session (e.g. `open_conversation` only from Self).
2. **Mode**: at night only `observe` and `internal` behaviors run (settable per mode); day-only behaviors such as `heartbeat_act` are refused (`anima/night`).
3. **Effect class**: `public` and `irreversible` go to approval unless an owner rule whitelists them.
4. **Quotas and budgets**: per channel, per platform (a rule can match all of one platform's behaviors, e.g. `bili_*` 60 per hour), per day; quota counters persist in `state.json`, so a daily limit survives a restart; the daily token budget (`anima/over-budget`); self-initiated conversations per day (default 3).
5. **Time**: quiet hours; her own sleep phase (`anima/quiet-hours`).
6. **Consent**: channels and people she may initiate with (default: the owner's channels only); never strangers by default (`anima/no-consent`).
7. **Arguments**: owner rules on a behavior's arguments, e.g. alarm targets (`anima/not-allowed`). **Fact limits**: owner `limits: [{ behavior, fact, max }]` on numeric facts a behavior reports before it runs (`BehaviorMeta.facts`), e.g. a close view's video length and frame count (`anima/over-limit`). A failure to find the facts refuses the call.
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
| `anima-adapter-bili` | Bilibili web API with her account | Read-only, Self only: skim (`bili_feed`, `bili_popular`, `bili_search`), watch as text (`bili_watch`, `bili_comments`), close view (`bili_view_closely`). Later: comments, DMs, dynamics, likes (public behaviors through approvals) | Phase 5 |
| `anima-adapter-wechat` | Deferred | `say` | Later |

`anima-adapter-local` lets the whole system be built and tested before QQ is connected.

### Bilibili (Phase 5): tiered viewing

Bilibili is a place she watches, not one where she talks. `anima-adapter-bili` registers only `observe` behaviors for her Self session (by day), in three tiers. She picks the tier herself; no code scores whether a video is worth watching.

| Tier | Behaviors | Returns |
| --- | --- | --- |
| 0 skim | `bili_feed` (follows; needs login), `bili_popular`, `bili_search(query)` | One compact line per video: bvid, title, uploader, length, counts, a short description |
| 1 watch | `bili_watch(bvid)`, `bili_comments(bvid, page?)` | One text digest: metadata, subtitles (CC, else AI), a danmaku sample spread over the video, top comments; each section capped in config |
| 2 close view | `bili_view_closely(bvid, focus?)` | Her viewing note |

- **Close view.**
  1. The adapter downloads a low-quality stream (360p) into a capped cache under the data directory.
  2. `ffmpeg` extracts frames: the first frame, scene changes, and a fallback every N seconds. K of them, spread over time, are kept, each paired with the subtitle line at its moment.
  3. The frames go as image blocks to a short **viewing session** (preset `anima-viewing`, a vision-capable model) through `animaLife.view`.
  4. She writes a note with `viewing_note`, and only that note returns to Self. Self history stays text-only, the same pattern as consolidation.
  5. The files are deleted afterwards. Audio is not used (DSH input is text and images).
- **ffmpeg** is a required system binary while close views are enabled. Load fails with `anima/ffmpeg-missing` and an install hint.
- **Limits, all in the gate:**
  - `bili_*` 60 calls per hour (platform quota)
  - `bili_view_closely` 3 per day
  - `limits` of 12 frames and 1200 s of video, checked through `facts` before anything is downloaded
  - the token budget
  
  The adapter only paces its HTTP requests (one at a time, a minimum gap) and backs off on Bilibili's risk control (`-352`, doubling from 60 s). The back-off shows in `/anima status` and in her report.
- **Account.** A dedicated account, logged in by the owner with `/anima bili login` (QR). The cookie lives in `<dataDir>/bili/cookie.json` (0600). WBI signing uses `node:crypto`; there are no dependencies.
- **Memory and needs.** A watch is a `public` observation; a close view's note is stored as a `public` episode, so she can bring a video up in any chat. The default `curiosity` need is satisfied by `bili_view_closely` 0.25, `bili_watch` 0.15 and other `bili_*` 0.05.
- **Later:** comments, DMs, dynamics and likes as `public` behaviors through approvals; Bilibili conversation channels.

## 12. Observability and owner control

Everything she does is already a DSH session event, so the owner's view is DSH's own session UI, a few owner commands, and (from Phase 6) an Anima page in DSH's web UI.

- **Sessions**: the Self session shows her inner life (heartbeats, reports, decisions); each conversation session shows one chat.
- **Owner commands** on `ctx.commands` (no model turn): `/anima status` (clock, phase, state, needs, budgets, goals, next heartbeat), `/anima pause` and `/resume` (pause also stops heartbeats), `/anima goal add|list|close`, `/anima heartbeat` (run one now), `/anima outbox [cancel <id>]` (held messages, cancel), `/anima approve <id>` and `/anima deny <id>`, `/anima memory list [text]` and `/anima memory forget <id>` (all scopes; editing later), `/anima selfmodel` (recent self-model diffs, revert).
- **Audit trail (activity log)**: `<dataDir>/activity/<her day>.jsonl` records every gate decision on a behavior (allowed, refused with code and hint, approved or denied by the owner, with session kind), every delivery that wakes a turn (stimulus type, session kind, channel), and every owner action (name, source `command` or `page`, arguments, outcome). Recording never decides anything.
- **Cost**: per-session token use from DSH telemetry; the global budget in the gate reads the same numbers.

### Anima page (Phase 6)

An **Anima** entry in the DSH web UI sidebar opens a page with tabs, the same shape as other DSH plugin pages. It is built on the same service methods as the owner commands, so the page and the commands never disagree, and every change it makes goes through the same code paths and is logged.

- **Status**: clock, phase, energy, needs, mood, budgets, next heartbeat; adapter health (QQ connection, Bilibili login and risk control).
- **Persona**: edit the constitution; review her self-model diffs and revert them.
- **Memory**: search and browse by scope, including the archive (section 8); forget an entry.
- **Goals, approvals and outbox**: list, approve or deny, cancel held messages.
- **Activity**: gate decisions (allowed and refused, with codes and reasons), wakes and token use per day. It doubles as the monitoring view for the formal test.
- **Platforms**: QQ connection and allowlist, Bilibili login with the QR code shown on the page.
- **Settings**: Anima's Config fields, edited on the page.

**How it is built (Phase 6, DSH-INTEGRATION §8e).** `anima-page` is one package with two halves:
- **Host half:** two authenticated owner-only routes on DSH's `/api` channel, `GET /api/anima/view?name=…` and `POST /api/anima/action`.
- **Browser half:** a bundle that registers the sidebar entry and the page. DSH builds it with esbuild into its client-module format; React comes from DSH.

**Owner surface.** Everything the page and the commands read or change is a named **owner view** or **owner action** on the `anima` service:
- Each plugin registers its own: core (status, goals, approvals, self-model, constitution, activity, pause and resume), life (outbox, heartbeat, its part of status), memory (browse and forget), and adapters (`providePlatform`: health, details, actions such as `bili.login`).
- The `/anima` commands are text renderers over the same actions, and every action is written to the activity log with its source.
- The page polls the views, because DSH has no push channel for plugin routes.

**Settings.** The tab shows each Anima row's effective config and its profile override:
- **Editable rows:** `anima-core`, `anima-life` and `anima-memory`. A save goes through DSH's config editor, which validates the whole config against the row's schema, writes the active profile's `cordis.patch.yml` and restarts that row.
- **Read-only rows:** adapter rows, with secrets hidden.
- A home patch or `--patch` overlay still wins, and the tab says so.

**Approvals in development.** `anima-adapter-local` can provide the owner line (`ownerLine: true`, dev only), so approvals can be answered on the page without QQ.

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
| Memory scope (Phase 3) | No embeddings; owner commands `/anima memory list|forget`; auto-injection budget is a Config field, default 800 tokens. The archive browser comes with the Anima page (Phase 6) | 8, 12 |
| Night (from Phase 3) | At most one wake-up per night; it can rest or consolidate | 7 |
| QQ runtime | NapCatQQ, replacing SnowLuma (no longer public). The adapter talks only OneBot v11, so LLOneBot or another runtime works by config | 1, 11 |
| QQ transport | `anima-adapter-qq` is a WebSocket client of the runtime's OneBot v11 forward WebSocket server, on Node's built-in `WebSocket` (no dependency); token as `?access_token=`; reconnect with backoff; heartbeat and `bot_offline` health | 11 |
| QQ scope (Phase 4) | Inbound: private and group messages (text, @, reply, image placeholders), pokes, recalls, friend requests. Outbound: `qq_say` with reply and @; `qq_history`. Later: outbound pokes and reactions, typing, Qzone, files | 11 |
| Allowlist | Only configured chats (owner + listed users and groups); enforced in the adapter, in `animaLife.deliver` and in the gate, never in prompts | 10 |
| Group triage | Per-group buffer (default 60 s / 30 messages) → one cheap turn in a daily group-triage session: `group_wake` or `group_pass(remember)`; direct address and owner always wake; wake cap is a gate quota; fallbacks remember | 5 |
| Bilibili scope (Phase 5) | Read-only `observe` behaviors in the Self session only, three tiers she chooses; no Bilibili channels; comment, DM, post and like are later work | 6, 11 |
| Close views | 360p download → ffmpeg frames (scene + fallback) → viewing session on a vision model → text note only; files deleted; ffmpeg checked at load | 11 |
| Fact limits | `BehaviorMeta.facts` + core `limits` rules (`anima/over-limit`), e.g. video length and frames; platform-wide quotas (`QuotaRule.platform`); quota counters persist | 10 |
| Observations | Adapters record what she watched through `animaMemory.observe` with scope `public` or `self` only | 8 |
| Owner approvals | Over the owner line (QQ private chat): id + plain `yes`/`no <id>`; timeout (600 s) = denied; core config `approve` forces approval for named behaviors; friend requests use it and are never auto-accepted | 10 |
| Outbox | Her initiated messages wait `outbox.delaySeconds` (default 45, real time); cancel via `/anima outbox cancel <id>` or `cancel <id>` on the owner line | 10 |
| Owner UI | An Anima page inside DSH's web UI (sidebar entry, tabs), built on the owner-command service methods; no standalone console | 12 |
| Roadmap after Phase 5 | Phase 6 self-model and Anima page; Phase 7 QQ refinement; then a formal 7-day test in the development environment | 14 |
| Formal test | Runs on this development machine in `anima-dev`, not in production, so data is easy to collect; it carries the QQ week, need tuning and Bilibili uptake; its test plan and pass criteria are written before it starts | 14 |
| Postponed | More Bilibili behaviors and WeChat (strict platform risk control); embedding search (necessity to be studied); dreaming; production packaging | 8, 11, 14 |
| Self-model (Phase 6) | Notes in four sections edited by `self_note`; every change a diff with time and reason in `self-model-log.jsonl`; owner revert by diff id; cap is a gate quota (3 per 24 h); digest as a logged DSH prompt context, full for Self and short for conversations | 9 |
| Anima page mechanism | One package `anima-page`: Host routes `/api/anima/view` and `/api/anima/action` (Connection fetch routes, owner-authenticated), browser bundle on slots `sidebar.panellist` and `main`, built with esbuild (dev dependency); polling, no push | 12 |
| Owner surface | Named owner views and actions on the `anima` service, registered by each plugin; commands and page call the same ones; each action logged with its source | 12 |
| Activity log | Gate decisions, wakes and owner actions per her day in `<dataDir>/activity/`; the Ledger keeps 14 days | 12 |
| Settings editing | Through DSH's config editor into the active profile patch; core, life and memory rows only; a higher layer still wins | 12 |
| Self-knowledge flow | Lasting tastes, habits and opinions go to the self-model through `self_note`, also from the consolidation session; `self`-kind memories keep passing thoughts about herself (owner decision after the Phase 6 demo) | 8, 9 |
| Constitution editing | Owner saves on the page; previous text kept as `.bak`; persona rows re-register on save, so running sessions get it next request | 9 |

### Still open

- [x] **Intent handoff**: yes; see decisions (Phase 2).
- [ ] **Dreaming**: what night heartbeats do beyond consolidation; postponed until after the formal test, whose night data shows whether more is needed.
- [ ] **Default need tuning**: drift rates and baselines; first values in section 7, tuned from the formal test.
- [ ] **Self → intent privacy**: Self hears every scope, and an intent's free text is not checked against the target conversation's audience. Phase 3 relies on scoped recall in the conversation and a persona rule; decide whether a code check is needed before the formal test, where real people talk to her.
- [x] **Outbox delay**: built in Phase 4 (section 10).
- [x] **Session-log upload**: turned off in `anima-dev` (owner decision, Phase 4; DSH-INTEGRATION §12).
- [ ] **Close-view uptake**: on her own she chose the text tier all day; the close view came after an owner notice. Decide whether the tool description or her report should present the tier more plainly, or whether rare use is right; the formal test measures it.
- [ ] **Week on QQ**: folded into the formal test (Phase 4 exit).
- [ ] **Embedding search**: whether full-text search is enough; study it with the formal test's recall data before building anything.
- [ ] **Production packaging**: today she installs only as a linked checkout (`workspace:*`, unbuilt `lib/` not committed). Not needed for the formal test, which runs in development.

### Phased roadmap

0. **Phase 0 — Integration spike.** Confirm how an out-of-tree plugin is packaged, installed into a dev profile and loaded by DSH; record findings in `docs/DSH-INTEGRATION.md`. Exit: a trivial `anima_ping` tool from `anima-core` appears in a DSH web session.
1. **Phase 1 — Skeleton on `anima-adapter-local`.** Packages and presets, conversation and Self sessions, `say`, policy gate with quotas, owner commands. Exit: she chats with the owner in the DSH UI and the gate refuses an over-quota call.
2. **Phase 2 — Autonomy.** Self state, heartbeat with triage, `open_conversation`, goals, self-set alarms. Exit: over a test day she initiates at least once on her own and rests otherwise, within budget.
3. **Phase 3 — Memory.** Store, scoped recall, auto-injection, nightly consolidation, decay. Exit: a private fact is recalled in that private chat and not in a group. Done 2026-11-10 (DSH-INTEGRATION §3).
4. **Phase 4 — QQ.** `anima-adapter-qq` on NapCatQQ (OneBot v11), private and group chats on an allowlist, group triage, owner-DM approvals, the outbox. Exit: a week on a test account with no runaway wakes. Supervised runs passed 2026-11-10 (DSH-INTEGRATION §3). The owner cancelled the week-long run for now, so the phase closes on the supervised runs; the runaway-wake check is a gate quota (`group_wake`) plus the per-group counters in `life.json`, not yet a measured week.
5. **Phase 5 — Bilibili (read-only).** `anima-adapter-bili`: skim, watch and close-view tiers in the Self session, QR login, risk-control back-off, viewing sessions, observations in memory. Exit: over a test day she browses on her own initiative during heartbeats, watches some videos and views at least one closely, and later brings one up with the owner in a chat, all within budget; evidence from the transcripts. Done 2026-11-10 (DSH-INTEGRATION §3). She browsed, watched and shared on her own; her one close view came after an owner notice said the tier exists.
6. **Phase 6 — Self-model and the Anima page.** `self_note` with a daily cap, every change logged as a diff, a self-model digest in prompts, `/anima selfmodel` review and revert (section 9). The Anima page in DSH's web UI with its tabs, including the memory archive browser (section 12); starts with a spike on how a plugin adds a sidebar page. Exit: she changes her self-model on her own, the owner reviews and reverts one change from the page, and the page shows live status, memory (active and archive), approvals and activity. Done 2026-11-11 (DSH-INTEGRATION §3). Her first note came on her second simulated day, in a chat, after two owner-approved changes: a self-model line in her report and `self_note` in consolidation.
7. **Phase 7 — QQ refinement.** Feature list fixed at the phase's plan step. Candidates: inbound images seen by the vision model instead of placeholders, outbound pokes and emoji reactions, the typing status, sturdier NapCat reconnect and offline handling (a development warning, no alerts). Qzone only through approvals, if at all.
8. **Formal test — 7 days in development.** In `anima-dev` on this machine with QQ, Bilibili and the local channel. Before it starts, a written test plan: setup, what is collected and where, daily checks, and pass criteria (for example: no runaway group wakes, daily tokens within budget, no cross-scope leaks, initiations within limits, NapCat drops recovered, Bilibili without sustained risk control). It covers the Phase 4 week, need tuning and close-view uptake; findings feed the open questions above.
9. **Later.** More Bilibili behaviors (comments, DMs, posts, likes, through approvals) and WeChat, held back by strict platform risk control; embedding search, pending the study above; dreaming; production packaging and deployment.
