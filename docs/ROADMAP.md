# Roadmap

One phase at a time. A phase is done when its exit check passes and is demonstrated in a DSH dev profile. Sped-up exit demos run on the fake demo platform (`scripts/demo/demo-platform.mjs`, development only); QQ is her only real channel. Each phase starts with a plan: what changes, which files, how it is verified. Finished phases are in git and `history/`.

## R5 — Memory

Sources as labels with no filtering (audience scopes, `keep` and the prompt's fence lines go), memories coming to mind on cues, first-contact history per waking, consolidation from the archived session log (one turn per piece in that waking's consolidation session), decay, no forget behavior. Starts with an empty memory; old data directories are left untouched.

**Exit:** across two sped-up days:
- a fact told in a private chat on day 1 comes to mind in a group on day 2, with its source, and she decides herself whether to say it;
- unglanced group lines leave no memory.

## R6 — Energy and needs

- Energy costs and tiredness replace the guard's speech quotas.
- Needs drift by themselves; what satisfied one is her appraisal, through `self_feel`. Code's behavior-to-need table goes.
- The heartbeat's rhythm follows her state: arousal, mood, energy, needs. It is still her self-drive; nothing outside and no behavior of hers controls it.

**Exit:** over a sped-up day:
- a long, busy stretch tires her, and she rests or sleeps of her own accord;
- no quota is involved.

## R7 — QQ day

A supervised real day on QQ under the new design, with a test plan written before it starts.

## Last — dsh-mnemon compatibility

Each waking session she opens is written to `~/.dsh/mnemon-exclude-sessions.json` (a JSON array of session ids, kept with other entries), and removed when it is archived, so the `dsh-mnemon` memory plugin leaves her sessions alone. Before R7 if mnemon runs in that profile.
