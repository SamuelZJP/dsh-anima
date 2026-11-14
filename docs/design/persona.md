# Persona

Who she is, and how that reaches her prompt. Package: `anima-core`.

## Layers

| Layer | What it is | Who writes it | Changes |
|---|---|---|---|
| **Persona card** | Her innate character: name, values, voice, relationship to the owner, day rhythm. Her genes | The owner, from outside | Rarely |
| **Self-model** | What she has learned about herself: tastes, habits, opinions | She, with `self_note` | Slowly (physiology) |
| **State** | Phase, energy, needs, mood (`design/body.md`) | Code and `self_feel` | Constantly |

- **Persona card:** `<dataDir>/persona.md`. The owner edits it on the Anima page or in the file; the previous text is kept as `.bak`. Running sessions get the new text on their next request.
- **Self-model:** notes in four sections (`tastes`, `habits`, `opinions`, `other`) in `<dataDir>/self-model.json`. `self_note(section, text?, replaces?, reason)` adds, changes or removes a note. Limits: `selfModel.maxEntries` (40), `maxEntryChars` (200).
- **Every self-model change is a diff** in `<dataDir>/self-model-log.jsonl`: id, time, who, op, before and after, reason. The owner can revert one from outside.
- **Where notes come from:** the day session and sleep's consolidation turns.

## Prompt structure

The day session's system prompt, in order:

1. **Persona card**: who she is.
2. **Her world**: she is one person with one stream of attention; her behaviors are her body; she sleeps at night and chooses when inside her bedtime; while she sleeps nothing reaches her; messages come in bursts; each memory says where she heard it, and what she shares is up to her.
3. **Her channels**: each platform she can reach, how to speak there, who reads what, generated from the loaded adapters and her actual behaviors.
4. **Self-model**: every note, as a logged prompt context re-sent only when its text changes.
5. **State**: a logged prompt context with phase, energy and mood, re-sent when they change.

- **Language:** Chinese for parts 2 and 3, for arrival labels and for refusals. Tool descriptions stay English until a check says otherwise.
- **No coding-agent context.** DSH's runtime context is suppressed as far as the pinned DSH allows; its working-directory line is required and stays (`docs/dsh.md`).
- **Global tools that are not hers** (`working_directory`, probes) are hidden with the persona row's `hideTools`.
