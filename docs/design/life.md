# Life: waking sessions

She has one stream of attention, like a person, and it breaks only when she sleeps. Each period of wakefulness is one DSH session, her waking session; everything she perceives and does while awake happens in it. A day can hold several: a nap, a night waking and the morning each start a new one. Package: `anima-life`.

## The waking session

- **Prepared when she falls asleep.** The moment sleep comes, life creates the session of her next waking (id from `characterId` and the time she fell asleep) and moves her pending alarms into it (DSH `schedule.edit` with a new `target`), so an alarm that rings while she sleeps wakes her there.
- **Opened by whatever wakes her:** her pressure falling, an alarm, or the owner. Its first step starts with the time, why she woke, her sleep note, what `design/memory.md` lists for waking, and her inbox summarised per channel. Life adds these at step 1 (`agent/pre-step`, logged with source `anima-life/waking`), so they come first however the session started.
- **One session for everything.** Private chats, groups, heartbeats, alarms, browsing, her workspace. There are no per-chat, Self, triage or consolidation sessions.
- **Her context is her working memory.** What she saw and did since she woke is already in it, from every channel. DSH compaction trims it on long wakings; that is working memory fading.
- **Archived when she falls asleep,** after its last turn ends (DSH refuses to archive a running session). Sleep reads its log (`design/memory.md`). Nothing is ever delivered into an archived session: DSH would drop it.
- **Model.** One action model for waking sessions, set in config.

## Stimuli

| Stimulus | From | Effect |
|---|---|---|
| Private message | Adapter | Starts a turn, as a burst once the chat settles |
| Group message that addresses her (@, reply to her, poke) | Adapter | Starts a turn, like a private message |
| Other group message | Adapter | Starts nothing. Kept in the group's unread buffer until she looks |
| Alarm she set | DSH `schedule` | Starts a turn; asleep, it wakes her |
| Platform event (follower, friend request, offline) | Adapter | Joins her next turn as context; starts nothing |
| Owner waking her | Outside | Wakes her from sleep (`design/outside.md`) |

**Her heartbeat is not a stimulus.** It is her own self-drive (`design/body.md`): awake, a beat starts a turn with her state; asleep, it beats without waking her. Nothing outside gates it and no behavior of hers sets it.

**Delivery.** A stimulus that starts a turn uses DSH `agent.steer`: it joins the running turn at the next step, or starts a turn when idle. Context that starts nothing uses `agent.inject`; it joins her next turn ahead of the message that starts it. Each delivered stimulus starts with the time on her clock.

**Bursts.** Messages that arrive together are delivered as one block: who sent how many, then each message with its time and id. A private chat's burst is delivered once the chat has been quiet for `conversation.settleSeconds` (and at most `settleMaxSeconds` after the first message). Where the platform reports typing, typing keeps the window open.

**What an arrival says.** Only facts: which channel, who, whether they addressed her, whether others can read the answer. It never says whether to answer.

## Turns

- **A turn closes by an action:** `say` (unless `more: true`), `wait` timing out, `end_turn`, `rest` or `sleep`.
- **Plain text reaches nobody.** It is her thinking. A turn that ends with only text is a thought she did not say; nothing is forwarded, and nothing reminds her.

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

- **Falling asleep and waking are her body** (`design/body.md`): she goes to bed when she wants, sleep comes when her pressure lets it, and it takes her when the pressure is overwhelming. No clock time decides either.
- **Asleep, nothing reaches her** but an alarm she set and the owner waking her. Messages that would start a turn go to her inbox (`<dataDir>/inbox.json`), per channel. Unaddressed group messages stay in their buffers. The adapter does not mark held messages as read.
- **What runs during sleep:** consolidation, decay, energy recovery, her heartbeat (physiology).
- **`inbox_read(channel?)`** shows what waited. She answers with `say` on that channel. A chat's held messages leave the inbox when she says something there or when that chat writes again (they then arrive with the new messages as one burst); whatever she doesn't answer stays unanswered.

## Her workspace

Settings name her workspace root and the DSH tools she has there (`fs`, `shell`, `web`, each enabled one by one). They run in DSH's sandbox, which is outside her.
