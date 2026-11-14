# Roadmap

One phase at a time. A phase is done when its exit check passes and is demonstrated in a DSH dev profile. The first design's Phases 0–9 are in `history/DESIGN-v1.md`; the formal test `formal-2` is dropped.

Each phase starts with a plan: what changes, which files, how it is verified.

## R0 — Documents

Constitution, overview, one file per subsystem, DSH notes, history frozen.
**Exit:** the owner has reviewed the documents.

## R1 — The outside

Move every safety and management mechanism out of the persona into `anima-guard`: the gate's safety checks, approvals, allowlist, consent, budgets, pause, outbox hold, owner commands, activity log, memory and self-model management. `anima-page` depends on `anima-guard` only.
**Exit:**
- Persona packages import neither `anima-guard` nor `anima-page`.
- With `anima-guard` loaded, the existing tests and a short dev-profile chat behave as before.
- With it unloaded, she runs with no restrictions except physiology.

## R2 — The day session

One DSH session per waking day: stimuli into it, `say(channel, …)`, `wait`, `groups_glance` and `group_read`, @ as a direct stimulus, the inbox, sleep archiving the session, waking opening a new one. The conversation, Self, triage, group-triage and intent mechanisms go.
**Exit:** over a sped-up dev day on the local adapter:
- she talks in two channels and refers in one to what happened in the other, without a memory behavior;
- the session is archived at sleep;
- the next waking opens a new session.

## R3 — Memory

Sources as labels with no filtering, memories coming to mind on cues, first-contact history, consolidation in sleep from the archived session log, decay, no forget behavior. Starts with an empty memory; old data directories are left untouched.
**Exit:** across two sped-up days:
- a fact told in a private chat on day 1 comes to mind in a group on day 2, with its source, and she decides herself whether to say it;
- unglanced group lines leave no memory.

## R4 — Physiology

Energy costs and tiredness instead of speech quotas, the heartbeat driven by needs and energy, the self-model's pace as physiology.
**Exit:** over a sped-up day:
- a long, busy stretch tires her and she rests or sleeps of her own accord;
- no quota is involved.

## R5 — QQ day

A supervised real day on QQ under the new design, with a test plan written before it starts.
