# @anima/adapter-bili

Read-only Bilibili for Anima (DESIGN §11). She browses on her own account from her Self session, picking one of three tiers herself:

| Tier | Behaviors | What she gets |
| --- | --- | --- |
| 0 skim | `bili_feed` (login), `bili_popular`, `bili_search(query)` | One line per video: bvid, title, uploader, length, counts, a short description |
| 1 watch | `bili_watch(bvid)`, `bili_comments(bvid, page?)` | One text digest: metadata → subtitles → a danmaku sample → top comments (each section capped by config) |
| 2 close view | `bili_view_closely(bvid, focus?)` | A viewing note written in a short viewing session that saw K frames (with the subtitle line at each frame) |

- **Who sees the behaviors.** All are `observe`, `sessions: ['self']`, `modes: ['day']`. A conversation session never sees `bili_*`.
- **Where the limits live.** Every limit is in the core gate: the default quotas `bili_*` 60 per hour and `bili_view_closely` 3 per day, and the `limits` of 12 frames and 1200 s of video. They are checked through the behavior's `facts` before anything is downloaded.
- **What this package does itself.** It only paces its HTTP requests (`minGapMs`, one at a time) and backs off on risk control.
- **What she remembers:**
  - `bili_watch` writes a `public` transcript line, which consolidation sorts later.
  - A close view stores its note as a `public` episode, so she can bring it up in any chat.

## Close views

1. The play URL (`qn` 16 = 360p, single mp4) is streamed into `<dataDir>/bili/cache`, under `cache.maxMegabytes`.
2. `ffmpeg` writes candidate frames: the first frame, scene changes (`sceneThreshold`), and one at least every `fallbackEverySeconds`. They are scaled to `frameWidth`, and `showinfo` gives their timestamps. K (`framesPerView`) frames spread over time are kept.
3. The frames are saved with DSH's attachment service and delivered as image blocks to a viewing session (preset `anima-viewing`, model `closeView.model`).
4. She calls `viewing_note(note)`, and only that text returns to Self. Audio is not used.
5. The cache is deleted after each view and at load.

`ffmpeg` is required when `closeView.enabled` (the default). Load fails with `anima/ffmpeg-missing` if it does not run (WSL2/Ubuntu: `sudo apt install ffmpeg`).

## Account and login

- She needs a dedicated account. The owner runs `/anima bili login`:
  - With DSH's webserver (the web UI), the command prints a link like `http://127.0.0.1:3080/anima/bili/qr/<random>.svg`. Open it in the browser. The page lives only while the login waits. The web UI cannot show a scannable text QR: command output is short, line-spaced plain text.
  - Without a webserver, the command shows the QR as text.
  - Either way the QR is also written to `<dataDir>/bili/login-qr.svg` and printed in the DSH log.
  - Scan it with the Bilibili app and confirm.
- Cookies (`SESSDATA`, `bili_jct`, `DedeUserID`, …) and the refresh token go to `<dataDir>/bili/cookie.json`, mode 0600.
- `/anima bili status` checks the login; `/anima bili logout` deletes the file.
- Cookies are not refreshed yet. A stale login shows as "not logged in" in status and in her report.
- Device ids (`buvid3`, `b_nut`) come from the homepage on first use, as a browser would get them.

## Risk control

- A `-352` answer, HTTP 412, or a `v_voucher`-only reply puts the client in back-off: 60 s, doubling, capped at 1 h.
- During back-off every call fails at once with `anima/bili-risk-control` and a plain hint.
- `/anima status` shows `BACKING OFF until …`, and her situation report tells her to browse later.

## Endpoints (checked live 2026-11-10)

| Use | Endpoint | Anonymous | Logged in |
| --- | --- | --- | --- |
| device ids | `www.bilibili.com/` (Set-Cookie `buvid3`, `b_nut`) | works | — |
| login state, WBI keys | `x/web-interface/nav` | `-101`, but `wbi_img` present | works |
| popular | `x/web-interface/popular` | works | works |
| search | `x/web-interface/wbi/search/all/v2` (WBI) | works | works |
| (not used) | `x/web-interface/wbi/search/type` (WBI) | answers only `v_voucher` (risk challenge) | works |
| feed | `x/polymer/web-dynamic/v1/feed/all?type=video` | `-101` | works |
| video info | `x/web-interface/view` | works (`duration` is the total of all parts; the adapter uses part 1's) | works |
| subtitles | `x/player/wbi/v2` (WBI) → `subtitle_url` JSON | empty list, `need_login_subtitle: true` on many videos | AI subtitles on 5 of 6 sampled videos |
| danmaku | `x/v1/dm/list.so?oid=<cid>` (XML, deflate) | works | works |
| comments | `x/v2/reply/wbi/main` (WBI, `mode` 3 hot, `pagination_str`) | works | works |
| play URL | `x/player/wbi/playurl` (WBI, `qn` 16, `fnval` 1, `platform` html5) | works: one mp4; Range fetch 206 with or without Referer | works (demo close view) |
| QR login | `passport…/x/passport-login/web/qrcode/generate`, `/poll` | works (`86101` not scanned, `86090` scanned, `86038` expired, `0` done) | — |

WBI signing follows the web player: a mixin key from the `nav` key images, then `w_rid = md5(sorted query + mixin)` (`src/wbi.ts`, tested against the documented example).

## Config

The defaults suit a first run; see `src/config.ts`:

- `minGapMs` 1500
- `listSize` 10
- `digest` caps
- `quality` 16
- `closeView`: `framesPerView` 12, `fallbackEverySeconds` 20, `sceneThreshold` 0.3, `frameWidth` 512, `model` deepseek-official/deepseek-flash, `timeoutSeconds` 300
- `cache.maxMegabytes` 200
- `ffmpegPath`

The bundle row is `disabled: true`; enable it with a patch:

```yaml
- id: anima-adapter-bili
  disabled: false
```
