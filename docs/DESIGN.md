# Anima — Design

Anima is one human-like AI character ("she") living inside DSH. She has a will (what she chooses to do), physiology (what happens to her body whether she wants it or not), and a memory that works like a person's. `docs/CONSTITUTION.md` overrides this document and everything else.

These documents describe the **target design**. The code still implements the first design (`docs/history/`) until the phases in `docs/ROADMAP.md` land.

## The body map

The Anima plugin is the persona itself: everything in it is her will or her physiology. Everything else is outside her.

| | What | Where |
|---|---|---|
| **Will** | Behaviors she calls: speak, look, wait, remember, recall, register how she feels, note something about herself, go to bed, browse, work in her workspace | Inside: `anima-core`, `anima-life`, `anima-memory`, adapters |
| **Physiology** | Her heartbeat (her self-drive), sleep pressure, falling asleep and waking, energy and tiredness, needs drifting, mood fading, typing time, memories that come to mind, consolidation in sleep, forgetting. Its parameters are her genes, not rules | Inside: code acting on her state |
| **Outside** | Safety and management: approvals, allowlist, consent, token budget, pause, owner commands, the Anima page, memory management | `anima-guard`, `anima-page` (their own bundle), DSH |

## One waking of hers

1. **Waking** opens her next waking session, prepared when she fell asleep. It starts with her persona, her self-model, why she woke, what comes to mind, and what waited in her inbox.
2. **Her heartbeat**, her own self-drive, stirs her while she is awake. **Stimuli** from the world (a private message, an @mention, an alarm) arrive in the same session. An idle session starts a turn; a busy one takes them into the running turn.
3. **She acts** only through behaviors. She speaks with `say` on a channel, waits with `wait`, and glances at groups when she wants to.
4. **Memories come to mind** when a stimulus cues them, at the start of each turn.
5. **Falling asleep** ends the waking: when she goes to bed and is sleepy enough, or when sleepiness overwhelms her. The session is archived, and sleep turns what she perceived into long-term memory. While she sleeps, messages wait in her inbox.
6. **The next waking**, whenever it comes (her body, an alarm, the owner), opens a new session. A day can hold several.

## Packages

| Package | Side | Holds |
|---|---|---|
| `anima-core` | Inside | Her state and physiology, the persona prompt, the behavior registry, her clock |
| `anima-life` | Inside | Waking sessions, stimuli, `wait`, the inbox, the heartbeat, sleep and waking |
| `anima-memory` | Inside | Long-term memory, recall cues, consolidation in sleep, decay |
| `anima-adapter-qq`, `-bili` | Inside | Her channels: connection, stimuli, platform behaviors |
| `bundle` | Inside | The Anima plugin: installs the persona packages into a DSH profile |
| `anima-guard` | Outside | The safety gate on `tools/pre-execute`, approvals, allowlist, consent, budgets, pause, outbox hold, owner commands, memory management |
| `anima-page` | Outside | The Anima page in DSH's web UI, over `anima-guard`'s owner surface |
| `guard-bundle` | Outside | Installs `anima-guard` and `anima-page`, separately from her |

**Her sessions only.** Anima acts only in the DSH sessions it creates for her. A DSH session someone opens in the web UI works as plain DSH: no behavior, prompt, recall or stimulus of hers. Talking with her from DSH's web UI (a desktop-pet or sidebar chat) and bringing her persona and memory into native sessions are possible later, unscheduled.

**Dependencies point one way.** Persona packages never import `anima-guard` or `anima-page`. The outside reads and acts on the persona through the services the persona exposes and through DSH hooks. Core packages never import an adapter. Uninstalling the guard bundle leaves her running, unrestricted.

## Principles

1. **The model decides.** Code keeps state, runs physiology and moves messages. It never chooses what she says or when.
2. **Everything she does is a behavior.** A DSH tool plus metadata. There is no hidden reply path.
3. **Everything that reaches her is a stimulus.** A message, an alarm, a platform event. Her heartbeat is not something that reaches her: it is her own self-drive, physiology that nobody controls, neither her will nor the outside (`design/body.md`).
4. **Speech is explicit.** She speaks only by calling `say`. Her plain text is her thinking and reaches nobody.
5. **Code keeps numbers, she keeps meaning.** No keyword lists, no fixed-time scripts. What an event means to her, and how she feels about it, is her appraisal.
6. **Genes are not rules.** Physiology's parameters are her body. Inside the persona there is no clock rule, count or quota; whatever the owner wants as a rule lives outside.
7. **Facts, never rules or nudges, in her prompt.** It states what is true of her body and places; the outside states what it may stop under its own heading.
8. **Model-visible means logged.** Everything put into her context is a DSH session event.
9. **Plugin-shaped.** Every registration is a Cordis effect, so unloading reverts it.
10. **Simplest first.** Non-core features get the simplest working version.

## Documents

| File | Covers |
|---|---|
| `CONSTITUTION.md` | The rule above everything |
| `design/life.md` | Waking sessions, stimuli, `wait`, groups, the inbox, sleep and waking |
| `design/memory.md` | Perception, recall, consolidation, forgetting, storage |
| `design/body.md` | Behaviors and physiology |
| `design/persona.md` | Persona card, genes, self-model, prompt structure |
| `design/channels.md` | Adapter contract, QQ, Bilibili, the demo platform |
| `design/outside.md` | `anima-guard`, owner control, the Anima page |
| `dsh.md` | Pinned DSH version, APIs relied on, traps |
| `ROADMAP.md` | Phases ahead |
| `history/` | The first design and its phase records, frozen |

Files in `design/` state only what is true now. Why something was decided gets one line where it matters; everything else belongs in git or `history/`.
