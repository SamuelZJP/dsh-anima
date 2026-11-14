# Life: the day session

She has one stream of attention, like a person. Each waking day is one DSH session; everything she perceives and does that day happens in it. Package: `anima-life`.

## The day session

- **Opened at waking.** The first heartbeat after she wakes creates a new session (id from `characterId` and her day). It starts with what `design/memory.md` lists for waking, and her inbox.
- **One session for everything.** Private chats, groups, heartbeats, alarms, browsing, her workspace. There are no per-chat, Self, triage or consolidation sessions.
- **Her context is her working memory.** What she saw and did today is already in it, from every channel. DSH compaction trims it on long days; that is working memory fading.
- **Archived at sleep.** When she falls asleep the session ends and is archived. Sleep reads its log (`design/memory.md`).
- **Model.** One action model for the day session, set in config.

## Stimuli

| Stimulus | From | Effect |
|---|---|---|
| Private message | Adapter | Wakes a turn, as a burst once the chat settles |
| Group message that addresses her (@, reply to her, poke) | Adapter | Wakes a turn, like a private message |
| Other group message | Adapter | Wakes nothing. Kept in the group's unread buffer until she looks |
| Heartbeat | Physiology (`design/body.md`) | Wakes a turn with her state |
| Alarm she set | DSH `schedule` | Wakes a turn |
| Platform event (follower, friend request, offline) | Adapter | Joins her next turn as context; wakes nothing |
| Owner waking her | Outside | Wakes her from sleep (`design/outside.md`) |

**Delivery.** A waking stimulus uses DSH `agent.steer`: it joins the running turn at the next step, or starts a turn when idle. Context that wakes nothing uses `agent.inject`. Each delivered stimulus starts with the time on her clock.

**Bursts.** Messages that arrive together are delivered as one block: who sent how many, then each message with its time and id. A private chat's burst is delivered once the chat has been quiet for `conversation.settleSeconds` (and at most `settleMaxSeconds` after the first message). Where the platform reports typing, typing keeps the window open.

**What an arrival says.** Only facts: which channel, who, whether they addressed her, whether others can read the answer. It never says whether to answer.

## Turns

- **A turn closes by an action:** `say` (unless `more: true`), `wait` timing out, `end_turn`, `rest` or `sleep`. Plain text reaches nobody and never closes a turn.
- **If a turn is about to stop without a closing action,** code steers a reminder into the same turn, up to `closeReminders` times. Then the turn ends and an unclosed turn is recorded. Nothing is forwarded.

## Speaking and waiting

- **`<platform>_say(channel, text, also?, replyTo?, more?)`** speaks on any channel she can reach: one message in `text`, more in `also`. Between messages the adapter waits a typing time from the message length (physiology: how fast she types).
- **`wait(seconds, channel?)`** keeps her attention open. It returns at once when any stimulus arrives, from any channel, and closes the turn when the time runs out with nothing new. `channel` only says what she is waiting for; anything still interrupts it.
- **Two chats at once** interleave in one turn, as they would for a person holding two conversations.

## Groups

People do not read every unread message in every group. She doesn't either.

- **Unread buffer.** Unaddressed group messages wait in a buffer per group (last `groups.bufferMessages` lines). Nothing is shown to her until she looks.
- **`groups_glance()`** lists groups with unread messages: name, unread count, and the latest few lines (`groups.glanceLines`).
- **`group_read(channel, before?)`** reads further back in one group.
- **She speaks in a group with the same `say`.** For a while after she speaks there (`groups.attentionSeconds`), that group's new messages reach her as stimuli, as an open conversation does.
- **What she never looked at, she never perceived.** It is not remembered.

## Sleep and waking

- **Going to sleep is her will, inside her physiology.** She calls `sleep(note?)` from `bedtime.earliest`. At `bedtime.latest` sleep takes her anyway; a running turn finishes first.
- **Asleep, nothing reaches her.** Messages that would wake a turn go to her inbox (`<dataDir>/inbox.json`), per channel. Unaddressed group messages stay in their buffers. The adapter does not mark held messages as read.
- **What runs during sleep:** consolidation, decay, energy recovery (physiology). Alarms she set herself still wake her. The owner can wake her from outside.
- **Waking** happens at `day.wake` (or when an alarm or the owner wakes her). The first heartbeat opens the new day session, with the inbox summarised per channel.
- **`inbox_read(channel?)`** shows what waited. She answers with `say` on that channel; whatever she doesn't answer stays unanswered.

## Her workspace

Settings name her workspace root and the DSH tools she has there (`fs`, `shell`, `web`, each enabled one by one). They run in DSH's sandbox, which is outside her.
