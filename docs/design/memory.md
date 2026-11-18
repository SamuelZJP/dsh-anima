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

Each memory keeps its **source**: which channel, which person, when. That is a label she reads, never a filter: in a group she can recall what someone told her privately, and the label says so ("Alice told you this in a private QQ chat"). What she does with it is her choice.

## Coming to mind (physiology)

Code adds a `[memory]` message at the start of a turn (`agent/pre-step`, step 1), logged with source `anima-memory/recall`:

1. **At waking:** open goals, the latest episodes from before this sleep, facts about the people in her inbox.
2. **On each stimulus:** memories cued by it: the person, the channel, full-text hits on what arrived.
3. **First contact of this waking with a channel:** the last few lines of that chat from before she woke (`recall.firstContactLines`, from the adapter's history), so she knows where they left off.

- **No repeats.** A memory already shown in this waking session is not shown again.
- **Bounded.** At most `inject.maxItems` memories and `inject.tokenBudget` tokens per message. Nothing is added when nothing is cued.
- **Recall strengthens.** Every memory shown gets one more recall and +0.3 strength (at most 1).

## Trying (will)

- **`memory_recall(query, archive?)`**: trying to remember. Searches every memory; `archive: true` also reaches faded ones. A recall strengthens what it finds.
- **`memory_remember(text, kind?, about?, channel?, importance?)`**: deliberately memorising something now. Written at once, with the channel and person it came from as its source label.

There is no behavior to forget. Only decay forgets.

## Consolidation in sleep (physiology)

1. When she falls asleep, the log of the waking session that just ended is read through DSH's session persistence (`docs/dsh.md`): the whole log, not the compacted surface. It runs after every sleep, a nap included, and only in sleep: no behavior starts it and no clock triggers it.
2. Only what entered her context counts: messages delivered to her, what she said, what she looked at and read. Group lines she never looked at are not in it.
3. The log is cut into pieces of at most `consolidation.maxInputTokens`. Each piece goes, with the existing memories about the same people and channels, to a short consolidation turn on `consolidation.model` (a cheap model).
4. There she writes memories with `memory_write(kind, text, about?, replaces?, importance?)`. The source comes from the piece. `replaces` marks an older memory superseded; it stays as history. Lasting self-knowledge goes to `self_note`.
5. The waking counts as consolidated when every piece is done. A piece that fails, times out or is cut short by waking is retried at the next sleep.

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
- Table `memories`: kind, text, original text after gisting, source channel, source person, about-person, importance, strength, recalls, status (`active`, `archived`, `superseded`), timestamps.
- Search: an FTS5 `trigram` index (Chinese, Japanese and Korean have no word breaks); terms shorter than 3 characters fall back to `LIKE`.
- Consolidation progress per waking session in a small `meta` table.
- Deleting, editing and browsing memories is the owner's, from outside (`design/outside.md`).
