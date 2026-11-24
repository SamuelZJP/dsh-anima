# Persona

Who she is, and how that reaches her prompt. Package: `anima-core`.

## Layers

| Layer | What it is | Who writes it | Changes |
|---|---|---|---|
| **Persona card** | Her innate character: name, values, voice, relationship to the owner | The owner, from outside | Rarely |
| **Genes** | Her physiology's parameters (`design/body.md`): sleep, heart, energy, needs, mood. Her body, not rules | The owner, in config, when she is made | Rarely |
| **Self-model** | What she has learned about herself: tastes, habits, opinions | She, with `self_note`, awake or in sleep's consolidation | When she decides |
| **State** | Phase, sleep pressure, energy, needs, mood (`design/body.md`) | Code (physiology) and her appraisal through `self_feel` | Constantly |

- **Persona card:** `<dataDir>/persona.md`. The owner edits it on the Anima page or in the file; the previous text is kept as `.bak`. Running sessions get the new text on their next request.
- **Self-model:** notes in four sections (`tastes`, `habits`, `opinions`, `other`) in `<dataDir>/self-model.json`. `self_note(section, text?, replaces?, reason)` adds, changes or removes a note. Nothing inside limits how many notes she keeps or how often she changes them.
- **Every self-model change is a diff** in `<dataDir>/self-model-log.jsonl`: id, time, who, op, before and after, reason. The owner can revert one from outside.
- **Where notes come from:** waking sessions and sleep's consolidation turns.

## Prompt structure

The waking session's system prompt, in order:

1. **Persona card**: who she is.
2. **Her world**: she is one person with one stream of attention; her behaviors are her body; her plain text is her thinking and reaches nobody; she goes to bed when she wants, and sleep comes when she is sleepy enough; each sleep ends a waking and the next waking starts fresh, with what comes to mind; while she sleeps nothing reaches her but her alarms and the owner; messages come in bursts. The waking rules add that each memory says where she heard it, and what she shares is up to her.
3. **Her channels**: each platform she can reach, how to speak there, who reads what, generated from the loaded adapters and her actual behaviors.
4. **Self-model**: every note with its id, as a logged prompt context re-sent only when its text changes.
5. **State**: phase, sleep pressure, energy, mood and needs, carried by every heartbeat.

Sleep's consolidation sessions get the persona card, "this place" and their own rules, without "her world". A close view's subagent gets the persona card and what the look is (`VIEWING_RULES`), and no behaviors of hers.

**Facts, never rules or nudges.** The prompt states what is true of her body and her places. It never tells her what to choose, whom to trust, what not to share, or what she usually does. What the outside may stop is stated by the outside, under its own heading (`design/outside.md`).

- **Language:** Chinese for parts 2 and 3, for arrival labels and for refusals. Tool descriptions stay English until a check says otherwise.
- **No coding-agent context.** DSH's runtime context is suppressed as far as the pinned DSH allows; its working-directory line is required and stays (`docs/dsh.md`).
- **Global tools that are not hers** (`working_directory`, probes) are hidden with the persona row's `hideTools`.
