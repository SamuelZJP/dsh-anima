// Write the --patch overlay of the R6 exit demo (scripts/demo/r6-drive.mjs) into a fresh data dir
// under ~/.anima, with its own characterId. Nothing under ~/.dsh changes, and no older data dir is
// touched. QQ and Bilibili stay off (the bundle disables them); scripted people talk to her on the
// fake demo platform (scripts/demo/demo-platform.mjs), loaded by path, and the guard (outside her,
// from the guard bundle installed in anima-dev) allows the demo chats with its default quotas,
// which since R6 hold no speech limit. Her genes are the defaults. Her clock runs at 30×.
// The day starts at 13:00, her body up since 07:00 (energy 0.75, sleep pressure 0.42).
// Usage: node scripts/demo/r6-overlay.mjs   → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r6-day-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true })
const today = new Date()
const pad = n => String(n).padStart(2, '0')
const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T13:00`
const t = new Date(start).getTime()
writeFileSync(join(dir, 'state.json'), `${JSON.stringify({ self: { needs: {}, energy: 0.75, mood: { valence: 0, arousal: 0.3 }, sleepPressure: 0.42, updatedAt: t }, sleep: { asleep: false, since: t - 6 * 3_600_000, by: 'rested' } })}\n`)
const drive = fileURLToPath(new URL('./r6-drive.mjs', import.meta.url))
const platform = fileURLToPath(new URL('./demo-platform.mjs', import.meta.url))

const yaml = `# R6 exit demo, run ${run} (scripts/demo/r6-overlay.mjs).
- id: anima-core
  config:
    characterId: ${run}
    name: 小鲸鱼
    dataDir: ${dir}
    clock: { speed: 30, start: '${start}' }
- id: anima-life
  config:
    conversation: { settleSeconds: 3 }
# Outside the persona: the guard bundle installed in anima-dev, with the demo chats allowed.
- id: anima-guard
  config:
    allowlist:
      demo: { open: true }
    outbox: { delaySeconds: 0 }
- insert:
    - id: anima-demo-platform
      name: ${platform}
    - id: anima-r6-demo
      name: ${drive}
`
writeFileSync(join(dir, 'demo.patch.yml'), yaml)
console.log(join(dir, 'demo.patch.yml'))
