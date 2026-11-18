# Roadmap

One phase at a time. A phase is done when its exit check passes and is demonstrated in a DSH dev profile. Sped-up exit demos run on the fake demo platform (`scripts/demo/demo-platform.mjs`, development only); QQ is her only real channel. Each phase starts with a plan: what changes, which files, how it is verified. Finished phases are in git and `history/`.

## R2 — Only will and physiology inside

Clear every restriction out of the persona that is neither her will nor her physiology. No new mechanisms.
- The Anima bundle installs only the persona packages; `anima-guard` and `anima-page` move to their own `guard-bundle`.
- The QQ adapter publishes every friend and group; the allowlist moves into the guard.
- Self-model limits go (`changesPerDay`, `maxEntries`, `maxEntryChars`), and so does the owner-policy hook `BehaviorMeta.constraint`.
- The heartbeat is hers alone: no `until` on `rest`, no interval clamp, no guard admit, no `/anima heartbeat`. Its rhythm is her resting rate (a gene).
- Close reminders and the lost-reply record go.
- Her prompt loses its rules and nudges: the trust rule, the "usually" lines, the owner's ranges.
- `anima-adapter-local` and `local_say` go: DSH's web UI is not her channel, and a session opened there stays plain DSH. Demos use the fake demo platform.

**Exit:**
- Every refusal code inside the persona is physiology or plumbing, listed by a test.
- She runs with the guard bundle not installed. With it installed, the allowlist and quotas act from outside.
- Nothing she calls and nothing outside changes when her heart beats.
- A native DSH session gets nothing from Anima (no behavior, prompt, recall, record or stimulus), by a test.

## R3 — QQ backend

NapCat is gone; her QQ backend is now NotRainMeow (OneBot v11, on another machine, reached through the owner's SSH tunnel). The adapter's protocol calls move behind one `QqBackend` interface, so a later backend is one new implementation.
- `QqBackend`, in QQ terms: connect and health, normalized events (message, @, reply, poke, recall, friend request, typing), friend and group lists, send segments, history, image bytes, forwarded messages, poke, react, and which of these it supports.
- One implementation, OneBot v11 (the current code, moved). A runtime's dialect differences stay inside it.
- Behaviors, channels, placeholders and media ids sit above the interface; a behavior the backend cannot do is not registered.

**Exit:**
- The QQ tests pass against a fake backend.
- A short supervised check on NotRainMeow, with the owner's go-ahead: receive, send, history, an image.

## R4 — Waking sessions, sleep and the heartbeat

One DSH session per period of wakefulness, and sleep as physiology.
- Sleep pressure rises while she is awake and falls in sleep. `sleep` is hers at any time; sleep comes when she is sleepy enough and takes her when the pressure is overwhelming. She wakes when it is paid off, or by an alarm, or by the owner.
- The bedtime window, the fixed wake time, `wokenMinutes`, clock phases and night mode go.
- At falling asleep: the next waking's session is prepared, her alarms move into it, and the ended session is archived after its last turn. The waking context is added at its first step.
- Stimuli go into the waking session (steer and inject). `say(channel, …)` works on any channel, and `wait(seconds, channel?)` returns early on any stimulus.
- `groups_glance` and `group_read`; an @ is a direct stimulus; the inbox while she sleeps.
- The conversation, Self, triage and group-triage sessions go, and so do the intent handoff and `inbox_answer`. Her waking session is then the only DSH session of hers; a close view's perception runs as a subagent of it.
- The heartbeat beats in the waking session; asleep, it does not wake her.
- Consolidation starts only when she falls asleep; `memory_consolidate` and the 24-hour fallback go. The memory package otherwise stays as it is.

**Exit:** over a sped-up day on the demo platform:
- she talks in two channels and refers in one to what happened in the other, without a memory behavior;
- she goes to bed when she chooses: when she isn't sleepy, sleep doesn't come; when she stays up, sleep takes her;
- each sleep archives its session, and each waking, a night waking by the owner included, opens a new one;
- an alarm she set rings while she sleeps and wakes her in the new session.

## R5 — Memory

Sources as labels with no filtering (audience scopes, `keep` and the prompt's fence lines go), memories coming to mind on cues, first-contact history per waking, consolidation from the archived session log (a plain model call; a subagent if a spike shows one fits), decay, no forget behavior. Starts with an empty memory; old data directories are left untouched.

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
