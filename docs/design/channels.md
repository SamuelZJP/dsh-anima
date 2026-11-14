# Channels

Each platform is one DSH plugin implementing a small adapter contract. Core packages never import an adapter.

## Adapter contract

When loaded, an adapter:

1. **Connects** to its platform runtime, reconnects with backoff, and reports health to `animaLife.platformStatus(platform, online, reason)`. She gets a notice when a platform has been down `platforms.noticeAfterSeconds` and when it is back.
2. **Publishes channels**: friends, groups and other places, with display names, kind (`private`, `group`) and the bound owner accounts. A channel key is `platform:account:kind:id`; a private channel's `id` is the other person's user id.
3. **Emits stimuli**: normalized messages and platform events (`design/life.md`).
4. **Registers behaviors**: `<platform>_say` plus platform behaviors, with metadata (`design/body.md`).
5. **Normalizes content** as segments (text, image, quote, mention, face). Images never ride along on their own: a placeholder carries an id, and she opens it when she wants to see it.
6. **Provides history** for a channel, for first contact of the day (`design/memory.md`) and `group_read`.

Unloading the plugin removes all of it.

**Normalized message:** `{ platform, account, channel: { kind, id }, sender: { platformUserId, displayName, isOwner }, segments[], replyTo?, addressed, ts }`. `isOwner` comes only from bound account ids, never from message text. `addressed` comes from platform data (an @ of her, a reply to her message, a poke).

**Persons.** One person can have accounts on several platforms, linked by hand in config: `persons: [{ id, accounts: ['qq:123', 'local:alice'] }]`. Otherwise a person is `platform:userId`; the owner is `owner`.

## QQ: `anima-adapter-qq`

- **Transport:** a WebSocket client of a OneBot v11 forward WebSocket server (NapCatQQ, or any OneBot v11 runtime), on Node's built-in `WebSocket`. URL and token in config. Lost heartbeats and `bot_offline` count as offline.
- **In:** private and group messages, @, replies, pokes, recalls, friend requests, typing notices where the runtime sends them (`notify/input_status`).
- **Placeholders:** `[image #i3: summary]`, `[sticker #i4: summary]`, `[forwarded messages #f2]`; quoted replies show who wrote the original and a snippet. Ids survive restarts (`<dataDir>/qq/media.json`).
- **Behaviors:** `qq_say(channel, text, also?, replyTo?, mention?, more?)`, `qq_history(channel)`, `qq_look(id)` (the picture itself, in a tool result, on a vision-capable model), `qq_read_forward(id)`, `qq_poke(channel, userId?)`, `qq_react(messageId, emoji)`.
- **Typing:** in a private chat QQ shows "typing" during the typing time between her messages.

## Bilibili: `anima-adapter-bili`

A place she watches, not one where she talks. She picks the depth herself.

| Depth | Behaviors | Returns |
|---|---|---|
| Skim | `bili_feed`, `bili_popular`, `bili_search(query)` | One line per video |
| Watch | `bili_watch(bvid)`, `bili_comments(bvid, page?)` | A text digest: metadata, subtitles, danmaku sample, top comments |
| Look closely | `bili_view_closely(bvid, focus?)` | What she saw, as text |

- **Looking closely is her eyes (physiology).** The adapter downloads a 360p stream, `ffmpeg` extracts frames (first frame, scene changes, a fallback interval), and the frames with their subtitle lines go to a short perception turn on a vision model. Only its description returns to the day session; the files are deleted. `ffmpeg` is required while close views are enabled (`anima/ffmpeg-missing` at load).
- **Account:** a dedicated account, logged in by the owner with a QR code. The cookie is in `<dataDir>/bili/cookie.json` (0600). WBI signing uses `node:crypto`.
- **Transport:** one request at a time with a minimum gap; on Bilibili's risk control (`-352`) it backs off, doubling from 60 s.

## Local: `anima-adapter-local`

A dev adapter over DSH's web UI. `local_say` speaks to the owner without any external platform. `/anima chat [--as <name>] [--in group:<id>] <text>` speaks as another person or in a simulated group; a message containing her name counts as addressed.

## WeChat

Deferred.
