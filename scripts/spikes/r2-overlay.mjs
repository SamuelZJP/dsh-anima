// Write the --patch overlay of the R2 spike (scripts/spikes/r2-spike.mjs) into a fresh run dir
// under ~/.anima. Every Anima row is disabled; nothing under ~/.dsh changes.
// Usage: node scripts/spikes/r2-overlay.mjs   → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
const run = `spike-r2-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(join(dir, 'cwd'), { recursive: true })
const spike = fileURLToPath(new URL('./r2-spike.mjs', import.meta.url))
const off = ['anima-core', 'anima-life', 'anima-memory', 'anima-adapter-qq', 'anima-adapter-bili', 'anima-guard', 'anima-page',
  'anima-preset-conversation', 'anima-preset-self', 'anima-preset-triage', 'anima-preset-consolidation', 'anima-preset-group-triage', 'anima-preset-viewing']
const yaml = `# R2 spike overlay (scripts/spikes/r2-overlay.mjs): Anima rows off, one bare preset, the spike row.
${off.map(id => `- { id: ${id}, disabled: true }`).join('\n')}
- insert:
    - id: spike-preset-day
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: spike-day
        name: Spike day
        description: R2 spike session.
        plugins: []
    - id: anima-r2-spike
      name: ${spike}
      config:
        out: ${dir}
        cwd: ${join(dir, 'cwd')}
        sessionId: ${run}
`
writeFileSync(join(dir, 'spike.patch.yml'), yaml)
console.log(join(dir, 'spike.patch.yml'))
