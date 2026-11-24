// Write the --patch overlay of the R4 exit demo (scripts/demo/r4-drive.mjs) into a fresh data dir
// under ~/.anima, with its own characterId so no earlier session is reused. Nothing under ~/.dsh
// changes. QQ and Bilibili stay off (the bundle disables them); scripted people talk to her on the
// fake demo platform (scripts/demo/demo-platform.mjs), loaded by path. The guard is loaded by path
// too (outside her): the owner's night wake goes through it, and the demo chats are allowed.
// Usage: node scripts/demo/r4-overlay.mjs [evening]   → prints the overlay path
// "evening" starts her clock at 15:00 with a body that has been up since 07:00 (a state.json
// seeded in the fresh data dir: sleep pressure 0.59, as 8 hours awake from 0.15 give).
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
const mode = process.argv[2] === 'evening' ? 'evening' : 'day'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r4-${mode === 'evening' ? 'eve-' : ''}${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true })
const today = new Date()
const pad = n => String(n).padStart(2, '0')
const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T${mode === 'evening' ? '15:00' : '07:00'}`
if (mode === 'evening') {
  const t = new Date(start).getTime()
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({ self: { needs: {}, energy: 0.7, mood: { valence: 0, arousal: 0.3 }, sleepPressure: 0.59, updatedAt: t }, sleep: { asleep: false, since: t - 8 * 3_600_000, by: 'rested' } })}\n`)
}
const drive = fileURLToPath(new URL('./r4-drive.mjs', import.meta.url))
const platform = fileURLToPath(new URL('./demo-platform.mjs', import.meta.url))
const guardLib = fileURLToPath(new URL('../../packages/anima-guard/lib/index.js', import.meta.url))

const yaml = `# R4 exit demo, run ${run} (scripts/demo/r4-overlay.mjs).
- id: anima-core
  config:
    characterId: ${run}
    name: 小鲸鱼
    dataDir: ${dir}
    clock: { speed: 30, start: '${start}' }
- id: anima-life
  config:
    conversation: { settleSeconds: 3 }
- insert:
    - id: anima-demo-platform
      name: ${platform}
    # Outside the persona, inserted by path (the guard bundle is not installed in anima-dev).
    - id: anima-guard
      name: ${guardLib}
      config:
        allowlist:
          demo: { open: true }
        initiate:
          consent: { owner: true, channels: ['demo:me:private:alice', 'demo:me:group:club'] }
        outbox: { delaySeconds: 0 }
    - id: anima-r4-demo
      name: ${drive}
      config:
        mode: ${mode}
`
writeFileSync(join(dir, 'demo.patch.yml'), yaml)
console.log(join(dir, 'demo.patch.yml'))
