# Anima — Design

Anima is one human-like AI character ("she") living inside DSH. She has a will (what she chooses to do), physiology (what happens to her body whether she wants it or not), and a memory that works like a person's. `docs/CONSTITUTION.md` overrides this document and everything else.

These documents describe the **target design**. The code still implements the first design (`docs/history/`) until the phases in `docs/ROADMAP.md` land.

## The body map

| | What | Where |
|---|---|---|
| **Will** | Behaviors she calls: speak, look, wait, remember, recall, note something about herself, sleep, browse, work in her workspace | Inside: `anima-core`, `anima-life`, `anima-memory`, adapters |
| **Physiology** | Clock, day rhythm, sleep pressure, energy and tiredness, needs, mood fading, memories that come to mind, consolidation in sleep, forgetting | Inside: code acting on her state |
| **Outside** | Safety and management: approvals, allowlist, consent, token budget, pause, owner commands, the Anima page, memory management | `anima-guard`, `anima-page`, DSH |

## One day of hers

1. **Waking** opens a new DSH session, her day session. It starts with her persona, her self-model, what she had in mind yesterday, and what waited in her inbox.
2. **Stimuli** (a private message, an @mention, a heartbeat, an alarm) arrive in that one session. An idle session starts a turn; a busy one takes the stimulus into the running turn.
3. **She acts** only through behaviors. She speaks with `say` on a channel, waits with `wait`, and glances at groups when she wants to.
4. **Memories come to mind** when a stimulus cues them, at the start of each turn.
5. **Falling asleep** ends the day. The day session is archived, and sleep turns what she perceived into long-term memory. While she sleeps, messages wait in her inbox.
6. **The next waking** opens a new day session.

## Packages

| Package | Side | Holds |
|---|---|---|
| `anima-core` | Inside | Her state and physiology, the persona prompt, the behavior registry, her clock |
| `anima-life` | Inside | The day session, stimuli, `wait`, the inbox, the heartbeat, sleep and waking |
| `anima-memory` | Inside | Long-term memory, recall cues, consolidation in sleep, decay |
| `anima-adapter-qq`, `-bili`, `-local` | Inside | Her channels: connection, stimuli, platform behaviors |
| `anima-guard` | Outside | The safety gate on `tools/pre-execute`, approvals, allowlist, consent, budgets, pause, outbox hold, owner commands, memory management |
| `anima-page` | Outside | The Anima page in DSH's web UI, over `anima-guard`'s owner surface |
| `bundle` | — | Installs everything into a DSH profile |

**Dependencies point one way.** Persona packages never import `anima-guard` or `anima-page`. The outside reads and acts on the persona through the services the persona exposes and through DSH hooks. Core packages never import an adapter. Unloading `anima-guard` leaves her running, unrestricted.

## Principles

1. **The model decides.** Code keeps state, runs physiology and moves messages. It never chooses what she says or when.
2. **Everything she does is a behavior.** A DSH tool plus metadata. There is no hidden reply path.
3. **Everything that reaches her is a stimulus.** A message, a heartbeat, an alarm, a platform event.
4. **Speech is explicit.** She speaks only by calling `say`. Assistant text reaches nobody.
5. **Code keeps numbers, she keeps meaning.** No keyword lists, no fixed-time scripts.
6. **Model-visible means logged.** Everything put into her context is a DSH session event.
7. **Plugin-shaped.** Every registration is a Cordis effect, so unloading reverts it.
8. **Simplest first.** Non-core features get the simplest working version.

## Documents

| File | Covers |
|---|---|
| `CONSTITUTION.md` | The rule above everything |
| `design/life.md` | The day session, stimuli, `wait`, groups, the inbox, sleep and waking |
| `design/memory.md` | Perception, recall, consolidation, forgetting, storage |
| `design/body.md` | Behaviors and physiology |
| `design/persona.md` | Persona card, self-model, prompt structure |
| `design/channels.md` | Adapter contract, QQ, Bilibili, local |
| `design/outside.md` | `anima-guard`, owner control, the Anima page |
| `dsh.md` | Pinned DSH version, APIs relied on, traps |
| `ROADMAP.md` | Phases ahead |
| `history/` | The first design and its phase records, frozen |

Files in `design/` state only what is true now. Why something was decided gets one line where it matters; everything else belongs in git or `history/`.
