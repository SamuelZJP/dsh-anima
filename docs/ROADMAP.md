# Roadmap

One phase at a time. A phase is done when its exit check passes and is demonstrated in a DSH dev profile. Sped-up exit demos run on the fake demo platform (`scripts/demo/demo-platform.mjs`, development only); QQ is her only real channel. Each phase starts with a plan: what changes, which files, how it is verified. Finished phases are in git and `history/`.

## Last — dsh-mnemon compatibility

Each waking session she opens is written to `~/.dsh/mnemon-exclude-sessions.json` (a JSON array of session ids, kept with other entries), and removed when it is archived, so the `dsh-mnemon` memory plugin leaves her sessions alone. Needed once mnemon runs in a profile she lives in (`anima-dev` has none).
