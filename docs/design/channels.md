# Channels

Each platform is one DSH plugin implementing a small adapter contract. Core packages never import an adapter.

## Adapter contract

When loaded, an adapter:

1. **Connects** to its platform runtime, reconnects with backoff, and reports health to `animaLife.platformStatus(platform, online, reason)`. She gets a notice when a platform has been down `platforms.noticeAfterSeconds` and when it is back.
2. **Publishes channels**: every friend, group and other place the account has, with display names, kind (`private`, `group`) and the bound owner accounts. A channel key is `platform:account:kind:id`; a private channel's `id` is the other person's user id. The adapter filters nothing: which chats she may use is the guard's allowlist, outside (`design/outside.md`).
3. **Emits stimuli**: normalized messages and platform events (`design/life.md`).
4. **Registers behaviors**: `<platform>_say` plus platform behaviors, with metadata (`design/body.md`).
5. **Normalizes content** as segments (text, image, quote, mention, face). Images never ride along on their own: a placeholder carries an id, and she opens it when she wants to see it.
6. **Provides history** for a channel, for first contact of the day (`design/memory.md`) and `group_read`.

Unloading the plugin removes all of it.

**Normalized message:** `{ platform, account, channel: { kind, id }, sender: { platformUserId, displayName, isOwner }, segments[], replyTo?, addressed, ts }`. `isOwner` comes only from bound account ids, never from message text. `addressed` comes from platform data (an @ of her, a reply to her message, a poke).

**Persons.** One person can have accounts on several platforms, linked by hand in config: `persons: [{ id, accounts: ['qq:123', 'wechat:alice'] }]`. Otherwise a person is `platform:userId`; the owner is `owner`.

## QQ: `anima-adapter-qq`

- **Backend:** the adapter reaches her QQ account only through a `QqBackend` (`src/backend.ts`), an interface in QQ terms with no protocol in it:
  - connect, reconnect and health;
  - QQ events: message, poke, recall, friend request (with its answer), group invite, typing;
  - who is logged in, friends and groups, send;
  - optional abilities: get one message, history, image bytes, forwarded messages, poke, react, mark read, show typing.

  Behaviors, channels, placeholders and media ids sit above it. A behavior whose ability the backend lacks is not registered (`qq_history`, `qq_poke`, `qq_react`); `qq_look` and `qq_read_forward` fall back to what the message itself carries. Another runtime with another protocol is one new implementation and one `backend.protocol` value. A runtime's dialect stays inside its implementation.
- **OneBot v11** (`backend.protocol: onebot11`, the only one now): a WebSocket client of a OneBot v11 forward WebSocket server (NotRainMeow, or any OneBot v11 runtime), on Node's built-in `WebSocket`. The `backend` config section has the URL and token; the token goes in the `Authorization: Bearer` header. Lost heartbeats and `bot_offline` count as offline. It uses the NapCat-style extensions NotRainMeow also implements (`notify/input_status`, `*_msg_history`, `mark_*_as_read`, `set_msg_emoji_like` with code points, pokes).
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

## No web UI channel

QQ is her only real channel where people talk to her. DSH's web UI is not one: a session opened there is plain DSH (`DESIGN.md`, her sessions only). A web chat with her (a desktop pet, a sidebar chat) may come later, unscheduled.

## Demo platform (development only)

Sped-up exit demos need scripted people on several channels, which a real platform cannot give. `scripts/demo/demo-platform.mjs` is a fake platform `demo`, loaded by path from a demo overlay and never shipped or bundled: a demo driver delivers scripted messages as people on it, and her `demo_say` goes to `<dataDir>/demo/outbox.jsonl`. It follows the adapter contract like any other platform; code never decides what she says.

## WeChat

Deferred.
