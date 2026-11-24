// Write the --patch overlay of the R5 exit demo (scripts/demo/r5-drive.mjs) into a fresh data dir
// under ~/.anima, with its own characterId and an empty memory. Nothing under ~/.dsh changes, and
// no older data dir is touched. QQ and Bilibili stay off (the bundle disables them); scripted
// people talk to her on the fake demo platform (scripts/demo/demo-platform.mjs), loaded by path,
// and the guard (outside her, from the guard bundle installed in anima-dev) allows the demo chats.
// Her clock runs at 30×.
// Usage: node scripts/demo/r5-overlay.mjs [check|days]   → prints the overlay path
//   check  21:00, a body up since 07:00 (sleep pressure 0.7): one evening and one sleep, to see
//          archive → log read → consolidation work in DSH
//   days   15:00, sleep pressure 0.5: day 1 (a private fact, an unglanced group), her sleep,
//          day 2 (the group asks about it)
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] === 'check' ? 'check' : 'days'
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r5-${mode}-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true })
const today = new Date()
const pad = n => String(n).padStart(2, '0')
const hour = mode === 'check' ? '21:00' : '15:00'
const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T${hour}`
const t = new Date(start).getTime()
const pressure = mode === 'check' ? 0.7 : 0.5
writeFileSync(join(dir, 'state.json'), `${JSON.stringify({ self: { needs: {}, energy: 0.7, mood: { valence: 0, arousal: 0.3 }, sleepPressure: pressure, updatedAt: t }, sleep: { asleep: false, since: t - 8 * 3_600_000, by: 'rested' } })}\n`)
const drive = fileURLToPath(new URL('./r5-drive.mjs', import.meta.url))
const platform = fileURLToPath(new URL('./demo-platform.mjs', import.meta.url))

const yaml = `# R5 exit demo, run ${run} (scripts/demo/r5-overlay.mjs).
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
    initiate:
      consent: { owner: true, channels: ['demo:me:private:alice', 'demo:me:group:club'] }
    outbox: { delaySeconds: 0 }
- insert:
    - id: anima-demo-platform
      name: ${platform}
    - id: anima-r5-demo
      name: ${drive}
      config:
        mode: ${mode}
`
writeFileSync(join(dir, 'demo.patch.yml'), yaml)
console.log(join(dir, 'demo.patch.yml'))
