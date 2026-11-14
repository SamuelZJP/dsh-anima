# Outside the persona

Safety and management act on her from outside, like shackles and an operating table. They live in `anima-guard` and `anima-page`, or in DSH itself. Persona packages never import them; unloading `anima-guard` leaves her running, unrestricted.

## `anima-guard`

### The gate

One listener on DSH's `tools/pre-execute` waterfall checks every behavior call and calls `next()`. It reads behavior metadata (`effect`, `target`, `facts`) and her state through the persona's services. Defaults:

| Check | Default |
|---|---|
| **Allowlist** | Only listed QQ users and groups and the owner. Adapters drop other chats' events, and calls toward them are refused (`anima/not-allowlisted`, `anima/unknown-channel`) |
| **Consent to initiate** | She may speak first only on the owner's channels and channels listed in `consent` (`anima/no-consent`) |
| **Approval** | `public` and `irreversible` calls, and behaviors listed in `approve`, wait for the owner (below) |
| **Rate limits** | Per channel, platform or day, set in `quotas`; none by default except platform protection (`qq_*` and `bili_*` rates, close-view `limits` on video length and frames) |
| **Token budget** | Daily cap on billable tokens (default 300,000 by day, 20,000 at night) |
| **Pause** | Refuses everything except calls that only close a turn |

- **A refusal tells her what happened,** in her language, as something done to her from outside, never as her own choice: `<code>: <hint>`. The code is also in the structured error for the log and the page.
- **Quota counters** persist in `<dataDir>/guard.json`.

### Approvals

- **The owner line** is the owner's private chat on a platform that provides one (QQ; the local adapter in development).
- **A held call** sends `[Anima approval a3] … Reply "yes a3" or "no a3".` The owner's `yes`/`no <id>` is consumed by the guard and never reaches her. No answer within `approvals.timeoutSeconds` (600) means denied.
- **Friend requests** use the same flow; accepting one does not add the person to the allowlist.

### Outbox hold

- **When it applies:** a message she sends first, toward someone who did not write to her, waits `outbox.delaySeconds` (45) before it goes out.
- **Cancelling:** the owner can cancel it with `/anima outbox cancel <id>` or `cancel <id>` on the owner line. A cancelled say returns `anima/outbox-cancelled`.
- **While the platform is offline,** it waits up to `outbox.offlineHoldMinutes`, then expires.

### Owner commands

`ctx.commands` command `anima`, no model turn:
- `status`, `pause`, `resume`, `wake`, `heartbeat`;
- `goal add|list|close`, `inbox`, `outbox [cancel <id>]`, `approve <id>`, `deny <id>`;
- `memory list [text]`, `memory forget <id>`;
- `selfmodel [revert <id>]`.

### Memory and persona management

The owner can browse, search, edit and delete memories (active, archived, superseded), revert self-model diffs, and edit the persona card. These act on her from outside: she is not told, and it is not her forgetting.

### Activity log

`<dataDir>/activity/<her day>.jsonl`: every gate decision, every waking delivery, every owner action with its source, platform health changes, unclosed turns, inbox holds and answers, sleep and waking. Recording never decides anything.

## `anima-page`

An Anima entry in DSH's web UI sidebar with tabs: Status, Persona, Memory, Goals and approvals, Activity, Platforms, Settings.
- **Host half:** owner-only routes `GET /api/anima/view` and `POST /api/anima/action`.
- **Browser half:** a bundle on DSH's client slots, built with esbuild.
- **Owner surface:** every view and action is a named owner view or action on `anima-guard`. The page and the commands call the same ones.
- **Settings** save through DSH's config editor into the active profile's patch.

## DSH

- DSH's own guards (loop and runaway-tool protection), its sandbox for her workspace, and its review features.
- **Session-log upload** to DeepSeek is off in development profiles (`session-log-deepseek` `enabled: false`). Real chats with other people flow through her session.
