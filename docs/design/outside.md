# Outside the persona

Safety and management act on her from outside, like shackles and an operating table. They live in `anima-guard` and `anima-page`, or in DSH itself. They are not part of the Anima plugin: they ship in their own bundle, `anima-guard-bundle`, installed next to her (`docs/dsh.md`). Persona packages never import them; uninstalling that bundle leaves her running, unrestricted.

The outside acts on her body from outside: it can stop the world from reaching her and refuse what she does to it. It never reaches into her physiology: nothing here starts, stops, skips or paces her heartbeat, her sleep, her consolidation or any other mechanism of her body.

## `anima-guard`

### How the outside reaches her

The persona never imports `anima-guard`; the guard imports the persona's types and uses:

- **`tools/pre-execute`**: the guard's listener runs first. It leaves what her body refuses to her body (`anima.check`), then applies the checks below.
- **`anima/admit`** (a Cordis `bail` event the persona asks before something happens): `reach` (may this stimulus reach her now, from this channel: the allowlist and pause), `wake` (a stimulus that is not a tool call, `group_attention`), `initiate` (consent, for her report). Without a listener, everything is admitted.
- **Never her heartbeat.** The heartbeat is her self-drive inside her body (`design/body.md`). The outside has no hook on it and no command for it: nothing here starts, stops, skips or paces it. A pause or a spent budget acts on what she does, at the gate, while her heart keeps beating.
- **`anima/owner-message`** and **`anima/friend-request`**: adapters hand owner replies and friend requests outward; whoever answers consumes them.
- **`anima/record`**: the persona emits what happened; the guard keeps the log.
- **`anima/outgoing-held`**: the guard tells adapters a message she started is being held, so QQ can show typing.
- **Read and act methods** on the persona's services (state, sleep, goals, self-model, inbox, memory store), and platforms' self-descriptions (`providePlatform`: view, actions, subcommands).
- **Facts in her context**: `anima.addPlaceLines` (owner rules under "外面可能拦住你的事", the speaking-first rule and the outbox hold among them) and `animaLife.addBudgetLine`. The token budget's day and night follow whether she is awake or asleep.

### The gate

One listener on DSH's `tools/pre-execute` waterfall checks every behavior call and calls `next()`. It reads behavior metadata (`effect`, `target`, `facts`) and her state through the persona's services. Defaults:

| Check | Default |
|---|---|
| **Allowlist** | `allowlist.<platform>`: `open`, or `users` and `groups`; the owner's own channels always pass, and a platform not listed lets only them through. Default: empty, so only the owner's own channels. Adapters publish every chat; a stimulus from a chat not on the list does not reach her and is not kept (`reach` with `drop`), and a call toward one that is not `internal` is refused (`anima/not-allowlisted`) |
| **Speaking first** | A say toward a chat counts as her speaking first when nobody there wrote to her (inbox included), and she did not speak there, within `initiate.replyWindowMinutes` (30) of her clock. Her life reports only when she last heard and spoke (`lastHeard`, `lastSpoke`); the rule is the guard's. Speaking first: only on the owner's channels and channels listed in `consent` (`anima/no-consent`), not in `quietHours`, at most `initiate.perDay` a day (counted once the say succeeds) |
| **Approval** | `public` and `irreversible` calls, and behaviors listed in `approve`, wait for the owner (below) |
| **Rate limits** | Per channel, platform or day, set in `quotas`, and fact `limits` (close-view length and frames, 5 messages per say). Until R6 the first design's defaults stay (`express` 30 an hour per channel, 200 calls a day, platform protection for `qq_*` and `bili_*`); R6 replaces the speech limits with tiredness and keeps only platform protection |
| **Token budget** | Daily caps on billable tokens, awake and asleep (`budget.day` 300,000, `budget.night` 20,000). Over it, the gate refuses her behaviors except internal ones; her body runs on |
| **Pause** | Nothing reaches her (`reach`), and the gate refuses everything except calls that only close a turn; her body runs on |

- **A refusal tells her what happened,** in her language, as something done to her from outside, never as her own choice: `<code>: <hint>`. The code is also in the structured error for the log and the page.
- **Quota counters** persist in `<dataDir>/guard.json`.

### Approvals

- **The owner line** is the owner's private chat on a platform that provides one (QQ).
- **A held call** sends `[Anima approval a3] … Reply "yes a3" or "no a3".` The owner's `yes`/`no <id>` is consumed by the guard and never reaches her. No answer within `approvals.timeoutSeconds` (600) means denied.
- **Friend requests** use the same flow; accepting one does not add the person to the allowlist.

### Outbox hold

- **When it applies:** a say where she speaks first (above) waits `outbox.delaySeconds` (45) before it goes out. Replies go at once.
- **Cancelling:** the owner can cancel it with `/anima outbox cancel <id>` or `cancel <id>` on the owner line. A cancelled say returns `anima/outbox-cancelled`.
- **While the platform is offline,** it waits up to `outbox.offlineHoldMinutes`, then expires.

### Owner commands

`ctx.commands` command `anima`, no model turn:
- `status`, `pause`, `resume`, `wake` (her body records the waking; her waking session opens with her inbox);
- `self [text]` (with text, the owner's words reach her waking session and start a turn);
- `goal add|list|close`, `inbox`, `outbox [cancel <id>]`, `approve <id>`, `deny <id>`;
- `memory list [text]`, `memory forget <id>`;
- `selfmodel [revert <id>]`.

### Memory and persona management

The owner can browse, search, edit and delete memories (active, archived, superseded), revert self-model diffs, and edit the persona card. These act on her from outside: she is not told, and it is not her forgetting.

### Activity log

`<dataDir>/activity/<her day>.jsonl`: every gate decision, every delivery that starts a turn, every owner action with its source, platform health changes, inbox holds and answers, falling asleep and waking, and each waking session's id. Recording never decides anything.

## `anima-page`

An Anima entry in DSH's web UI sidebar with tabs: Status, Persona, Memory, Goals and approvals, Activity, Platforms, Settings.
- **Host half:** owner-only routes `GET /api/anima/view` and `POST /api/anima/action`.
- **Browser half:** a bundle on DSH's client slots, built with esbuild.
- **Owner surface:** every view and action is a named owner view or action on `anima-guard`. The page and the commands call the same ones.
- **Settings** save through DSH's config editor into the active profile's patch.

## DSH

- DSH's own guards (loop and runaway-tool protection), its sandbox for her workspace, and its review features.
- **Session-log upload** to DeepSeek is off in development profiles (`session-log-deepseek` `enabled: false`). Real chats with other people flow through her session.
