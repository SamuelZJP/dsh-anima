# Body: will and physiology

Everything inside the persona is either will (a behavior she chooses) or physiology (code acting on her state). Package: `anima-core`, with behaviors registered by every inside package.

## Will: behaviors

A behavior is a DSH tool registered through `ctx.tools`, plus metadata. Nothing inside the persona refuses a behavior except physiology (below).

**Metadata**

| Field | Meaning |
|---|---|
| `id` | Tool name, `snake_case` with an area or platform prefix (`qq_say`, `memory_recall`; providers accept only `[A-Za-z0-9_-]{1,64}`) |
| `platform` | Owning platform, or none |
| `effect` | `observe`, `internal`, `workspace`, `express`, `initiate`, `public`, `irreversible`. A description of what the call does; the outside reads it, the persona never limits by it. Her body reads it for the energy a call spends (below) |
| `closes` | A successful call closes the turn |
| `target` | Which channel the call acts on, read from its arguments |
| `facts` | Numbers about a call known before it runs (a video's length), for the outside |

**Core set**

- Speech: `<platform>_say(channel, …)`, `end_turn(reason?)`, `wait(seconds, channel?)`.
- Attention: `groups_glance`, `group_read`, `inbox_read`, platform `observe` behaviors.
- Memory: `memory_recall`, `memory_remember`; in sleep only, `memory_write`.
- Self: `self_feel(valence?, arousal?, needs?, why?)` (her mood and the levels of the needs she appraised), `self_note(...)`, `goals_add`, `goals_update`, `goals_close`.
- Time: `alarm_set(at, note)`, `alarm_list`, `alarm_cancel(id)` (her own alarms, over DSH's schedule service: `at` is on her clock; an alarm rings in her waking session, and moves to the next one when she falls asleep), `rest(note?)`, `sleep(note?)`. `rest` only ends the turn: she stops and idles. It sets nothing in her body; to come back to something at a time she sets an alarm. `sleep` is going to bed: if sleep comes it ends the turn and her waking; if not, the result says she is not sleepy enough and she is still awake.
- Workspace tools (`design/life.md`).

Adapters add platform behaviors (`design/channels.md`).

**Cognition is hers.** What an event means to her, and so what she feels about it and whether it fed a need, is her appraisal: only the model can make it. She registers it with `self_feel`. Code never judges meaning.

## Physiology

Code keeps these numbers and changes them only by time, by sleep and by the energy her behaviors spend. It never reads message words and never judges what an event means.

**Genes are not rules.** Every parameter below (a rate, a threshold, a half-life) is part of her body, set when she is made, like a human's genes. It restricts no choice, and neither she nor the owner adjusts around it.

| Mechanism | What happens |
|---|---|
| **Clock** | One injectable clock. `clock.speed` and `clock.start` run a test day fast. Her day (for counters, decay and logs) is the local date on her clock |
| **Sleep pressure** | 0–1. Rises while she is awake (`sleep.risePerHour`), and with each unit of energy she spends (`sleep.perEnergy`), so a busy stretch makes her sleepy sooner; it falls while she sleeps (`sleep.fallPerHour`). Her phase is `awake` or `asleep`, kept in `state.json` with since when and why; no clock time decides either |
| **Falling asleep** | Going to bed is her will: she calls `sleep(note?)` whenever she wants. Sleep comes if her pressure is above `sleep.fallAsleepAbove`; otherwise she lies awake and the result says sleep does not come. She can also stay up. When the pressure reaches `sleep.overwhelmAbove`, sleep takes her once the running turn ends |
| **Waking** | Asleep, she wakes when her pressure falls to `sleep.wakeBelow`, or when an alarm she set rings, or when the owner wakes her from outside. Waking satisfies her `rest` need. Once awake, her pressure alone decides when sleep can come again. Her body looks at its pressure every few real seconds and when a turn ends |
| **Asleep** | Nothing in her waking session runs (`anima/asleep`); sleep's consolidation does |
| **Energy and tiredness** | 0–1. Drains while she is awake (`energy.drainPerHour`) and with each successful call in her waking session: `energy.behaviorCosts` by behavior name or `prefix_*`, else `energy.costs` by its `effect` (internal calls cost nothing). It comes back a little while she is awake and no turn runs (`energy.idleRestorePerHour`: idling, not a behavior) and most while she sleeps (`energy.restorePerHour`). Below `energy.exhausted` only calls that cost nothing run; the refusal (`anima/exhausted`) says she is too tired |
| **Needs** | Defined in settings: name, description shown to her, baseline, drift per awake hour. Default: `connect`, `curiosity`, `expression`, `rest`, `order`. They drift up by themselves. What satisfied one, or left it hungrier, is her appraisal: she sets its level with `self_feel`. Code never lowers a need for a behavior, except that waking returns `rest` to its baseline (sleep itself) |
| **Mood** | Valence and arousal drifting back to a baseline (`mood.halfLifeHours`, 3). How she feels after something happens is her appraisal, registered with `self_feel`; code only lets it fade |
| **Heartbeat** | Her self-drive: it beats because she is alive, like a human heart, not because anything outside drives it. Nobody controls when it beats or how fast: no behavior of hers sets, delays or skips it, and nothing outside (the guard, the owner, a pause, a budget) starts, stops, skips or paces it. Its rhythm comes only from her own state through her genes in `heartbeat`; those are her body, not limits. At each beat the next is set from her state then: `restingMinutes` × (1 + `fatigueGain` × spent energy) × (`asleepFactor` while asleep) ÷ (1 + `arousalGain` × arousal above its baseline + `valenceGain` × valence below its baseline + `needGain` × her strongest need above 0.5), within `fastestMinutes`–`slowestMinutes`. Awake, a beat stirs her: it starts a turn carrying her state (phase, sleep pressure, energy, needs, due goals, what happened since). Asleep, it keeps beating and does not wake her. It is not an external stimulus: it is where her autonomy comes from |
| **Typing time** | Between messages of one `say`, `pacing.baseSeconds` + `pacing.perCharSeconds` per character, capped |
| **Memory** | Coming to mind, consolidation in sleep, forgetting (`design/memory.md`) |

**How she meets physiology.** Her state (sleep pressure, energy, mood, needs) is in every heartbeat, and the prompt explains her body before she meets it. A refusal or result says what is true of her body ("you are asleep", "sleep does not come"), not which rule fired.

**Default genes** (starting values, tuned from demos):
- Sleep: `risePerHour` 0.045, `perEnergy` 0.3, `fallPerHour` 0.11, `fallAsleepAbove` 0.6, `overwhelmAbove` 0.98, `wakeBelow` 0.1. From a fresh 0.15, a quiet waking reaches 0.6 in about 9 hours and a busy one sooner; about 8 hours of sleep.
- Energy: `drainPerHour` 0.03, `idleRestorePerHour` 0.05, `restorePerHour` 0.15, `exhausted` 0.1; `costs` observe 0.005, workspace 0.01, express 0.015, initiate, public and irreversible 0.02, internal 0; `behaviorCosts` `bili_view_closely` 0.06, `bili_watch` 0.02.
- Heart: `restingMinutes` 60, `arousalGain` 1, `valenceGain` 0.3, `needGain` 0.6, `fatigueGain` 0.8, `asleepFactor` 2, `fastestMinutes` 15, `slowestMinutes` 180.

State lives in `<dataDir>/state.json`.
