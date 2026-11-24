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

- Speech: `<platform>_say(channel, …)`, `end_turn(reason?)`, `wait(seconds, channel?)`.
- Attention: `groups_glance`, `group_read`, `inbox_read`, platform `observe` behaviors.
- Memory: `memory_recall`, `memory_remember`; in sleep only, `memory_write`.
- Self: `self_feel(...)`, `self_note(...)`, `goals_add`, `goals_update`, `goals_close`.
- Time: `alarm_set(at, note)`, `alarm_list`, `alarm_cancel(id)` (her own alarms, over DSH's schedule service: `at` is on her clock; an alarm rings in her waking session, and moves to the next one when she falls asleep), `rest(note?)`, `sleep(note?)`. `rest` only ends the turn: she stops and idles. It sets nothing in her body; to come back to something at a time she sets an alarm. `sleep` is going to bed: if sleep comes it ends the turn and her waking; if not, the result says she is not sleepy enough and she is still awake.
- Workspace tools (`design/life.md`).

Adapters add platform behaviors (`design/channels.md`).

**Cognition is hers.** What an event means to her, and so what she feels about it and whether it fed a need, is her appraisal: only the model can make it. She registers it with `self_feel`. Code never judges meaning.

## Physiology

Code keeps these numbers and changes them only by time, by sleep and by behaviors' declared `energy`. It never reads message words and never judges what an event means.

**Genes are not rules.** Every parameter below (a rate, a threshold, a half-life) is part of her body, set when she is made, like a human's genes. It restricts no choice, and neither she nor the owner adjusts around it.

| Mechanism | What happens |
|---|---|
| **Clock** | One injectable clock. `clock.speed` and `clock.start` run a test day fast. Her day (for counters, decay and logs) is the local date on her clock |
| **Sleep pressure** | 0–1. Rises while she is awake (`sleep.risePerHour`; from R6 also faster with the energy she spends) and falls while she sleeps (`sleep.fallPerHour`). Her phase is `awake` or `asleep`, kept in `state.json` with since when and why; no clock time decides either |
| **Falling asleep** | Going to bed is her will: she calls `sleep(note?)` whenever she wants. Sleep comes if her pressure is above `sleep.fallAsleepAbove`; otherwise she lies awake and the result says sleep does not come. She can also stay up. When the pressure reaches `sleep.overwhelmAbove`, sleep takes her once the running turn ends |
| **Waking** | Asleep, she wakes when her pressure falls to `sleep.wakeBelow`, or when an alarm she set rings, or when the owner wakes her from outside. Waking satisfies her `rest` need. Once awake, her pressure alone decides when sleep can come again. Her body looks at its pressure every few real seconds and when a turn ends |
| **Asleep** | Nothing in her waking session runs (`anima/asleep`); sleep's consolidation does |
| **Energy and tiredness** | 0–1. Spent by time awake and by behaviors' `energy`; restored by sleep and rest. Below `energy.exhausted` only behaviors with no energy cost run, and the refusal says she is too tired |
| **Needs** | Defined in settings: name, description shown to her, baseline, drift per hour. Default: `connect`, `curiosity`, `expression`, `rest`, `order`. They drift by themselves; what satisfied one is her appraisal, registered with `self_feel` |
| **Mood** | Valence and arousal drifting back to a baseline (`mood.halfLifeHours`, 3). How she feels after something happens is her appraisal, registered with `self_feel`; code only lets it fade |
| **Heartbeat** | Her self-drive: it beats because she is alive, like a human heart, not because anything outside drives it. Nobody controls when it beats or how fast: no behavior of hers sets, delays or skips it, and nothing outside (the guard, the owner, a pause, a budget) starts, stops, skips or paces it. Its rhythm comes only from her own state (arousal, mood, energy, needs, asleep or awake) through her genes' parameters in `heartbeat` (a resting rate and how far her state moves it); those are her body, not limits. Awake, a beat stirs her: it starts a turn carrying her state (phase, sleep pressure, energy, needs, due goals, what happened since). Asleep, it keeps beating and does not wake her. It is not an external stimulus: it is where her autonomy comes from |
| **Typing time** | Between messages of one `say`, `pacing.baseSeconds` + `pacing.perCharSeconds` per character, capped |
| **Memory** | Coming to mind, consolidation in sleep, forgetting (`design/memory.md`) |

**How she meets physiology.** Her state (sleep pressure, energy, mood, needs) is in every heartbeat, and the prompt explains her body before she meets it. A refusal or result says what is true of her body ("you are asleep", "sleep does not come"), not which rule fired.

**Default genes** (starting values, tuned from demos): `sleep.risePerHour` 0.055, `fallPerHour` 0.11, `fallAsleepAbove` 0.6, `overwhelmAbove` 0.98, `wakeBelow` 0.1. From a fresh 0.15 that is about 8 hours awake before sleep can come, about 15 before it takes her, and about 8 hours of sleep.

State lives in `<dataDir>/state.json`.
