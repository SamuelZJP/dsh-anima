# Body: will and physiology

Everything inside the persona is either will (a behavior she chooses) or physiology (code acting on her state). Package: `anima-core`, with behaviors registered by every inside package.

## Will: behaviors

A behavior is a DSH tool registered through `ctx.tools`, plus metadata. Nothing inside the persona refuses a behavior except physiology (below).

**Metadata**

| Field | Meaning |
|---|---|
| `id` | Tool name, `snake_case` with an area or platform prefix (`qq_say`, `memory_recall`; providers accept only `[A-Za-z0-9_-]{1,64}`) |
| `platform` | Owning platform, or none |
| `effect` | `observe`, `internal`, `workspace`, `express`, `initiate`, `public`, `irreversible`. A description of what the call does; the outside reads it, the persona never limits by it |
| `energy` | Energy the call spends (settings, `energy.costs`) |
| `closes` | A successful call closes the turn |
| `target` | Which channel the call acts on, read from its arguments |
| `facts` | Numbers about a call known before it runs (a video's length), for the outside |

**Core set**

- Speech: `<platform>_say`, `end_turn(reason?)`, `wait(seconds, channel?)`.
- Attention: `groups_glance`, `group_read`, `inbox_read`, `channels_find`, platform `observe` behaviors.
- Memory: `memory_recall`, `memory_remember`; in sleep only, `memory_write`.
- Self: `self_feel(adjustments)`, `self_note(...)`, `goals_add`, `goals_update`, `goals_close`.
- Time: `schedule_create`, `schedule_edit` (DSH built-ins, her own alarms), `rest(until?)`, `sleep(note?)`.
- Workspace tools (`design/life.md`).

Adapters add platform behaviors (`design/channels.md`).

## Physiology

Code keeps these numbers and changes them only by time and by behaviors' declared effects. It never reads message words.

| Mechanism | What happens |
|---|---|
| **Clock** | One injectable clock. `clock.speed` and `clock.start` run a test day fast |
| **Day rhythm** | Phases `asleep`, `waking`, `day`, `evening`, `winding down` from `day.wake` and when she went to sleep. Her day runs from one waking to the next |
| **Sleep pressure** | Rises while awake. `sleep` works from `bedtime.earliest`; at `bedtime.latest` she falls asleep anyway |
| **Energy and tiredness** | 0–1. Spent by time awake and by behaviors' `energy`; restored by sleep and rest. Below `energy.exhausted` only behaviors with no energy cost run, and the refusal says she is too tired |
| **Needs** | Defined in settings: name, description shown to her, baseline, drift per hour, which behaviors satisfy them. Default: `connect`, `curiosity`, `expression`, `rest`, `order` |
| **Mood** | Valence and arousal drifting back to a baseline (3-hour half-life). She moves them with `self_feel` |
| **Heartbeat** | A stimulus from her body. It comes at the time she chose with `rest(until)`, within `heartbeat` bounds, or sooner when a need passes `heartbeat.urgeAbove`. It carries her state: phase, energy, needs, due goals, events since last time |
| **Typing time** | Between messages of one `say`, `pacing.baseSeconds` + `pacing.perCharSeconds` per character, capped |
| **Self-model pace** | The self-model changes slowly: `self_note` at most `selfModel.changesPerDay` times a day |
| **Memory** | Coming to mind, consolidation in sleep, forgetting (`design/memory.md`) |

**How she meets physiology.** Her state is in every heartbeat and in the day session's state context, and the prompt explains her body before she meets its limits. A refusal says what is true of her body ("you are exhausted", "it is not bedtime yet"), not which rule fired.

State lives in `<dataDir>/state.json`.
