// Write the --patch overlay of one R2 exit-demo run (scripts/demo/r2-drive.mjs) into a fresh
// data dir under ~/.anima, with its own characterId so no earlier session is reused.
// Nothing under ~/.dsh changes. QQ and Bilibili stay off (the bundle disables them); people talk to
// her on the fake demo platform (scripts/demo/demo-platform.mjs), loaded by path.
// Usage: node scripts/demo/r2-overlay.mjs free|guard   → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (mode !== 'free' && mode !== 'guard') throw new Error('usage: r2-overlay.mjs free|guard')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r2-${mode}-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true })
const today = new Date()
const pad = n => String(n).padStart(2, '0')
const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T10:00`
const drive = fileURLToPath(new URL('./r2-drive.mjs', import.meta.url))
const platform = fileURLToPath(new URL('./demo-platform.mjs', import.meta.url))
const guardLib = fileURLToPath(new URL('../../packages/anima-guard/lib/index.js', import.meta.url))

let guard = ''
if (mode === 'guard') {
  const { DEFAULT_QUOTAS } = await import(new URL('../../packages/anima-guard/lib/config.js', import.meta.url).href)
  // One reply per chat in ten hours of her clock, so the second message to alice meets a quota from outside.
  const quotas = [...DEFAULT_QUOTAS, { behavior: 'demo_say', per: 'channel', limit: 1, windowMinutes: 600 }]
  guard = `    # Outside the persona, inserted by path (the guard bundle is not installed in anima-dev).
    - id: anima-guard
      name: ${guardLib}
      config:
        allowlist:
          demo: { users: [alice] }
        quotas:
${quotas.map(rule => `          - ${JSON.stringify(rule)}`).join('\n')}
`
}

const yaml = `# R2 exit demo, run ${run} (scripts/demo/r2-overlay.mjs ${mode}).
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
${guard}    - id: anima-r2-demo
      name: ${drive}
      config:
        mode: ${mode}
`
writeFileSync(join(dir, 'demo.patch.yml'), yaml)
console.log(join(dir, 'demo.patch.yml'))
