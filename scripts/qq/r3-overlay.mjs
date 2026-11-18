// Write the --patch overlay of the R3 supervised check on the real QQ backend (scripts/qq/r3-check.mjs)
// into a fresh data dir under ~/.anima, with its own characterId. The overlay names real accounts and
// the token, so it lives outside the repo; the connection comes from ~/.anima/notrainmeow.json
// ({ url, token }). Nothing under ~/.dsh changes. The guard row is inserted by path with its default
// (empty) allowlist, so only the owner's own chat can reach her or be reached.
// Usage: node scripts/qq/r3-overlay.mjs <her QQ account> <owner QQ id>   → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [account, owner] = process.argv.slice(2)
if (!/^\d{5,12}$/.test(account ?? '') || !/^\d{5,12}$/.test(owner ?? '')) throw new Error('usage: r3-overlay.mjs <her QQ account> <owner QQ id>')
const conn = JSON.parse(readFileSync(join(homedir(), '.anima', 'notrainmeow.json'), 'utf8'))
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r3-qq-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const check = fileURLToPath(new URL('./r3-check.mjs', import.meta.url))
const guardLib = fileURLToPath(new URL('../../packages/anima-guard/lib/index.js', import.meta.url))

const yaml = `# R3 supervised QQ check, run ${run} (scripts/qq/r3-overlay.mjs). Names real accounts; outside git.
- id: anima-core
  config:
    characterId: ${run}
    name: 小鲸鱼
    dataDir: ${dir}
- id: anima-adapter-qq
  disabled: false
  config:
    backend: { protocol: onebot11, url: '${conn.url}', accessToken: '${conn.token}' }
    account: '${account}'
    owner: '${owner}'
    ownerName: Sam
- insert:
    # Outside the persona, by path (the guard bundle is not installed in anima-dev); empty allowlist.
    - id: anima-guard
      name: ${guardLib}
    - id: anima-r3-check
      name: ${check}
      config:
        url: '${conn.url}'
        accessToken: '${conn.token}'
        account: '${account}'
        owner: '${owner}'
`
writeFileSync(join(dir, 'r3.patch.yml'), yaml, { mode: 0o600 })
console.log(join(dir, 'r3.patch.yml'))
