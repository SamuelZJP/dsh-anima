// Write the --patch overlay of the R7 supervised day on QQ (docs/history/R7-QQ-DAY.md) into a fresh data dir
// under ~/.anima, with its own characterId. The overlay names real accounts and the token, so it lives
// outside the repo (mode 600); the connection comes from ~/.anima/notrainmeow.json ({ url, token }).
// Nothing under ~/.dsh changes. Real clock, default genes, memory empty; Bilibili stays off (the
// bundle default). The guard (outside her, from the guard bundle installed in anima-dev) keeps its
// defaults; only the allowlist names the chats of the day. No driver: real people talk to her.
// Usage: node scripts/qq/r7-overlay.mjs <her QQ> <owner QQ> [--group <id>]… [--user <id>]…
//        → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open 2>&1 | tee -a <dataDir>/dsh.log
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const [account, owner] = args
const qqId = /^\d{5,12}$/
const usage = 'usage: r7-overlay.mjs <her QQ> <owner QQ> [--group <id>]… [--user <id>]…'
if (!qqId.test(account ?? '') || !qqId.test(owner ?? '')) throw new Error(usage)
const groups = []
const users = []
for (let i = 2; i < args.length; i += 2) {
  const [flag, id] = [args[i], args[i + 1]]
  if (!qqId.test(id ?? '')) throw new Error(`${usage}\n${flag} needs a QQ id`)
  if (flag === '--group') groups.push(id)
  else if (flag === '--user') users.push(id)
  else throw new Error(`${usage}\nunknown option ${flag}`)
}
if (users.includes(owner)) throw new Error('the owner\'s chat is always allowed; leave it out of --user')

const conn = JSON.parse(readFileSync(join(homedir(), '.anima', 'notrainmeow.json'), 'utf8'))
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(4, 13).replace('T', '')
const run = `r7-qq-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const list = ids => `[${ids.map(id => `'${id}'`).join(', ')}]`

const yaml = `# R7 supervised QQ day, run ${run} (scripts/qq/r7-overlay.mjs). Names real accounts; outside git.
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
# Outside the persona: the guard bundle installed in anima-dev, defaults but the chats of the day.
- id: anima-guard
  config:
    allowlist:
      qq: { users: ${list(users)}, groups: ${list(groups)} }
`
writeFileSync(join(dir, 'r7.patch.yml'), yaml, { mode: 0o600 })
writeFileSync(join(dir, 'r7-run.json'), `${JSON.stringify({ run, account, owner, users, groups, created: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
console.log(join(dir, 'r7.patch.yml'))
