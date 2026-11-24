# Memory

She remembers like a person: what she perceived since she woke is in her mind; sleep turns it into long-term memory; memories come to mind when something cues them; unused memories fade. Package: `anima-memory`.

## Layers

| Layer | What it is | Lifetime |
|---|---|---|
| Working memory | The waking session's own context (`design/life.md`) | This waking; fades through compaction; ends at sleep |
| Episodes | Dated memories of what happened | Fade fastest |
| Facts | About people, the world, herself; can be corrected | Fade slowly |
| Self thoughts | Passing thoughts about herself | Do not fade |
| Self-model | Lasting tastes, habits, opinions (`design/persona.md`) | Changes when she decides |

## Where every memory came from

Each memory keeps its **source**: which channel, which person, when. That is a label she reads, never a filter: in a group she can recall what someone told her privately, and the label says so (`来源：Alice，[QQ 私聊「Alice」 qq:…:private:…]，11-10 10:00`). A memory with no channel is her own (a thought, a video she watched). What she does with it is her choice.

## Coming to mind (physiology)

Code adds a `[memory]` message at a step of her waking session that brings something new (`agent/pre-step`), logged with source `anima-memory/recall`. Arrivals that join a running turn (she was in `wait`) cue memories at the step they join, not only at a turn's start. Cues come from each arrival's message source (its channel and who wrote, which life records), never from judging its words:

1. **At waking** (the first step of a waking session): her open goals, the latest `recall.wakingEpisodes` episodes, facts about the people whose messages wait in her inbox.
2. **On each arrival:** facts about the people who wrote, the channel's latest `recall.channelEpisodes` episodes, full-text hits on what arrived (a heartbeat's text is not a cue). They come from every channel, each with its source.
3. **First contact of this waking with a channel** (its first arrival): the last `recall.firstContactLines` lines of that chat from before she woke, from the adapter's history (`animaLife.history`), so she knows where they left off.

- **No repeats.** A memory already shown in this waking session is not shown again (kept in the store's `shown` table, so a restart does not repeat it either).
- **Bounded.** At most `inject.maxItems` memories and `inject.tokenBudget` tokens per message. Nothing is added when nothing is cued.
- **Recall strengthens.** Every memory shown gets one more recall and +0.3 strength (at most 1).

## Trying (will)

- **`memory_recall(query, archive?)`**: trying to remember. Searches every memory; `archive: true` also reaches faded ones. A recall strengthens what it finds.
- **`memory_remember(text, kind?, about?, channel?, from?, importance?)`**: deliberately memorising something now. Written at once, with the channel and person it came from as its source (a private chat's person unless `from` names another).

There is no behavior to forget. Only decay forgets.

## Consolidation in sleep (physiology)

1. When she falls asleep, the waking that ended is archived after its last turn, its log flushed (`docs/design/life.md`), and life emits `anima/waking-archived`. Consolidation of that waking starts then, while she sleeps. It runs after every sleep, a nap included, and only in sleep: no behavior starts it and no clock triggers it. Its input is the archived session's log, read through DSH's session persistence (`docs/dsh.md`): the whole log, not the compacted surface.
2. Only what entered her context counts: arrivals, her thoughts, what she said, what she looked at and read (tool results, cut to `consolidation.resultChars`). What came to mind (`[memory]`) is left out: it is memory already. Group lines she never looked at are not in the log.
3. The log is cut into pieces of at most `consolidation.maxInputTokens`, at event edges. Each piece goes, with the people and places in it and the existing memories about them, to one consolidation turn on `consolidation.model` (a cheap model), in that waking's own consolidation session (`anima-m-…`, preset `anima-consolidation`; a DSH session rather than a plain model call or a subagent, because it is logged and has a tool loop, and a subagent's parent would be the archived waking).
4. There she writes memories with `memory_write(kind, text, channel?, from?, about?, replaces?, importance?)`. A piece mixes channels, so `channel` names where it happened or was said and must be a place that appears in the piece; `from` names who said it (a private chat's person by default); no `channel` means it was her own. `replaces` marks an older memory superseded; it stays as history. Lasting self-knowledge goes to `self_note`.
5. Progress is kept per ended waking (the store's `wakings` table: the last log seq consolidated). A completed turn moves on to the next piece, then to the next ended waking. A piece whose turn ends otherwise, times out (`consolidation.timeoutSeconds`) or is cut short because she woke (the turn is cancelled) is retried at her next sleep.

The consolidation turns are part of her sleep, not a place she can act from: `memory_write` and `self_note` are their only behaviors.

## Forgetting (physiology)

Once per day of hers, every active memory except self thoughts loses strength:

```
halfLife = halfLifeDays × (fact ? factFactor : 1) × (1 + importance) × (1 + recallBonus × recalls)
strength = strength × 0.5 ^ (days / halfLife)
```

Defaults: `halfLifeDays` 7, `factFactor` 4, `recallBonus` 0.5, importance 0.3 unless given.

- **Below `gistBelow` (0.2):** the text shrinks to its first sentence (at most `gistChars`, 80). The original is kept in the database but is no longer what she remembers.
- **Below `archiveBelow` (0.05):** the memory is archived. It never comes to mind by itself; only `memory_recall(archive: true)` reaches it.
- **Strength comes from** recency, importance and recalls.

| With importance 0.3, no recalls | Gist after | Archived after |
|---|---|---|
| Episode | ~21 days | ~39 days |
| Fact | ~85 days | ~157 days |

## Storage

- One SQLite file, `<dataDir>/memory.db` (default `~/.anima/`), on Node's built-in `node:sqlite`.
- Table `memories`: kind, text, original text after gisting, source channel, source person and their name, about-person, the waking it came from, importance, strength, recalls, status (`active`, `archived`, `superseded`), timestamps.
- A store of the first design (audience scopes, a transcript table) fails loud at load (`anima/memory-old-store`): memory starts empty from R5, in a fresh data directory; the old one is left as it is.
- Search: an FTS5 `trigram` index (Chinese, Japanese and Korean have no word breaks); terms shorter than 3 characters fall back to `LIKE`.
- What came to mind per waking session in `shown`; consolidation progress per ended waking in `wakings`; small values in `meta`.
- Deleting, editing and browsing memories is the owner's, from outside (`design/outside.md`).
