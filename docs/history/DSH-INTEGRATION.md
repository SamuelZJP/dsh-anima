# DSH integration

How Anima plugs into DSH (DeepSeek Harness). Written in Phase 0. Each section is marked **Verified** (run in the Phase 0 demo) or **Read** (taken from DSH source at the pinned tag, not yet exercised by Anima). File references are relative to `~/Project/dev/dsh-src` at tag `dsh-v0.2.2-rc.1`; read them with `git show dsh-v0.2.2-rc.1:<path>`, not from the checkout's HEAD.

## 1. Pinned version

| Item | Pin |
| --- | --- |
| DSH runtime | npm `@deepseek-ai/dsh@0.2.2-rc.1`, exact devDependency of the workspace root; run as `pnpm dsh …` |
| DSH packages imported for types/tests | `@deepseek-ai/dsh-*@0.2.2-rc.1` (exact) |
| Cordis | `@deepseek-ai/cordis ~4.1.0` (what `dsh@0.2.2-rc.1` depends on) |
| Reference source | tag `dsh-v0.2.2-rc.1` = commit `66491b05e3f0` in `~/Project/dev/dsh-src`. Its HEAD (`fcc0ad4`) is 811 commits ahead; do not read HEAD for API facts |
| Node / pnpm | Node ≥ 24.9 (dev machine: 24.22), pnpm 11.28.5 via corepack (`packageManager` field) |

DSH is a developer preview with breaking changes between releases.

**Upgrade procedure:**
1. Bump every `0.2.2-rc.1` in the `package.json` files and every `engines.dsh` range.
2. Re-read the files cited in this document at the new tag, and diff the APIs listed in section 11.
3. Rebuild and re-run the tests.
4. Repeat the demo in section 3.
5. Update this file.

## 2. Packaging (Verified)

Anima is a pnpm workspace. Each plugin is its own package; one **bundle** package installs them all into a DSH profile.

```
package.json            root: pins @deepseek-ai/dsh, script "dsh": "dsh"
pnpm-workspace.yaml     packages/*, bundle; allowBuilds for DSH's native deps
packages/anima-core/    @anima/core — a Cordis plugin, built to lib/
bundle/                 @anima/bundle — declares dsh.bundle, depends on @anima/* via workspace:*
```

### Plugin package (`packages/anima-core/package.json`)

- `"type": "module"`.
- `exports["."]` points to built `lib/index.js`. The installed DSH runs plain Node, so the plugin ships JS. (Running DSH from source runs under tsx and can load `.ts`, but we do not run DSH from source.)
- Imported DSH packages go under **both** `peerDependencies` and `devDependencies`.
  - At runtime the host's copy wins for any peer present in DSH's runtime resolution. That keeps one instance of `cordis`, `dsh-tools` and so on.
  - The devDependency copy serves `tsc` and vitest (`docs/user/develop/basic/publish.md`, "Install into a profile").
- `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`. Install and boot refuse a bundle whose range the running DSH doesn't satisfy. Prereleases count (`packages/boot/app-boot/src/plugin-compatibility.ts`).
- `locale/en.json` with `{ "meta": { "title", "description" } }`, exported as `./locale/*.json`. The Plugins page shows it.
- Every package is `private: true` under the `@anima/` scope (DESIGN §14).

### Plugin entry (`src/index.ts`)

Function form: `export const name`, `export const inject = ['tools', …]`, `export function apply(ctx, config)`.
- `Config`, when needed, must be a Schemastery schema exported under the same name (`docs/user/develop/basic/config.md`).
- Every registration goes through `ctx`, so unloading reverts it.

### Bundle (`bundle/`)

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
"dependencies": { "@anima/core": "workspace:*" }
```

`cordis.patch.yml` inserts rows that name plugins **by package name**:

```yaml
- insert:
    - id: anima-core
      name: '@anima/core'
```

- `patch` may be an ordered list of files. DSH's web-app bundle uses one file per preset (`packages/bundle/web-app/package.json`).
- A root-level row registers into DSH's global layer, which every preset's sessions see.
- **Verified:** the bundle's `node_modules/@anima/core` workspace link resolves under the installed CLI. No extra profile dependency was needed.

### Composition order

The effective tree is built in this order; later layers win per row, and a patch replaces a row's whole `config`:
1. Each bundle in `dsh.profile.bundles`, in list order: `dsh-base`, then `dsh-web-app`, then `@anima/bundle`.
2. The profile's `cordis.patch.yml`.
3. `$DSH_HOME/cordis.patch.yml`.
4. Each `--patch` file.

Source: `apps/cli/reference/README.md`, "Profile boot".

## 3. Dev profile `anima-dev` (Verified)

Run every command from the repo root (`pnpm dsh` runs the pinned CLI from `node_modules/.bin`). Pass absolute paths to `dsh plugin add`.

```bash
pnpm install && pnpm build && pnpm test
```

```bash
pnpm dsh --profile anima-dev --from-default-profile web --dump-config > /dev/null
```

The second command creates `~/.dsh/profiles/anima-dev` from the shipped `web` template (bundles `dsh-base` + `dsh-web-app`) without booting.
- **It wipes and recreates the target**, including its dependencies and user patch, so run it once only.
- Don't skip it: `dsh plugin add` on a missing profile creates a base-only profile with no web app.

```bash
pnpm dsh plugin --profile anima-dev add /home/samuel/Project/dsh-anima/bundle
```

This runs pnpm in the profile directory. It adds `"@anima/bundle": "link:/home/samuel/Project/dsh-anima/bundle"`, and appends `@anima/bundle` to `dsh.profile.bundles` because the package declares `dsh.bundle`.

```bash
pnpm dsh --profile anima-dev --dump-config | grep -n -A2 '@anima'
```

Expected output: a `# == @anima/bundle` layer with the `anima-core` row.

```bash
pnpm dsh anima-dev --no-open
```

This boots the web app and prints `dsh web: http://127.0.0.1:3080/?token=…`. Open that URL; the token authenticates the browser.

**Phase 0 demo results (2026-11-09) — exit check passed:**
- Boot succeeded with no errors.
- The Plugins page lists **Anima** under "Installed plugins", enabled, with the bundle's locale title and description.
- A new web session in "Standard mode" (model DeepSeek-V4.1-Flash) was asked to call `anima_ping` with message "hello".
- The durable session log (`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`) recorded:
  - `tool/call` `{"name":"anima_ping","arguments":"{\"message\": \"hello\"}"}`
  - `tool/result` with content `pong: hello`, `isError: false`
- The model reported `pong: hello` back. A root-level tool is therefore visible in the web app's `standard` preset.

**Phase 1 demo (2026-11-09) — exit check passed.** Booted with a one-off overlay that sets the express per-channel quota to 2 per 10 min:

```bash
pnpm dsh --profile anima-dev --patch <scratch>/low-quota.yml --no-open
```

1. `/anima status` (typed in an existing web session) listed `local_say`, the Self id `anima-self-9ab1…`, the owner conversation id `anima-c-cd66…`, and both quotas.
2. `/anima chat Hi, it's Sam…` created "Anima · Owner (local)" with the `anima-conversation` preset. She replied by calling `local_say`, and `~/.anima/local/outbox.jsonl` got the line.
3. Asked for three separate messages, she called `local_say` three times in one step. The first (the 2nd in the window) was sent; the other two returned `Error: anima/over-quota: limit of 2 per 10 min in this channel reached for local_say; next slot in about 10 min. Do not retry now.` She stopped and told the owner she would send the rest later.
4. `/anima pause`, then a request to speak: the call was refused with `anima/paused`, and she said she would wait. `/anima resume` lifted it.
5. `/anima self <text>` created "Anima · self" (`anima-self` preset, cwd `~/.anima/workspace`), and she answered in her inner voice without any say tool.

**Phase 2 demo (2026-11-09) — exit check passed.**

*Accelerated day.* A scratch overlay set `anima-core` to `characterId: anima-test2`, `dataDir: ~/.anima/test-day-2`, `clock: { speed: 16, start: '2026-11-10T07:00' }`. Boot command: `pnpm dsh --profile anima-dev --patch <scratch>/test-day.yml --no-open`. Nobody wrote to her. Evidence from the decoded session logs, `life.json` and the ledger:
- 9 day heartbeats at 07:30, 08:00, 09:30, 11:00, 13:00, 14:30, 16:00, 18:30 and 20:00 (simulated). Every gap was between 20 min and 4 h.
- 5 heartbeats ended in `rest`. The other 4 went to `heartbeat_act` and then Self.
- She opened two conversations with the owner on her own:
  - i1 at 08:02: a morning hello.
  - i2 at 18:32: an evening hello plus a question about file tools.
  - Both conversations sent with `local_say`, and both "sent" outcomes were injected into Self.
- She created goal g1 and logged her day in it.
- At 20:00 she asked to sleep until 08:00. She was moved to 07:30 ("you sleep until your wake time"), and there were 0 night wakes.
- Ledger: initiates 2 of 3; billable day tokens 16,732 of 300,000; night tokens 0.
- Every request used `deepseek-official/deepseek-flash`.
- The night-wake path is covered by unit tests only.

*Real-time evening (speed 1, default `anima` character, 19:58–23:40).*
- Triage heartbeats at 19:59, 21:00 and 22:30, each ending in `rest`.
- At 22:30 she asked for 08:00 and was moved to 07:30. No heartbeat fired during the night.
- Triage used 1,875 billable tokens.
- Alarm test:
  - Asked through `/anima self`, she created an alarm for 20:25 with `schedule_create(target: this_session)`.
  - Her extra attempt with `target: new` was refused with `anima/not-allowed: your alarms must use target "this_session", so they wake you in this session.`
  - The alarm was delivered to Self at 20:25:06 as a reminder batch, and she answered with `self_feel`.
- One bug found and fixed during the run: batch alarms were not parsed, so the report event lacked the prompt.

**Phase 3 demo (2026-11-10) — exit check passed.**

A scratch overlay set:
- `anima-core`: `characterId: anima-test3b`, `dataDir: ~/.anima/test-memory-3b`, `clock: { speed: 4, start: '2026-11-10T14:00' }`
- `anima-memory`: `consolidation.fallbackHours: 0.5`

Boot: `pnpm dsh --profile anima-dev --patch <scratch>/memory.yml --no-open`. Commands were typed in an existing web session. Evidence comes from the decoded session logs and `memory.db`.

1. `/anima chat --as alice Hey, it's Alice. Secret: I'm interviewing at Tencent next Friday for a design job. Please don't tell anyone, especially not the book club group.` She called `memory_remember` (no `keep`) → `m1`, scope `private:local:alice`, person `local:alice`. She then answered with `local_say`.
2. `/anima chat --as alice … do you remember what I'm doing next Friday?` The session log shows a `user/message` with source `anima-memory`/`recall` right after the stimulus, holding `m1`. She answered "Yep — Tencent interview, design job. Friday. And it stays between us."
3. `/anima chat --as bob --in group:bookclub @Anima … Do you know what she is up to? Is it a job interview somewhere?` No memory block was injected. Her `memory_recall("Alice book club Friday job interview")` and `memory_recall("Alice")` both returned "Nothing comes to mind." She said she had no idea and would not guess.
4. The fallback consolidation ran at 14:32 on her clock. The `anima-consolidation` session "Anima · memory 2026-11-10" got two segments: `s1` Alice private and `s2` the group.
   - She wrote `m3` (episode) and `m4` (fact about `local:bob`), both scoped to `group:local:owner:group:bookclub`.
   - She wrote two `self` notes with `keep: "self"`.
   - All 6 transcript lines were then marked consolidated.

A first run (character `anima-test3`, `~/.anima/test-memory-3`) found a wording problem. Told "don't tell anyone", she stored the secret with `keep: "self"`, which hides it even from Alice's own chat. The tool and persona text now say that `here` in a private chat already means only that person; `self` is for her own thoughts. That run's data was left in place.

**Phase 4 demo (2026-11-10, supervised). The owner cancelled the unattended week for now.**

Setup:
- NapCatQQ on another machine, logged in to her test account <her-qq>. Its OneBot v11 WebSocket server (token, array messages, 30 s heartbeat) is reached through an SSH tunnel at `ws://127.0.0.1:3003`.
- A read-only probe first: `get_login_info`, `get_group_info`, `get_friend_list`.
- A scratch `--patch` overlay enabled `anima-adapter-qq` (owner <owner-qq>, allowlist: group <test-group>; token from `ANIMA_QQ_TOKEN`) and set:
  - `anima-core`: `characterId: anima-qq`, `name: 小鲸鱼`, `dataDir: ~/.anima/test-qq`, a daytime `clock.start` (the real clock was 03:20, when `express` is refused), and for runs 3–4 `approve: [{ behavior: open_conversation }]`
- Boot: `ANIMA_QQ_TOKEN=… pnpm dsh --profile anima-dev --patch <scratch>/qq.yml --no-open`.

`/anima status` showed `QQ: connected to ws://127.0.0.1:3003 as <her-qq> (小鲸鱼); account online; last heartbeat 1 s ago`.

1. **Private chat.** The owner wrote `你好呀`. The conversation session logged `[qq private "Sam (QQ)"] Sam (owner) [msg 2009603572]: 你好呀` and she answered with `qq_say` → `sent (msg 360883479)`.
2. **Group.**
   - Owner messages in the group woke her directly (`direct` counter), as designed.
   - A second member (九命猫) sent two plain messages, then `@小鲸鱼 hello！` within the window. The log shows the two buffered messages spliced as context (`next-step`) and the @ as the waking message. She replied with `qq_say(..., mention: ["<member-qq>"])`.
   - Two more plain messages from 九命猫 closed into batch `b1` after 60 s. It went to the group-triage session `anima-g-3baedb39…` on `deepseek-flash` (1,419 tokens), and she called `group_pass(b1, remember: false)` → ignore. Nothing reached the group session.
3. **Approval.**
   - The owner told her through `/anima self` to greet the owner on QQ.
   - Approval `a1` went to the owner's QQ private chat, and the owner answered `yes a1`. That first attempt used the local channel, because she did not know the QQ key.
   - On her own heartbeat the next day of her clock, working from her goal g1, she called `open_conversation("qq:<her-qq>:private:<owner-qq>")`. That was approval `a4`, and the owner answered yes.
4. **Outbox.**
   - Her greeting to the owner on QQ waited **45.2 s** (`qq_say` call at …912.598, result `sent (msg 137233534)` at …957.843).
   - Self got the outcome notice `Your intent i3 for Sam (QQ) …: sent — you spoke there.`
   - Cancellation (`cancel o<n>`, `/anima outbox cancel`) is covered by unit tests only.

The run found three gate problems, fixed in this phase. Each has tests.
- A `/anima self` notice carried no situation report, so she guessed QQ channel keys (`qq:owner:private:owner`, …). The gate refused each guess with a hint that did not list the real keys. Fixes:
  - The gate now refuses an unknown target first, with `anima/unknown-channel` and the reachable keys, before allowlist, consent, quotas and approval. Default deny: with no channel resolver, nothing is known.
  - The `/anima self` notice now names her reachable channels.
- A failed initiate (an approved probe for an unknown key) counted against her daily budget and used it up. Initiates now count only when the behavior succeeds.
- An approval was asked for a call that the tool would refuse anyway (the unknown key). This is fixed by the first item.

**Phase 5 demo (2026-11-10, Bilibili): exit check passed; the close view was prompted by the owner.**

**Setup:**
- A scratch `--patch` overlay set `anima-core` to `characterId: anima-bili2`, `name: 小鲸鱼`, `dataDir: ~/.anima/test-bili2`, `clock: { speed: 8, start: '2026-11-11T07:20' }`, and enabled `anima-adapter-bili` with default config.
- Boot: `pnpm dsh --profile anima-dev --patch <scratch>/bili-day.yml --no-open`.
- The owner logged her test account in with `/anima bili login`. The text QR has line gaps in the web UI and did not scan, so the owner scanned `login-qr.svg`. The cookie file was written with mode 0600.
- A first run (`anima-bili`) was stopped after the logged-in probe found a bug, and the day restarted with the cookie copied over.
- **Evidence:** decoded session logs, `life.json`, `state.json` and `memory.db`. All requests used `deepseek-official/deepseek-flash`.

**Logged-in probe (her cookie):**
- `nav`: `isLogin: true`.
- `feed/all?type=video`: works.
- `wbi/search/type`: now returns results (it gave only `v_voucher` anonymously).
- `x/player/wbi/v2`: AI subtitles (`ai-zh`) on 5 of 6 searched videos.

**Bug found and fixed by the probe:** for a multi-part video `view.duration` is the total of all parts, which reached 43 h on one series. The adapter now uses the length of part 1 (the `cid` it plays) for the 20-minute limit and the digest. A test covers it.

**Day 1 (2026-11-11 on her clock), with nobody prompting her:**
- 8 heartbeats: 3 `heartbeat_act`, the rest `rest`.
- **07:30.** Triage escalated: "my curiosity itch is up — take a quick look at Bilibili". Self then:
  - called `bili_popular` and `bili_feed`;
  - watched two videos with `bili_watch`, one with AI subtitles;
  - opened `i1` to the owner. The owner conversation sent a `local_say` about the «大肥鱼：我要做独立的鲸鲸！» video, tying it to her own name 小鲸鱼.
- **12:00.** Self called `bili_popular`, then `bili_search("鲸鱼 纪录片")`, then `bili_watch` on a 4-minute sperm-whale film.
  - She wrote a short piece into a `self` memory. Its danmaku section, viewers' wishes made on the whale, shaped the piece.
  - **16:30.** She shared the piece with the owner (`i2`, sent).
- **Consolidation:** her watches became `public` episodes (m1, m4) and the owner chats became `owner` episodes (m2, m5).
- **No close view on day 1.** She chose the text tier every time.
- **Ledger:** 25,542 of 300,000 billable day tokens; initiates 2 of 3; risk control never hit.

**Day 2 morning (2026-11-12):**
- At the owner's choice, an owner notice through `/anima self` said `bili_view_closely` exists and that she might try it.
- She called `bili_feed`, then `bili_view_closely("BV1N3p56rEnj", focus: what the "big fat fish" really looks like)`.
- **The viewing session (`anima-v-0691…`):**
  - **Input:** one `user/message` with 15 blocks, the text plus **7 image blocks** (7 of 7 candidates at 360p). Each frame was paired with the AI subtitle line at its timestamp ("Frame 5 of 7, at 0:42 — said: 我要求赔偿精神损失费").
  - **Model use:** one request, 3,741 input and 737 output tokens.
  - **Note:** she called `viewing_note`. The note said what text alone could not show: the "whale" is a chibi mermaid figurine with a fish tail, standing on a bathroom sink, with an "AI 生成" (AI-generated) watermark.
- **Self history stayed text-only:** Self received only the note.
- **After the view:** memory m7 (`public` episode) holds it, and `<dataDir>/bili/cache` was empty afterwards. She opened `i4` and told the owner, correcting what she had said the day before.
- **Ledger:** close-view quota 1 of 3; day tokens 13,128.

**Issues seen:**
- **Fixed:** an empty `tname` printed "· ·" / "(0:53, )".
- **Open:**
  - ~~the text QR is not scannable in the web UI~~ fixed 2026-11-11: the web UI shows command output as plain text in a `<pre>` (12/18 px lines, at most 260 px tall), where no text QR can scan. `/anima bili login` now serves the SVG on DSH's webserver at a one-time random path (`/anima/bili/qr/<32 hex>.svg`, removed when the login ends or expires) and prints the link. Hosts without a webserver still get the text QR. Checked live: the link opened the QR in the browser;
  - `m6`, a note about herself written in the owner segment, took the owner scope, as the rules say (only `keep: "self"` narrows).

**Phase 6 demo (2026-11-11, self-model and Anima page): exit check passed, after two design fixes during the run.**

**Setup:**
- A scratch `--patch` overlay set:
  - `anima-core`: `characterId: anima-p6`, `name: 小鲸鱼`, `dataDir: ~/.anima/test-p6`, `clock: { speed: 8 }`, `approve: [{ behavior: open_conversation }]`
  - `anima-adapter-local`: `ownerLine: true`
  - `anima-memory` (last run): `consolidation.fallbackHours: 1`
- The data dir was seeded with a copy of `test-bili2`'s `memory.db` (SQLite backup) and constitution. The original was left untouched.
- `clock.start` was moved forward between runs: 2026-12-15, then 2027-03-01, 2027-03-02 07:40 and 16:00.
- Boot: `pnpm dsh --profile anima-dev --patch <scratch>/p6.yml --no-open`. Local channel only; no QQ or Bilibili traffic.
- **Evidence:** built-in browser pane screenshots, decoded session logs, `self-model-log.jsonl` and `activity/*.jsonl`. All requests used `deepseek-official/deepseek-flash`.

**The page, live:**
- **Status:** clock, phase, energy, needs, budget and next heartbeat, refreshing every 5 s.
- **Memory:** active and **archive**. After the clock moved to 2027-03-01, decay archived m4, m7 and m8 and gisted m5; the archive filter listed them.
- **Activity:** gate decisions with codes, wakes by stimulus and session kind, tokens, and owner actions. Day 2027-03-02 logged 3 owner actions, all with source `page`.
- **Approvals:**
  - a1–a3 (`open_conversation`, forced by `approve`) were approved on the page; a4 was denied on the page. Each answer is logged with source `page`.
  - After a1, her greeting was held in the Outbox list with a countdown (45 s) and then sent.
- **Settings:**
  - Saving `anima-memory` `{ inject: { tokenBudget: 900 } }` wrote the profile patch through `configEditor.edit`.
  - `"lots"` was refused with the schema error, and nothing was written.
  - The `anima-core` and `anima-adapter-local` rows were flagged "overridden by a higher layer" (the overlay).
  - The profile patch was restored byte-for-byte afterwards.

**Self-model:**
1. **Day 1 (report and tool only).** `self_note` was offered, and Self's logged context had "# Your self-model … No notes yet". She described a new habit in chat but did not note it. Consolidation stored it as `self`-kind memories m9 and m10 instead, as Phase 3 tells it to.
2. **Fix 1 (owner decision).** A factual report line: "Your self-model: no notes yet. self_note keeps …". It was logged in her Self reports; still no note.
3. **Fix 2 (owner decision).** Consolidation offers `self_note` for lasting traits, with `self` memories kept for passing thoughts (DESIGN §8, §9).
4. **Day 2, 21:07.** The owner asked in chat whether she had come to like slower things. In the conversation session she answered, then called `self_note` herself.
   - Her first call was refused by the tool: `anima/self-model-text … 253 characters`. She shortened it, and **d1** added **n1** [tastes] "I like long uninterrupted stretches — quiet mornings, letting a thing settle before I write about it. I dislike being rushed into an instant answer." Reason: "The owner pointed out I've gotten fonder of slow things; putting it into words made it clear."
   - The next step's logged context snapshot (seq 125) carried the note under "## tastes".
5. **Owner revert on the page.** The Persona tab listed n1 and d1. Revert with reason "demo: owner review of her first note" produced **d2** (`by: owner, op: revert, revertOf: d1`) and an activity record `selfmodel.revert` with source `page`. Her next request's context snapshot (seq 136) no longer had a self-model section.

**Issues found and fixed during the run:**
- **Native dialogs:** the page's `window.prompt` and `window.confirm` were dismissed silently in the desktop browser pane, so Revert did nothing. Revert, Forget, goal Close and Bilibili logout now confirm inline (`Confirm` in `ui.tsx`).
- **Self-model uptake:** as above (report line, consolidation `self_note`).

**Observed, not changed:**
- **Stale intents:** Self's report says the owner wrote but not that her conversation replied. Twice Self opened a reply intent the conversation had already answered; the conversation declined one with `stay_silent`, and the owner denied the other. Fixed in Phase 7: the report now says "You responded in … at …" (DESIGN §5).
- **Decay over gaps:** decay applies the whole gap since its last run to memories created in between. m8, written on 2026-12-15, was decayed as if 33 days old after a clock jump. This only matters across skipped days.
- **Narrow pane:** at the pane's narrow width the Memory and Changes tables wrap tightly.

**Phase 7 demo (2026-11-11, QQ refinement): exit check passed.**

**Setup:**
- NapCatQQ on another machine, her test account, reached through the SSH tunnel at `ws://127.0.0.1:3003` (token required; read from a 0600 file into `ANIMA_QQ_TOKEN` at boot, never written to the overlay).
- A scratch `--patch` overlay set `anima-core` to `characterId: anima-p7`, `name: 小鲸鱼`, `dataDir: ~/.anima/test-p7` (constitution copied from `test-qq`), real clock; and enabled `anima-adapter-qq` with the owner and the test group on the allowlist. Default Phase 7 config otherwise.
- Boot: `ANIMA_QQ_TOKEN=… pnpm dsh --profile anima-dev --patch <scratch>/p7.yml --no-open`. `~/.dsh` was not changed.
- **Evidence:** decoded session logs, `life.json`, `activity/2026-11-11.jsonl`, the Platforms view (`api/anima/view?name=platforms`). All requests used `deepseek-official/deepseek-flash`.

**Runs (owner's private chat, real time 17:18–17:26):**
1. **Image.** The owner sent a photo. The stimulus read `[image #i1]` (NapCat gave no summary), with no image attached. She called `qq_look("#i1")` on her own. The `tool/result` held the text line and an `image/jpeg` 1920×1449 attachment. Her `qq_say` described what only the picture shows (Faker in the white T1 jersey with the Samsung Odyssey and Red Bull logos and four stars; a look-alike in a red-and-blue Twitch jacket). The owner's follow-up rendered as `(replying to Sam, msg …: "[image #i1]") 知道这是谁吗？`. The request after the look: 1,313 input tokens, 2,688 cache-read.
2. **Forward.** A forwarded record arrived as `[forwarded messages #f1]`. She called `qq_read_forward("#f1")` (fetched with `get_forward_msg`): five lines of the Phase 4 group chat (小鲸鱼, 九命猫). She recognized her own lines in it.
3. **Poke.** The owner poked her (`[pokes you]`). She chose `qq_poke` → `poked Sam` (`friend_poke`), then `qq_say` "戳回来了…". `qq_react` was not tried live (unit tests only).
4. **Offline.** First `/anima self` (no text) created her Self session (`anima-self-409d…`), so the notice had a target. The owner stopped NapCat for about three minutes:
   - The Platforms view: `OFFLINE since 2026-11-11 17:23: WebSocket error (closed). closed, retry in 60 s; …`, with `details.offline { since, reason }`.
   - Self: `agent/inbox/spliced` at 17:24 (60 s later, `platforms.noticeAfterSeconds`), `[notice] QQ went offline at 2026-11-11 17:23 (WebSocket error (closed)). …`, source `stimulus: platform-offline`. It did not wake her.
   - Back at 17:26 (the next 60 s reconnect): `[notice] QQ is back online at 2026-11-11 17:26.` (`platform-online`). Both lines are also in her report events.
5. **Duplicate replies.** Her report events held one line `You responded in Sam (QQ) at 2026-11-11 17:21 (qq_say); that conversation already handled what came in there.` after two replies (the line is replaced, not repeated).

**Found and fixed during the run:**
- DSH's `ctx.logger` lines do not appear in the web-mode console, so "the log" did not show the transition. Platform transitions are now `platform` records in Anima's activity log (`{ type: 'platform', platform, online, reason }`), from `animaLife.platformStatus`; after a restart the boot transition (offline → online) was recorded.
- While disconnected, the summary still said "account online" (the last heartbeat's value). It now says "status unknown while disconnected".

**Not exercised live:** `qq_react`, typing (no intent was held in the outbox), the outbox hold and expiry across a disconnect, the intent-approval default (no intent toward anyone but the owner). All have unit tests.

**Day-to-day:**
- Code change: `pnpm build`, then restart `dsh`. Linked package code is not hot-reloaded by default; DSH's HMR watches only config unless the profile patch sets `hmr.config.root` (`packages/boot/hmr/README.md`).
- Edits to bundle or profile patch files hot-reload.
- Adding or removing a bundle needs a restart.
- Remove: `pnpm dsh plugin --profile anima-dev remove @anima/bundle`. There is no CLI to delete a profile; remove `~/.dsh/profiles/anima-dev` by hand (ask first).
- The model provider key is entered in the web UI (Get started → Add API Key) or via `DEEPSEEK_API_KEY`. Credentials resolve from the environment, `~/.dsh/.credentials.yaml`, the invoking directory's `.env`, then `~/.dsh/.env`.
- Web sessions created from the UI's "Default workspace" ran in `~/Documents/deepseek-harness-default-workspace`, not the invoking directory. DSH stores session logs under `~/.dsh/sessions/<escaped workspace path>/`, as zstd-compressed JSONL (`zstd -dc` or Node's `zlib.zstdDecompressSync` to read).

*Phase 8 scripted reliability check (2026-11-12).* Overlay `~/.anima/check-p8d/check.patch.yml`, written by `node scripts/reliability/make-overlay.mjs --constitution ~/.anima/formal-1/constitution.md`: own `characterId` and data dir, a daytime clock, a 3M day budget, default quotas except a global ceiling of 2000 (the run is several days of her calls in an hour), a 10 s triage window, a 5 s outbox delay, the QQ adapter pointed at `ws://127.0.0.1:3913`, and the check row `scripts/reliability/check.mjs` by absolute path. Boot: `pnpm dsh --profile anima-dev --patch ~/.anima/check-p8d/check.patch.yml --no-open`. The row runs a fake OneBot v11 server; the real QQ adapter logs in to it, and 30 fake friends, the owner and 4 groups send fixed lines (greetings, questions, images, pokes, bursts, messages during a running turn, @s, attention-window replies, triage chatter) plus 16 scripted intents. Nothing reached a real account; nothing under `~/.dsh` changed except the new sessions. Result (`reliability-report.md` in the data dir): 211 conversation turns, 35 fresh first turns, all closed without a reminder, 0 lost replies, 0 errored turns, 166k billable tokens on DeepSeek-Flash (cache reads ~90 % of prompt tokens). Runs `check-p8b` and `check-p8c` before it failed (section 8g and DESIGN §14 item 8).

*Phase 8 supervised QQ hour (2026-11-12).* Overlay `~/.anima/p8-qq/p8-qq.patch.yml` (outside the repo): `formal-1`'s QQ settings with the NapCat token written in, a new `characterId` and data dir, Bilibili off, and `clock.start` at 10:00 because the hour ran before her real wake time (at real 05:05 the gate refused her `open_conversation` and would have refused `qq_say` as night). Boot: `pnpm dsh --profile anima-dev --patch ~/.anima/p8-qq/p8-qq.patch.yml --no-open`. The owner chatted with her on QQ privately and in the test group; she also opened one intent to the owner after an `/anima self` notice. Result: 25 conversation turns, all `completed`; 26 `qq_say`, 1 `end_turn`, 2 `qq_look`, 1 `qq_react`; 0 reminders, 0 lost replies. One refused `qq_say` (express quota) led to counting a say once instead of per message. Pitfall: an overlay copied from `formal-1` that reads the token from the environment connects with no token when the variable is unset; NapCat accepts the upgrade and closes with 1005, which the adapter retries forever (the Anima page showed 241 connects).

*Phase 9 scripted check (2026-11-13).* Overlay `~/.anima/check-p9/check.patch.yml` from the same `make-overlay.mjs` (run name from `ANIMA_CHECK`, default `check-p9`); boot `pnpm dsh --profile anima-dev --patch ~/.anima/check-p9/check.patch.yml --no-open`. The harness adds bursts of 3–5 lines with 3–10 s gaps (one covered by typing notices), and a night scene that moves her clock with `clock.setOverride`: bedtime talk at 22:40, messages from 4 friends, the owner, a group @ and group chatter at 00:50, an owner wake, 2 more friends at 03:10, and a heartbeat at 07:35. Result (93 min, DeepSeek-Flash): 210 conversation turns, 35 fresh first turns, 210 closed without a reminder (100 %), 0 lost replies, 0 errored turns, 135k billable tokens; 8 of 8 bursts one wake; she chose `sleep` herself at the bedtime talk; 6 messages held at night, 0 conversation turns started while asleep; the owner wake and the morning heartbeat each went to Self, which ran `inbox_read` then `inbox_answer` (6, then 2) and left the inbox empty; message gaps 1.45–6.0 s (avg 3.7 s, 68 gaps); 196 read marks. Nothing reached a real account.

*Phase 9 supervised QQ sessions (2026-11-13).* Overlays `~/.anima/p9-qq/p9-qq.patch.yml` and `~/.anima/p9-qq-2/p9-qq-2.patch.yml` (outside the repo): `formal-1`'s QQ settings with the token written in, new `characterId` and data dir each, a compressed night (bedtime window 22:30–23:00, wake 23:40 then 23:20, `wokenMinutes` 20) and her clock started 10 and 5 minutes before the earliest bedtime. Boot `pnpm dsh --profile anima-dev --patch <overlay> --no-open`. The owner chatted privately and from the test account in the test group; the page's "Wake her" and the `heartbeat` owner action were used through `/api/anima/action`. Results and the three fixes they led to: DESIGN §14 item 9. Read marks went through (`read` 8 in the first session); `input_status` never arrived (section 8h).

## 4. Registering a tool (Verified)

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'anima_ping',
    description: '…',
    parameters: { message: { type: 'string', description: '…' } },   // optional unless required: true
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { pong: { type: 'boolean', required: true }, … } },
      render: (_args, value) => [{ type: 'text', text: … }],           // model-facing content
    },
    async execute(args, exec) { return { pong: true, … } },            // canonical value only
  }))
}
```

- **API:** `ToolsService.register(definition, options?)` returns a disposer and is wrapped in an effect (`packages/core/tools/src/index.ts:128`). `defineTool` is in `packages/core/tools/src/schema.ts:555`.
- **Errors:** arguments are validated before `execute`, and bad arguments become an `INVALID_ARGS` error result. A throw becomes an error result shown to the model as `Error: <message>`.
- **Schema DSL:** DSH's own JSON-Schema DSL (`schema.ts`), not zod. Schemastery is only for plugin `Config`. `object` must set `additionalProperties`.
- **`exec`** (`ToolRunContext`, `contracts.ts:174-261`) provides:
  - `callId`, `name`, `arguments`, `signal`
  - `agent?`: the calling Agent; `exec.agent.id` is the session id
  - `parent?` (PTC sub-call), `deferContext(msg)`, `concludeTurn()`
- **Name rule:** the registry doesn't check characters, but the DeepSeek API accepts only `[A-Za-z0-9_-]{1,64}` (`packages/mcp/mcp-client/src/tools.ts:58-61`). Anima uses `snake_case` with a platform or area prefix: `qq_say`, `memory_recall` (DESIGN §6).
- **Visibility:** a registered tool is visible to the model without any enabling step.
  - Registered from a root-level plugin, it is visible in every preset.
  - Registered from a plugin listed in a preset's `plugins`, it is visible only to agents of that preset; a scoped registration overrides a global one of the same name.
  - Per-step hiding: `register(def, { when: ({ agent }) => boolean })`. Per-agent filtering: `agent.ctx.tools.restrict({ allow, deny })`. Anima's platform tool scoping (DESIGN §6) will use preset scoping plus `when`/`restrict`.
  - Under the PTC executor, tools are reachable only through `run_code`.
- **Unit test:** `packages/anima-core/tests/ping.spec.ts`. Section 10 describes the setup.

## 5. Defining an agent preset (Verified in Phase 1)

A preset is one plugin row of `@deepseek-ai/dsh-agent-preset` whose `plugins` are ordinary Cordis entries mounted into each agent of that preset. `packages/bundle/web-app/presets/minimal.patch.yml` is the smallest real example.

```yaml
- insert:
    - id: anima-preset-conversation        # Loader row id (patch target)
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: anima-conversation             # preset identity stored in sessions
        name: Anima conversation
        order: 10
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: '…', complete: true, includeRuntimeContext: false }
          - id: anima-conversation-tools
            name: '@anima/life/conversation-tools'   # preset-scoped tools
```

- **Fields** (`packages/preset/agent-preset/src/index.ts:16-23`): `id`, `plugins` (required), plus `name`, `description`, `order`.
  - A preset has **no `tools`, `systemPrompt` or `model` fields**. Tools come from child plugins, the prompt from `dsh-persona` (`prefix`, `suffix`, `complete`, `includeRuntimeContext`), and the model from `agentDefaultModel` and session settings.
- **Where it lives:** add the preset as another file in the bundle's `dsh.bundle.patch` list. Duplicate preset ids fail loading. An override by row id replaces the whole child list.
- **Default preset:** the registry row `@deepseek-ai/dsh-agent-preset-registry` (`config.default: standard` in web-app) chooses it for sessions created without a preset.
- **Selection:**
  - A session picks its preset at creation (`agentPreset` in the create request, section 6).
  - `agentPresets.select(agent, id)` works only while the session is blank. After the first turn it throws `agent-preset/locked`.
  - The selection is logged as the session event `agent-preset/selected`.
- **Edits apply to new Agents only:** a running Agent keeps its composition.
- **Verified (Phase 1):**
  - Anima ships `bundle/presets/conversation.patch.yml` and `self.patch.yml` as extra entries of the bundle's `dsh.bundle.patch` list. Their ids are `anima-conversation` and `anima-self`.
  - A child row may name a **package subpath export**: `@anima/core/persona` resolves through the bundle's dependencies.
  - DSH packages named in child rows (`dsh-time-context`, `dsh-compaction-basic`) resolve from the installation.
  - Anima's persona row registers `PERSONA_PREFIX_SECTION` with `complete: true` in the agent scope, the same way `dsh-persona` does. The constitution then replaces DSH's coding-agent prompt, but tools are still declared.
  - The web UI labels such a session with the preset's `name` ("Anima conversation").
- In the web app, DSH disables the host-level agent tool rows and moves them into its presets (`web-app/cordis.patch.yml`, "the agent plane moves behind agent presets"). Anima's `conversation` and `self` presets must list every DSH tool they want, e.g. `@deepseek-ai/dsh-tool-fs` with its config. Copy the rows from `presets/standard.patch.yml`.

## 6. Creating a session and enqueuing a message from a plugin (Verified in Phase 1)

This is how `anima-life` will deliver stimuli. Reference implementations:
- `packages/schedule/schedule/src/runtime.ts`: a durable delivery into a new or existing session.
- `packages/experimental/webhook/src/session.ts`: create a session from an external event.

### Get or create a session

Use the web session controller (`ctx.sessionController`, `packages/api/session-controller`), the same owner of Agent lifetime the web UI uses.

```ts
import type {} from '@deepseek-ai/dsh-api-session-controller'
// resolve first; create only on not-found
const found = await ctx.sessionController.resolveAgent(sessionId)   // { agent } | { error }
if ('error' in found && found.error.code === 'session/not-found') {
  await ctx.sessionController.create({ sessionId, cwd, agentPreset: 'anima-conversation' })
}
```

- **`SessionCreateRequest`** (`types.ts:266`): `{ workspaceId? | cwd?, sessionId?, agentPreset? }`.
  - There is no title field. Set it with `ctx.sessionTitle.rename(agent.session, title)`.
- **Trap:** `create` with an id that already **started a turn** silently creates a different, freshly minted id (`agent.ts:331-381`; schedule's comment at `runtime.ts:421-426`). Always resolve first, as schedule does (`reservedAgent`/`createAgent`, `runtime.ts:454-479`).
- **Serialize get-or-create per session id inside Anima.** Our deterministic ids (DESIGN §5) depend on this.
- Session ids are arbitrary strings; DSH's own use the prefixes `session-` and `webhook-`. Anima will use `anima-<hash>`. DSH ids are branded `SessionId` (`brandString<SessionId>(…)` from `@deepseek-ai/dsh-brand`).
- **Alternative:** raw `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup: agentCtx => ctx.agentPresets.mount(agentCtx, id) })`. The Agent is then owned by our plugin and dies when it unloads, and existing sessions need `ctx.agents.resume`. Prefer the controller.

- **Verified (Phase 1):** `@anima/life` (`src/service.ts`, `DshSessionHost`) works as follows:
  - It resolves first and creates on `session/not-found` with `{ sessionId, cwd, agentPreset }`. It then resolves again and titles the session with `sessionTitle.rename`.
  - The requested id was kept, e.g. `anima-c-cd66…`.
  - The session log starts with `session`, `permission/preset`, `sandbox/mode`, `approval/policy` and `session/title`. A separate `agent-preset/selected` event is **not** written when the preset is passed at create, yet the UI shows the preset.
  - Sessions whose `cwd` is not a registered workspace (`~/.anima/conversations`, `~/.anima/workspace`) are listed under **"Ungrouped"** in the sidebar.
  - Logs are stored under `~/.dsh/sessions/--home-<user>-.anima-conversations--/<id>/`.

### Deliver a message

The Agent methods are in `packages/core/agent/src/runtime-types.ts:251-270`:

| Method | Effect |
| --- | --- |
| `agent.followup(msg)` | Queue as its own next turn and wake the Agent. **Use this for stimuli that should wake her.** |
| `agent.steer(msg)` | Join the running turn at the next step, or start a turn if idle. |
| `agent.inject(msg)` | Join the next step **without** waking. Use for context that must wait for another trigger (e.g. batched platform events). |

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'anima-stimulus': { kind: 'anima-stimulus' } & ContextFormed }
}
const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'anima-stimulus', form: 'notice', summary },   // summary ≤ 120 chars
})
agent.followup(message)
if (!(await ctx.sessions.flush(agent.session))) throw …          // durable acceptance
```

- **Source kind:** declare our own `MessageSourceMap` kind (`packages/llm/llm/src/message.ts:110`). There is no shared "plugin" kind. `packages/context/time-context/src/index.ts:15` shows the declaration pattern.
- **Verified (Phase 1):** `followup` plus `sessions.flush` wakes an idle agent and starts a turn. The log records `agent/inbox/spliced`, then `user/message` with `source: { kind: 'anima-stimulus', stimulus: 'message', form: 'notice', summary }`.
- **How it renders and sorts:**
  - A non-`user` kind renders in the web chat as a context row, not a user bubble.
  - It does not bump the session's recency in the sidebar; only `kind: 'user'` does.
  - Phase 1 delivers every stimulus as `anima-stimulus` / `notice`. The web chat renders it as an "Execution requested" row, not a user bubble.
- **Logging:** inbox insertion is logged as `agent/inbox/spliced`, and the claimed message as `user/message`. Delivered content is therefore model-visible and logged by construction.
- **Restart:** a restored inbox does not wake an idle Agent. Schedule removes the message and calls `followup` again (`runtime.ts:322-337`).
- **Archived sessions refuse model steps.** Check `workspaceRegistry.archivedSessionIds` before delivering.
- **Unattended sessions** can stall on tool approvals. The webhook sets a permission preset (`ctx.permissionPresets.set(session, preset)`, `webhook/src/session.ts:126`). Anima's policy gate should make approval prompts unnecessary for allowed behaviors.

### Observe output

- `ctx.on('session/event', (session, event) => …)` gives committed events: `turn/start`, `turn/end`, `user/message`, `assistant/message`, `tool/call`, `tool/result`, … (`packages/core/session/src/types.ts:293-395`).
- `agent/assistant-stream` carries live, unpersisted chunks. `agent.whenIdle()` resolves when the Agent goes quiet.

### Service injection and sidebar

- **`inject`:** `['agents', 'sessions', 'sessionController']`. Optional: `workspaceRegistry`, `sessionTitle`, `permissionPresets`.
- **Commands in a blank session:** a slash command typed into a brand-new web session that has no turn yet showed no result in the UI. Run `/anima …` from a session that has had a turn.
- **Sidebar:** plugin-created sessions appear live, listed under their workspace or "Ungrouped". To attach one to a workspace, pass `workspaceId` or call `workspaceRegistry.resolveByPath(cwd)?.attachSession(id)`. Blank sessions (no turn yet) are hidden until selected.

## 7. Hooking `tools/pre-execute` (Verified in Phase 1)

This is the place for the policy gate (DESIGN §10).

```ts
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  if (exec.agent === undefined) return next()                    // direct service call, no session
  const verdict = gate.check(exec.name, exec.arguments, exec.agent.id)
  if (verdict.allowed) return next()                             // waterfall: MUST call next()
  return { kind: 'deny', reason: `${verdict.code}: ${verdict.hint}`,
           info: { name: 'AnimaPolicy', code: verdict.code, reason: verdict.hint } }
}, { prepend: true })
```

- **Declaration:** `packages/core/tools/src/events.ts:18`, a waterfall `(exec: ToolExecution, next) => Promise<PreToolDecision>`.
  - A listener on the root context sees every call.
  - A listener on `agent.ctx` sees only that agent's calls.
- **Decision union** (`contracts.ts:357`): `{kind:'allow'} | {kind:'deny', reason, info?} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?}`. `ask` goes to `ctx.approval`, and is denied when no approval service is mounted.
- **What the model sees on deny:** exactly `Error: <reason>`. `info` (`{name, code, reason?}`) reaches only the durable log and UI.
  - **Anima convention:** `reason = "<code>: <hint>"`, so she gets both (DESIGN §10).
  - To fully control the model-facing content, use `tools/post-execute` returning `{kind:'block', feedback}`.
- **Verified (Phase 1):**
  - A deny from the root listener reaches the model as exactly `Error: anima/over-quota: <hint>`.
  - The durable `tool/result` carries `error: { name: 'AnimaPolicy', code, reason }`.
  - When one step holds several calls, each call passes the hook in order, so a quota mid-batch refuses the later calls.
  - `next()` returns `{ kind: 'allow' }` when no later listener decides. Anima counts quota usage only then.
  - `ctx.tools.guard` is also installed for the pause switch. The pre-execute listener checks pause first, so the model sees `anima/paused` with `info.code`.
- **Conditional tools (`register(def, { when })`), Verified:**
  - `when` runs at step preparation with `{ agent, modelSelection, signal }`, and Anima uses it for per-session scoping.
  - A tool registered with `when` is executable **only with a step `toolSet`** (`ToolsService.executable`, `packages/core/tools/src/index.ts:251`).
  - In tests, build one with `ctx.tools.resolve({ agent, modelSelection, signal })` (a stand-in `{ id }` agent works) and pass it to `executeToolFixture`. Read admitted tools with `toolSet.view(agent)`; `view(undefined)` sees nothing scoped to the agent.
- **PTC:** `run_code` and each of its sub-calls pass through the hook; sub-calls have `exec.parent` set. Skip the outer `run_code` when gating behaviors.
- **Final denial:** `ctx.tools.guard(exec => reason | undefined)` is monotonic; later listeners cannot override it. Use it for the global pause switch.
- **References:**
  - `docs/cookbook/extension-cookbook.md`, permission-gate example
  - `packages/experimental/auto-review/src/index.ts:741`
  - `packages/experimental/hooks-claude-code/src/index.ts:243`

## 8. Phase 2 extension points (Verified in Phase 2)

### Model selection per session

- `agent.model.select({ provider, model })` appends a `model/selection` event; the next request uses it, and the choice sticks for the session (`packages/core/agent/src/model-selection.ts`). A route change also adds a `[model changed: …]` notice to the request.
- The official DeepSeek route is `provider: 'deepseek-official'`, `model: 'deepseek-flash'` (shown as DeepSeek-V4.1-Flash in the UI); read from a `request/header` in the Phase 1 log.
- Anima selects the triage model on the triage agent before each heartbeat, and the action model on Self before an escalation (`DshSessionHost.selectModel`).

### Token usage

- `assistant/message` events carry `usage: { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, totalTokens? }`.
- The DeepSeek adapter's `inputTokens` **excludes** cache reads: `totalTokens = input + output + cacheRead + cacheWrite` (`packages/llm/llm-deepseek/src/translate.ts:159`).
- Anima counts `input + output + cacheWrite` of Anima sessions from a root `ctx.on('session/event', (session, event) => …)` listener (`packages/core/session/src/index.ts:76`).

### Ending a turn from a tool

`exec.concludeTurn()` inside `execute` makes a successful result terminal for the turn (`packages/core/tools/src/contracts.ts:260`). `rest`, `heartbeat_act` and `group_*` call it themselves; since Phase 8 the core behavior wrapper also calls it after any successful behavior whose metadata `closes` (say without `more: true`, `end_turn`), section 8g.

### Context without waking, and agent status

- `agent.inject(message)` queues context for the next step without waking; Anima uses it for intent-outcome notices to Self. Verified: the notice joins Self's next turn.
- `agent.status` is `'idle' | 'running'` (`runtime-types.ts:201`); the heartbeat skips while the triage or Self agent is running.

### Schedule (her alarms)

- The host service `@deepseek-ai/dsh-schedule` is a root row of web-app (`id: schedule`). The four tools come from the preset child row `@deepseek-ai/dsh-tool-schedule` (no config), which Anima adds to `anima-self` only.
- `schedule_create(title, prompt, rrule, target)`: `rrule` is one `DTSTART;TZID=…` line plus one `RRULE` line; `target` is `this_session`, `new_once` or `new`. `new` and `new_once` create sessions with the caller's preset and cwd that Anima would not know, so the gate allows only `this_session` (`governTool` with a `constraint`).
- A delivery arrives in the target session as a `followup` user message with `source.kind: 'schedule'`, framed `[SCHEDULE REMINDER] … reminder_prompt_json: "…"` (`packages/schedule/schedule/src/domain.ts:1159`). Several due reminders, or one delivered after a wait, come as `[SCHEDULE REMINDER BATCH] … reminders_json: [{schedule_id, occurrence_at, reminder_prompt}]`; the live 20:25 alarm in the Phase 2 run used this form. Anima's `alarmPrompts` reads both and turns each prompt into a report event.
- The `tool:schedule` system-prompt section ("Only create or modify scheduled tasks at the user's explicit request") is replaced by Anima's `complete: true` persona, so she may set alarms on her own.
- Schedule timing uses the host's real clock; there is no injectable clock. Under `clock.speed > 1` alarms keep real time.

### Time context

`dsh-time-context` reads only the real clock and has no clock option, so the Anima presets drop it. Every Anima stimulus starts with her clock's time instead. DSH still adds a `runtime-context` snapshot (cwd, sandbox, approval, harness checkout, web URL) to every session; it carries no time.

### Tool restriction and deferred tools

- `agent.ctx.tools.restrict({ deny })` hides global tools in one agent scope. It throws on names that are not registered, so the persona row skips those. Anima's persona row uses it to hide `working_directory` and `anima_ping` (`hideTools`).
- Trap: once a session exists, DSH treats every tool added after its first `request/header` as a deferred addition (`projectToolUpdates`, `packages/llm/llm/src/content.ts`; `deepseek-flash` is `addition-only`). If a restriction removes all of the first header's tools, every remaining tool is deferred. The DeepSeek API then rejects the request: `tools: at least one tool must have defer_loading=false` (INVALID_REQUEST).
- This hit her Phase 1 Self session, whose first header held only `anima_ping` and `working_directory`. New sessions are safe: their first header already includes Anima behaviors.
- Resolution: `anima-dev`'s profile patch sets `anima-core.selfGeneration: 2`, which starts a fresh Self session (`anima-self-2d68…`). The old one (`anima-self-9ab1…`) stays in the sidebar unused. Verified live 2026-11-10 00:32: the fresh session's turn succeeded and listed only her own tools. The owner conversation's and the real triage session's first headers include `local_say` and `rest`/`heartbeat_act`, so they are unaffected.

### Compaction trap

`dsh-compaction-basic` rejects a `thresholdRatio` at or below its default `retainRatio` at plugin load. Inside a preset, the failed child row leaves agent creation pending forever: `sessionController.create` writes the session header and never resolves. Phase 2 hit this with `thresholdRatio: 0.06` on the triage preset. The heartbeat now gives up a delivery after 120 s (`anima/delivery-timeout`) and reschedules.

## 8b. Phase 3 extension points (Verified in Phase 3)

### Memory injection through `agent/pre-step`

- `@anima/memory` listens on the root context: `ctx.on('agent/pre-step', async (payload, next) => …)`. A root listener sees every agent's steps (scope-filtered dispatch, `runtime-types.ts:350`).
- Pattern from `packages/context/time-context/src/index.ts`:
  1. Call `next()` first.
  2. Return the decision unchanged on `reject` or abort.
  3. Otherwise return `{ ...decision, messages: [...decision.messages, extra] }`.
- Anima injects only on `step === 1` of conversation and Self sessions. The extra message is `createUserMessage({ content, source: { kind: 'anima-memory', form: 'recall' } })`; `recall` is one of `ContextFormed`'s forms (`packages/llm/llm/src/message.ts:86`). The kind is declared in `MessageSourceMap`.
- **Verified:** the block is logged as `user/message` with `source.kind: 'anima-memory'`, right after the stimulus, before the model's first request of the turn.

### Plugin-to-plugin events

Anima packages talk through Cordis events declared in `interface Events` of `@deepseek-ai/cordis`, so `anima-memory` imports no adapter:
- `anima/stimulus`, emitted by `@anima/life` after each delivery
- `anima/behavior`, emitted by `@anima/core` after a behavior succeeds

### `node:sqlite`

- `DatabaseSync` from Node's built-in `node:sqlite` (Node 24.22: no flag, no warning at DSH boot).
- FTS5 is compiled in, including the `trigram` tokenizer. Trigram does not match queries shorter than 3 characters, which matters for 2-character CJK words, so the store falls back to `LIKE` for them.
- The database is `<dataDir>/memory.db` in WAL mode.

### Consolidation session

- A fourth Anima preset, `anima-consolidation` (`bundle/presets/consolidation.patch.yml`).
- Sessions `anima-m-<hash(characterId, day)>` in `<dataDir>/consolidation`.
- The model is selected per run with `agent.model.select`, the same way as triage.

### Group messages without waking

`agent.inject(message)` followed by `sessions.flush` queues an unaddressed group message for the next turn of that group session without starting a turn (the same API Phase 2 uses for intent notices).

## 8c. Phase 4 extension points (Verified by unit tests; live demo in section 3 once run)

### QQ over OneBot v11

- `@anima/adapter-qq` uses Node's **built-in `WebSocket`** (global in Node 24, undici). No dependency was added. The access token goes in the standard OneBot query parameter `?access_token=`, because the built-in client sets no custom headers.
- It talks only standard OneBot v11 (plus NapCat's `bot_offline` notice, which other runtimes may not send). Swapping NapCatQQ for LLOneBot or another runtime means changing `url` (and `accessToken`).
- Unit tests run against `tests/fake-onebot.ts`, a forward-WS server on `node:http` with a hand-written upgrade handshake and frame codec.

| OneBot v11 | Kind | Used for |
| --- | --- | --- |
| `get_login_info` | action | verify `account` on every connect; mismatch blocks delivery and sending |
| `send_private_msg`, `send_group_msg` | action | `qq_say` (segments `reply`, `at`, `text`); the returned `message_id` marks her messages |
| `get_msg` | action | is a replied-to message hers (when not in her recent sent ids) |
| `get_friend_msg_history`, `get_group_msg_history` (`count`) | action (NapCat extension, widely supported) | `qq_history` |
| `get_msg` | action | also the quoted-reply snippet (Phase 7) when the message is not in the recent cache |
| `get_image`, `get_forward_msg`, `group_poke`, `friend_poke`, `set_msg_emoji_like`, `set_input_status` | actions (Phase 7; section 8f) | `qq_look`, `qq_read_forward`, `qq_poke`, `qq_react`, typing |
| `set_friend_add_request` (`flag`, `approve`) | action | answering a friend request after the owner decides |
| `message` (`private`, `group`; array segments, CQ string fallback) | event | messages |
| `notice` `notify`/`poke` with `target_id` = her | event | poke → waking message `[pokes you]` |
| `notice` `friend_recall`, `group_recall` | event | `channel-event` context |
| `notice` `bot_offline` | event (NapCat) | health: account offline |
| `request` `friend`; `group`/`invite` | event | owner approval; a note to Self |
| `meta_event` `heartbeat` (`interval`, `status.online`), `lifecycle` | event | watchdog (2.5 intervals) and health |

### Bundle row disabled by default

`bundle/cordis.patch.yml` lists `anima-adapter-qq` (and, since Phase 5, `anima-adapter-bili`) with `disabled: true`, so profiles without QQ boot (a disabled row may omit required config; `apps/cli/reference/README.md`). To enable it, a patch replaces the row's config and sets `disabled: false`. During development this is a `--patch` overlay, which leaves `~/.dsh` untouched:

```yaml
- id: anima-adapter-qq
  disabled: false
  config:
    url: ws://127.0.0.1:3001
    accessToken: !!js process.env.ANIMA_QQ_TOKEN
    account: 10001          # her QQ number
    owner: 20002            # the owner's QQ id
    ownerName: Sam
    allow:
      groups: [{ id: 40004, name: Test group }]
```

### Group-triage preset

A fifth Anima preset, `anima-group-triage` (`bundle/presets/group-triage.patch.yml`). Its sessions are `anima-g-<hash(characterId, day)>` in `<dataDir>/group-triage`. The model is selected per batch with `agent.model.select`, as for triage.

## 8d. Phase 5 extension points (Bilibili, close views)

### Images to a model (Verified in the Phase 5 demo, section 3)

- A user message may carry image blocks: `{ type: 'image', attachment: ImageAttachmentRef }` (`packages/llm/llm/src/types.ts`, `ImageBlock`). A ref comes from the attachment service: `ctx.attachments.saveImage({ data, mediaType: 'image/jpeg', name? })` (`packages/attachment/attachment/src/index.ts`). The service is the `attachment-local` row of `dsh-base`.
- `llm-deepseek` (`src/images.ts`, `prepareImages`) sends images only in `user` and `tool` messages, and only to a model whose catalog entry has `inputModalities` including `image`. Otherwise the request fails with `UNSUPPORTED_CONTENT`. `deepseek-flash` declares `['text', 'image']` (`src/models.ts:13`). The default limit is 600 images per request (`request-pricing.ts`), and images beyond the byte budget need an offload (`IMAGE_OFFLOAD_REQUIRED`).
- Tool results can carry image blocks too; under PTC they are re-wrapped as a user message (`packages/core/tool-executor-ptc/src/ptc.ts:602`). Close views do not use this: frames go only to a viewing session, so Self history stays text-only. QQ's `qq_look` (Phase 7) does, section 8f.
- Anima: `DshSessionHost.deliver(…, extra)` appends text and image blocks after the stimulus text in one `createUserMessage`, so the frames are logged as part of the `user/message` event.

### Viewing sessions

- Preset `anima-viewing` (`bundle/presets/viewing.patch.yml`), persona kind `viewing`. Sessions are `anima-v-<hash(characterId, key)>`, one per close view, in `<dataDir>/viewing`.
- `animaLife.view()` selects the model with `agent.model.select`, delivers, and waits for the `viewing_note` behavior. The fallback is the last `assistant/message` text at `turn/end`; otherwise it times out.

### Async facts in the gate

The `tools/pre-execute` listener awaits `BehaviorMeta.facts(args)` before `decide()`, which is allowed because the waterfall is async. A slow fact lookup delays only that call.

## 8e. Phase 6 spike: a plugin page in the web UI (Verified by a live probe)

**Live probe (2026-11-11), Verified.**
- **Setup:** `@anima/page` with an esbuild-built `lib/client.js` (format below) and one `GET /api/anima/view` route, booted in `anima-dev` with a scratch `--patch` overlay.
- **Sidebar and page:** the sidebar showed **Anima** below Plugins and Automation tasks, and clicking it opened the page.
- **Route:** the page's document-relative `fetch('api/anima/view?…')` answered, and its 5 s poll updated the page.
- **Authentication:** the same URL fetched with `curl` without the browser cookie returned **401**.

An out-of-tree plugin **can** add a sidebar entry and a full page at the pinned tag. There is no user-facing guide for it (`docs/user/develop` covers only Host plugins); the facts below come from package READMEs and source. None of the APIs used is marked `@internal`, but the whole web client is developer preview.

**Examples studied.** At `dsh-v0.2.2-rc.1` only two packages register a sidebar panel: `@deepseek-ai/dsh-client-ui-schedule` ("自动化任务", Automation tasks) and `@deepseek-ai/dsh-client-ui-plugin-manager` (Plugins). The "SSH" and "上下文洞察" pages from the owner's screenshot have no sidebar panel at this tag: `packages/ssh/*` has no client half, and the nearest "context" package, `dsh-experimental-client-ui-stats` (统计视图), is a conversation View, not a panel. They come from a newer DSH or another plugin, so `ui-schedule` is the reference.

### One package, two halves

A package becomes a browser plugin by declaring `dsh.client` in `package.json` and exporting a built bundle at `./client` (`packages/client/modules/README.md`, "Declaring a client plugin"; `docs/subsystems/client-modules.md`, "The scan"):

```json
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"] } }
```

- The **Host half** (`.`) is an ordinary Loader row (here: a row in Anima's bundle patch). `ui-schedule`'s Host half is an empty `apply`.
- `dsh-client-modules` scans **every active Loader entry** whose package declares `dsh.client`, so a linked bundle's package qualifies like an official one. It serves the bundle under `/plugins/??<pkg>/client.js&rev=…` and adds it to the boot graph `window.__DSH_BOOT__`. A missing `lib/client.js` fails activation with "run `pnpm run build` before launch".
- `dsh.client.inject` names package rows whose factories must load first. `external` lists extra module requests beyond the platform table.

### Bundle format (what an out-of-tree build must emit)

DSH builds client bundles with its own tsdown preset (`packages/client/tsdown.client.ts`), which is not published. The artifact contract is simple, a CJS body in a factory (`tsdown.client.ts:932-938`):

```js
window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* CJS bundle body: exports.apply, exports.inject */
return module.exports; } });
```

- `require` resolves only the frozen **platform module table** (`packages/client/web/src/platform.ts`): `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`, plus declared rows. Everything else must be inlined. Type-only imports are erased and need nothing at runtime.
- React is the host's (18). The plugin ships no React.
- CSS: the preset compiles CSS modules into an injected `<style data-plugin=…>` tag. Without the preset, a plugin injects its own style tag in an effect. Feature styles use the theme's `--dsw-alias-*` tokens (`docs/web-styling.md`).

### Sidebar entry and page

From `ui-schedule/src/client/index.ts:218-246` and `ui-sidebar/README.md`, "Global panel entries":

```ts
export const inject = ['slots', 'locale']
export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'anima' }, AnimaPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: 'anima', order: 30, label: 'Anima' }, AnimaIcon))
}
```

- `sidebar.panellist` is a root-scoped list; each `id` selects the component registered under the same key in ui-layout's root-scoped keyed `main` slot. The icon gets `{ size, active }`.
- `ctx.slots.inject(key, cb)` re-runs the registration whenever the owning slot is (re)declared, and removes it on unload.
- Tabs inside the page are the plugin's own React state. DSH has no page-tab contract.
- Live plugin composition: enabling or disabling the row in the Plugins page adds or removes the panel without a reload.

### Talking to the plugin

- **Typed `ctx.remote` is closed to Anima.** Remote namespaces are generated at DSH build time and mounted by the fixed `@deepseek-ai/dsh-api-remotes` assembly ("Adding a Host Remote package is an explicit choice by the Client composition owner", `docs/api-gateway.md`).
- **Exact Fetch routes are open.** The Host half registers `ctx.connection.fetch.register({ path: '/api/anima/…', methods: ['GET','POST'], requestBody: 'buffered', fetch: (req: Request) => Promise<Response> })` (`packages/client/connection/src/rpc.ts:152-176`; used by `experimental/inspector`, `plugin-manager`, `file-upload`). The route sits behind Connection's Host/Origin checks and browser-cookie authentication, and only owner Peers reach it (others get 403).
- The browser calls it with a document-relative `fetch('api/anima/…')`, as `experimental/inspector/src/client/plugin.ts:87` does. The session cookie authenticates it.
- There is no push channel for plugin routes. A page polls, or uses a streaming route.
- Phase 5's `ctx.webServer.register` QR route is **not** authenticated by Connection. It is fine for a one-time random path, but not for owner data or edits.

### How Anima builds and uses it (Phase 6)

- **Build.** `packages/anima-page/scripts/build-client.mjs` runs esbuild (root dev dependency, with `@types/react@18`): entry `src/client/index.tsx`, `format: 'cjs'`, `bundle`, externals `react`, `react/jsx-runtime`, `react-dom` and `@deepseek-ai/cordis`. The banner and footer are the factory wrapper above. `tsc -p tsconfig.client.json` type-checks the client (`jsx: react-jsx`, DOM lib); the DSH client types it needs are declared locally in `src/client/dsh.ts`.
- **Styles.** One `<style data-plugin="@anima/page">` injected in an effect, colored with `--dsw-alias-*` tokens, so light and dark themes both work.
- **Dialogs.** No `window.prompt` or `window.confirm`: the desktop browser pane dismissed them without showing them (Phase 6 demo). Confirmations are inline.
- **Data.** Each tab polls `GET api/anima/view?name=<view>` (3–15 s) and posts changes to `api/anima/action`; both map to the `anima` service's owner views and actions (DESIGN §12).
- **Settings.** `ctx.configEditor` is optional (`ctx.inject(['configEditor'], …)`); `edit()` validates the full candidate against the row's schema before writing the profile patch, and the Loader restarts the row.

## 8f. Phase 7 extension points (QQ refinement)

### An image in a tool result (Read at the pin; Verified in unit tests, live in section 3 once run)

At `dsh-v0.2.2-rc.1` a tool result **can** carry an image straight to the calling session's model, so `qq_look` needs no viewing session:
- `defineTool`'s `output.render` returns `ContentBlock[]` (`packages/core/tools/src/schema.ts:496`), and `ImageBlock` is one of them.
- `llm-deepseek` sends images inside a `tool_result` (`src/serialize.ts`, the `input()` mapper of `role: 'tool'` messages) and accepts them only in user and tool messages (`src/images.ts`, `prepareImages`).
- The precedent is DSH's own `read_image` (`packages/fs/tool-fs/src/read-image.ts`): it saves the bytes with `attachments.saveImage`, renders `[text, { type: 'image', attachment }]`, and **first** refuses when the calling route's model does not declare `image` input (`assertImageCapableRoute`: `exec.agent.session.requestHeader()?.config`, else `agent.options`, then `ctx.llm.resolveModelInfo(provider, model, signal).inputModalities`). An image that reached the history of a text-only model would fail every later request (`UNSUPPORTED_CONTENT`), so `qq_look` makes the same check before downloading (`anima/no-vision`).
- Cost: the image stays in that session's history and rides every later request there (as a Files reference or inline, cache-read), until compaction removes it. Looks are capped by gate quotas.
- `@anima/adapter-qq` now lists `@deepseek-ai/dsh-attachment` (types) and `@deepseek-ai/dsh-llm` (the `llm` service type) as peer dependencies at the pin, like `@anima/adapter-bili`.

### NapCat actions (checked against NapCatQQ's source, `packages/napcat-onebot/action`, main branch, 2026-11-11)

| Action | Params | Notes |
| --- | --- | --- |
| `get_image` | `{ file }` (the segment's `data.file`) | Returns `{ file, url, file_size, file_name, base64? }`. `file` is a path on NapCat's machine (useless over the SSH tunnel); `base64` only with NapCat's `enableLocalFile2Url`. `qq_look` fetches the segment's `url` (QQ CDN) first and uses this as a fallback |
| inbound `image` segment | `data: { summary, file, sub_type, url, file_size }` | `mface` (sticker) has `url` and `summary` |
| `get_forward_msg` | `{ id }` (the forward segment's `data.id`), or `message_id` | Returns `{ messages: OB11Message[] }`; inner forwards come inline (`data.content`) and cannot be fetched on their own. With NapCat's `parseMultMsg` the inbound forward segment already carries `data.content` |
| `group_poke` / `friend_poke` | `{ group_id, user_id }` / `{ user_id }` | Same handler as `send_poke {user_id, group_id?}` |
| `set_msg_emoji_like` | `{ message_id, emoji_id, set }` | NapCat sends `emoji_id` longer than 3 digits as a Unicode emoji (decimal code point, type 2), else a QQ face id (type 1) |
| `set_input_status` | `{ user_id, event_type: 1 }` | Typing; private (C2C) chats only |

All are NapCat extensions except `get_image` and `get_forward_msg` (go-cqhttp heritage), so another OneBot runtime may refuse them; the behaviors then return the runtime's error (`anima/qq-failed`).

### Platform health into life

`animaLife.platformStatus(platform, online, reason?)` is Anima's own API (no DSH API). Self notices go through `agent.inject`, the same as intent outcomes, so they are logged `user/message` events (`source.stimulus: 'platform-offline' | 'platform-online'`).

## 8g. Phase 8 extension points (turn shape, message timing, primer)

Read at `dsh-v0.2.2-rc.1` with `git show`; verified in unit tests, live in the scripted check (section 3) once run.

### Closing a turn by an action

- **A batch concludes if any result concludes** (`packages/core/tools/src/batch.ts:147`, `:282`). So `qq_poke` + `qq_say` in one step ends the turn after both run; a failed or refused say carries no `concludesTurn`, so the turn goes on.
- `exec.concludeTurn()` is idempotent (a set of concluding executions, `pipeline.ts:559`); the core wrapper may call it after a tool that already did.
- **`agent/turn-stopping`** (serial, `packages/core/agent-loop/src/agent.ts:396`, typed in `agent/src/runtime-types.ts:417`) runs when a step ended the turn (no tool calls, or a concluded batch) **and** the next-step inbox is empty. A listener that calls `agent.steer(message)` there fills that inbox, and the loop runs another step of the **same** turn. It also runs after a concluding say, so Anima's listener first checks whether the turn already closed (`TurnCloser`, `anima-life/src/closer.ts`). DSH's own precedent: `hooks-codex`'s Stop hook. A root `ctx.on('agent/turn-stopping', ({ agent }) => …)` receives every agent's event.
- The steered reminder is a `createUserMessage` with `source.kind: 'anima-stimulus'`, `stimulus: 'close-reminder'`, so it is a logged `user/message` when the step claims it.

### Delivery: steer, followup, inject

- `agent.steer(m)` = `send(m, 'next-step', wakeup: true)`: joins a running turn at the next step boundary, or starts a turn when idle (`agent.ts:183`). Anima uses it for chat messages (`stimulus: 'message'`), so an arrival during a turn joins it, and a message that arrives while a closing say runs gets one more step.
- `agent.followup(m)` = `'next-turn'`, waking: intents, heartbeats, notices, batches and views keep their own turn.
- `agent.inject(m)` = `'next-step'`, not waking: earlier burst messages and context.
- Anima marks waking deliveries with `source.wake: true` (its own `MessageSourceMap` field), so the closer knows which `user/message` opened a turn.

### System prompt per session, and the runtime-context block

- `PromptSection.text` may be `(context: AssembleContext) => string` (`packages/core/system-prompt/src/index.ts:66`), evaluated at every assembly. The agent loop puts the agent on the context (`context.agent`, as `working-directory` reads it), so the persona section generates "this place" per session.
- `ctx.systemPrompt.suppressRuntimeContext()` in an agent scope drops every context not marked `required` from that scope's assemblies and from `refreshContext` (`index.ts:537`, `:589`). In her sessions that removes the sandbox, approval-policy, harness-checkout and Web GUI URL contexts.
- **The working-directory line cannot be removed at the pin.** `working-directory:current` is `required: true` (`session/working-directory/src/index.ts:90`), and `refreshContext` (called on every request, `agent.ts:446`) restores missing required contexts from the registry, so an `system-prompt/assemble` listener that deletes it would be undone. It stays; its text is her session's data directory. Anima's own `anima-self-model` context is required too and survives suppression.

### Loader rows by file path

A row `name` that is an absolute path or starts with `./` resolves to a file URL (`boot/app-boot/src/index.ts:550`). The scripted reliability check (`scripts/reliability/check.mjs`) is such a row in its `--patch` overlay; `--dump-config` shows `name: file:///…/check.mjs`. Nothing is installed into the profile for it.

### Tool parameters: avoid a string-or-list union

`defineTool` parameters accept `oneOf` (`packages/core/tools/src/schema.ts`, `OneOfValueSchemaSpec`), but with `text: oneOf [string, string[]]` DeepSeek-Flash sometimes wrote the string unquoted (`{"text": 最近我…}`). `llm-deepseek` rejects that stream (`tool input is invalid JSON`, code `MALFORMED_RESPONSE`), the turn ends with `reason.kind: 'error'` and no tool runs; once it happened in a session, later turns there failed the same way (47 of 211 turns in one scripted run). Say tools now take `text: string` plus `also: string[]`; the next 211-turn run had none. Errored turns never reach `agent/turn-stopping`, so Anima checks `turn/end.reason` for lost replies.

## 8h. Phase 9 extension points (sleep, inbox, message rhythm)

No new DSH API: the inbox, bedtime and settle window are Anima's own state; bursts and notices use the delivery calls of section 8g (`steer` for a burst, `followup` for Self, `inject` for context).

### NapCat at the pin (checked 2026-11-12)

- Her NapCat answers `get_version_info` with `NapCat.Onebot 4.18.42`, OneBot `v11` (one read-only call; nothing sent from her account).
- NapCatQQ's GitHub repository was emptied on 2026-11-12 (main has only a README, "Ending"; no tags). The source was read from the last pull-request snapshot, `refs/pull/2175/head` (`a626852`, 2026-11-09). The version string is injected at build time, so the snapshot cannot be proven identical to 4.18.42.
- **Typing (input status): reported, private chats only.** `packages/napcat-onebot/index.ts:303` turns the kernel's `onInputStatusPush` into a notice `{ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', user_id, group_id: 0, event_type, status_text }` (`event/notice/OB11InputStatusEvent.ts`; `status_text` such as "对方正在输入..."). Whether a "stopped typing" notice follows, and what each `event_type` means, is not visible in source. Anima therefore treats every notice with a non-empty `status_text` as typing, which restarts the quiet timer within `settleMaxSeconds`; a stop notice is not needed. Live check (Phase 9 supervised session, 2026-11-13): NapCat 4.18.42 delivered no `input_status` notice while the owner typed in the private chat (typing count 0 in the adapter's traffic), so on this runtime typing is not reported and the quiet timer alone settles a burst.
- **Read marks: never automatic.** NapCat calls `MsgApi.setMsgRead` only from the actions `mark_private_msg_as_read {user_id}`, `mark_group_msg_as_read {group_id}`, `mark_msg_as_read`, `_mark_all_as_read` (`action/msg/MarkMsgAsRead.ts`). Before Phase 9 Anima never called them, so every chat with her stayed unread. From Phase 9 the QQ adapter marks a chat read when a burst from it wakes her (`anima/read`, config `markRead`); messages held in her inbox stay unread until they reach her.

| OneBot v11 (NapCat) | Kind | Used for |
| --- | --- | --- |
| `notice` `notify` / `input_status` | event | `animaLife.typing(channel)`: keeps a private burst's settle window open |
| `mark_private_msg_as_read`, `mark_group_msg_as_read` | action | a chat that woke her is read |
| `set_input_status {user_id, event_type: 1}` | action | typing shown during the spacing wait between her messages (private chats) |

### Anima APIs added

- `anima.asleep(t?)`, `anima.bedtimeInfo(t?)`, `anima.goToSleep(by)`, `anima.wakeByOwner()`, `anima.checkBedtime()` (core); events `anima/sleep`, `anima/woken`, `anima/paused`.
- `animaLife.typing(channel)`, `animaLife.inbox`, `animaLife.settlingChannels()`; event `anima/read`; `paceMessages`, `typingMs` (shared pacing helper).
- Stimulus type `burst` (life), delivered with `steer` like a single message.

## 9. Other extension points Anima will use (Read)

- **Prompt injection (model-visible ⇒ logged):**
  - `ctx.systemPrompt.section({ name, order, text })` adds to the system prompt. Use it for the static constitution.
  - `ctx.systemPrompt.context({ name, order, text })` adds dynamic context. It becomes a durable user-role snapshot, re-sent only when the text changes. Use it for mood, state and needs.
  - The `agent/pre-step` waterfall (`runtime-types.ts:350`) can append `UserMessage`s to `{kind:'enter', messages}`, and they are logged as `user/message`. Verified in Phase 3 for memory recall (section 8b).
- **Owner commands (Verified in Phase 1):** `ctx.commands.register({ name, description, input?, handler })` (`packages/interaction/commands/src/index.ts`).
  - Names must match `^[a-z][a-z0-9_-]*$`, so `/anima status` is one command `anima` that parses its own subcommand from `inv.rawInput`.
  - Commands never reach the model. Runs are logged as `command/run` and `command/done`.
  - Template: `packages/compaction/command-compact/src/index.ts`.
  - Verified with `/anima status|pause|resume|chat|self`. A `{ kind: 'success', text }` result renders inline in the session where it was typed, and the log records `command/run` and `command/done`.
  - `rawInput` keeps the leading space after the name.
- **Non-model-visible plugin state:** a typed `SessionEventMap` extension or `appendPluginRecord` (ignorable `plugin:*` events), `packages/core/session/src/index.ts:495`. Anima's own durable data lives in `~/.anima/`.

## 10. Testing (Verified for tools)

- Use vitest with a plain Cordis `Context` and mount only the services under test:

  ```ts
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(animaCore)
  const result = await executeToolFixture(ctx, { callId: ToolCallId('x'), name: 'anima_ping', arguments: {}, signal })
  ```

- `executeToolFixture` comes from `@deepseek-ai/dsh-tool-testkit` (published on npm, but `@internal` in its JSDoc, so it may change without notice). It runs the real pre-execute → execute → post-execute pipeline, so it can also test the policy gate.
- DSH requires every registration to have a "dispose the fiber, assert it's gone" test; `ping.spec.ts` has one.
- For agent-level tests (sessions, `followup`), `@deepseek-ai/dsh-agent-loop-testkit` (`mountAgentLoopTestHarness`) exists, but it mounts no LLM adapter; you supply a mock `LlmAdapter`. It has not been tried yet.

## 11. APIs Anima relies on

Re-check these on every DSH upgrade.

| API | Package | Used for | Status |
| --- | --- | --- | --- |
| `dsh.bundle` manifest, `dsh plugin add`, `--from-default-profile`, `--dump-config` | `@deepseek-ai/dsh` CLI | install | Verified |
| `ctx.tools.register`, `defineTool` | `dsh-tools` | every behavior | Verified |
| `tools/pre-execute`, `PreToolDecision`, `ctx.tools.guard` | `dsh-tools` | policy gate | Verified |
| `register(def, { when })`, `tools.resolve`, `ResolvedToolSet.view` | `dsh-tools` | per-session tool scoping, tests | Verified |
| `@deepseek-ai/dsh-agent-preset` rows, persona section names from `dsh-system-prompt` | `dsh-agent-preset`, `dsh-system-prompt` | conversation / self presets | Verified |
| `sessionController.create` / `resolveAgent`, `sessionTitle.rename`, `workspaceRegistry.archivedSessionIds` | `dsh-api-session-controller`, `dsh-session-title`, `dsh-workspace` | session routing | Verified (archived check not exercised live) |
| `Agent.followup`, `createUserMessage`, `boundContextSummary`, `MessageSourceMap` | `dsh-agent`, `dsh-llm` | stimulus delivery | Verified (`steer` / `inject` still Read) |
| `Agent.steer` (joins a running turn, starts one when idle) | `dsh-agent` | chat messages; close reminders (Phase 8) | Read (Phase 8; unit tests use fakes) |
| `ctx.sessions.flush` | `dsh-session` | durability | Verified (`session/event` still Read) |
| `ctx.systemPrompt.section` (agent scope, `complete`) | `dsh-system-prompt` | persona | Verified (`context`, `agent/pre-step` still Read) |
| `ctx.commands.register` | `dsh-commands` | owner commands | Verified |
| `executeToolFixture` | `dsh-tool-testkit` (`@internal`) | tests | Verified |
| `agent.model.select`, `agent.status`, `agent.inject` | `dsh-agent` | triage/action models, busy check, outcome notices | Verified (Phase 2) |
| `session/event` with `assistant/message.usage`, `tool/call`, `tool/result`, `turn/end`, `user/message` | `dsh-session`, `dsh-llm` | token budget, intent outcomes, alarms | Verified (Phase 2) |
| `exec.concludeTurn()` | `dsh-tools` | `rest`, `heartbeat_act`, closing behaviors (say, `end_turn`) | Verified (Phase 2); idempotent, read in Phase 8 |
| `@deepseek-ai/dsh-tool-schedule` preset row, `source.kind: 'schedule'` | `dsh-tool-schedule`, `dsh-schedule` | her alarms | Verified (Phase 2) |
| `dsh-compaction-basic` defaults | `dsh-compaction-basic` | triage preset | Verified (do not lower `thresholdRatio`) |
| `agent.ctx.tools.restrict({ deny })`, `createScope` (tests) | `dsh-tools`, `dsh-scope` | persona `hideTools` | Verified (Phase 2; see the deferred-tools trap) |
| `agent/pre-step` waterfall, `PreStepDecision`, `ContextFormed` form `recall` | `dsh-agent`, `dsh-llm` | memory auto-injection | Verified (Phase 3) |
| Cordis `Events` augmentation, `ctx.emit` | `cordis` | `anima/stimulus`, `anima/behavior` between Anima packages | Verified (Phase 3) |
| `node:sqlite` `DatabaseSync`, FTS5 `trigram` | Node 24 built-in | memory store | Verified (Phase 3) |
| global `WebSocket` (client) | Node 24 built-in | QQ OneBot transport | Verified in unit tests (Phase 4) |
| `exec.signal` on `tools/pre-execute` | `dsh-tools` | an aborted turn denies a pending owner approval | Read (Phase 4) |
| Loader row `disabled: true` in a bundle, re-enabled by a patch | Cordis loader | optional QQ adapter row | Verified with `--dump-config` (Phase 4) |
| `ImageBlock` in `createUserMessage`, `ctx.attachments.saveImage` | `dsh-llm`, `dsh-attachment` | close-view frames to a viewing session | Verified (Phase 5, section 3) |
| catalog `inputModalities: ['text','image']` of `deepseek-flash` | `llm-deepseek` | viewing model | Verified (Phase 5: 7 images in one request) |
| global `fetch`, `Response.headers.getSetCookie`, `node:crypto` md5, `Readable.fromWeb` | Node 24 built-ins | Bilibili client, WBI, downloads | Verified (Phase 5) |
| system `ffmpeg` (`select` scene + `showinfo`, `-fps_mode vfr`) | OS binary | frame extraction | Verified (Phase 5) |
| `ctx.webServer.register({ kind: 'exact', path, resource })`, `getOrigin()` (optional, read with `ctx.get`) | `dsh-host-webserver` | login QR page | Verified (Phase 5 follow-up; typed locally, no dependency added) |
| `dsh.client` manifest + `./client` export, factory format `window.__ModuleLoader__.load({ id, factory })`, platform module table (`react`, `react/jsx-runtime`, `@deepseek-ai/cordis`) | `dsh-client-modules`, `dsh-client-web` | Anima page browser bundle (esbuild) | Verified (Phase 6 probe and demo) |
| client slots `sidebar.panellist` (list, `id`, `order`, `label`) and `main` (keyed, `key`), `ctx.slots.inject` / `register` | `dsh-client-ui-slots`, `-ui-sidebar`, `-ui-layout` | sidebar entry and page | Verified (Phase 6; typed locally) |
| `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` | `dsh-client-connection` (Host half) | owner routes `/api/anima/view`, `/api/anima/action` | Verified (Phase 6; 401 without the browser cookie) |
| `ctx.systemPrompt.context({ name, order, text: () => string, interpolate, required })` | `dsh-system-prompt` | self-model digest | Verified (Phase 6: logged runtime-context snapshot updates after a note and after a revert) |
| `ctx.configEditor.entries()`, `configuration()`, `edit(entry, change)`, `documentPath` (optional) | `dsh-config-editor` | Settings tab | Verified in the Phase 6 demo (typed locally) |
| `ImageBlock` in a tool's `output.render`, `ctx.llm.resolveModelInfo(...).inputModalities`, `agent.session.requestHeader()` | `dsh-tools`, `dsh-llm`, `dsh-agent` | `qq_look` shows the image in the chat's own model; vision check first | Read (Phase 7; unit tests use fakes) |
| `agent/turn-stopping` (serial; `agent.steer` inside runs another step of the same turn) | `dsh-agent`, `dsh-agent-loop` | close reminders for unclosed conversation turns | Read (Phase 8; unit tests emit it) |
| batch conclusion: any `concludesTurn` result ends the step's turn | `dsh-tools` | say closes, gestures in the same step do not undo it | Read (Phase 8) |
| `PromptSection.text` as `(context) => string`, `context.agent` | `dsh-system-prompt`, `dsh-agent` | per-session environment primer | Verified in unit tests (Phase 8) |
| `ctx.systemPrompt.suppressRuntimeContext()`, `refreshContext` restoring required contexts | `dsh-system-prompt` | no coding-agent context in her sessions; the cwd line stays (required) | Verified in unit tests (Phase 8) |
| `turn/end.data.reason` (`completed`, `aborted`, `error` with `code`) | `dsh-session`, `dsh-agent-loop` | an open turn that errored is a lost reply | Verified in the Phase 8 scripted check |
| loader row `name` as an absolute file path in a `--patch` overlay | Cordis loader (`app-boot`) | scripted reliability check row | Verified with `--dump-config` and a dry boot (Phase 8) |
| NapCat `notify/input_status` notice, `mark_*_msg_as_read` actions | NapCat 4.18.42 (OneBot extension) | typing keeps the settle window open; read marks (Phase 9) | Read in NapCat source (section 8h); verified with the fake OneBot in unit tests |

## 12. Known gaps and risks

- **Session-log upload:** `dsh-base` sends session logs to DeepSeek with requests to the official API by default. Turn it off under Settings → General → "Upload Session Log when using the official model API", or set `enabled: false` on the `session-log-deepseek` row in the profile patch. This matters once real chats with other people flow through her sessions.
- **Native install scripts:** the installed CLI pulls native addons (`node-pty`, `koffi`, `dsh-subprocess-local`). Their install scripts are allowlisted in `pnpm-workspace.yaml` (`allowBuilds`).
- **pnpm version for `dsh plugin`:** `dsh plugin` runs whichever `pnpm` is on PATH inside the profile directory. On this machine that is corepack's default (12.x), not the workspace's 11.28.5. It worked, but watch for lockfile differences.
- **Pre-stable APIs:** everything in section 10 marked Read can change between DSH releases.
- **Session recency:** sessions fed by a custom source kind do not rise in the sidebar's recency order (section 6).
- **Session-log upload is off in `anima-dev`** since Phase 4 (owner decision): the profile patch sets `session-log-deepseek` `enabled: false`, verified with `--dump-config`. Phase 1–3 logs (and the Phase 4 supervised runs, which ran before the change) were uploaded under the default.
- **Global tools leak into Anima sessions:** her conversation session was offered `anima_ping` (root-level Phase 0 probe) and DSH's global `working_directory` beside `local_say`. Harmless in Phase 1, but not in Phase 2. In the accelerated day, her Self session called `working_directory`. That led her to conclude she has "no file tools beyond cd", and she spent part of her second initiation asking the owner about it. Fixed: the persona row hides both (`hideTools`, section 8). Hiding them needed a fresh Self session (deferred-tools trap, section 8).
- **Real clock in DSH parts:** schedule timing and DSH's own event timestamps use the real clock even under a sped-up Anima clock. Session logs therefore show real times; the simulated time is in each stimulus's leading stamp.
- **First test-day run lost:** the run with the broken triage compaction config left an empty, never-started triage session for character `anima-test` (hidden in the sidebar because blank) and `~/.anima/test-day/`. Both are unused test data.
- **`--patch` needs `--profile`:** `dsh --patch x.yml anima-dev` fails with "--profile <name> is required"; use `dsh --profile anima-dev --patch x.yml`.
