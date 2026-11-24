// Write the --patch overlay of the R4 spike (scripts/spikes/r4-spike.mjs) into a fresh run dir
// under ~/.anima. Every Anima row is disabled; nothing under ~/.dsh changes.
// Usage: node scripts/spikes/r4-overlay.mjs   → prints the overlay path
// Boot:  pnpm dsh --profile anima-dev --patch <path> --no-open
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
const run = `spike-r4-${stamp}`
const dir = join(homedir(), '.anima', run)
mkdirSync(join(dir, 'cwd'), { recursive: true })
const spike = fileURLToPath(new URL('./r4-spike.mjs', import.meta.url))
const off = ['anima-core', 'anima-life', 'anima-memory', 'anima-adapter-qq', 'anima-adapter-bili', 'anima-guard', 'anima-page',
  'anima-preset-conversation', 'anima-preset-self', 'anima-preset-triage', 'anima-preset-consolidation', 'anima-preset-group-triage', 'anima-preset-viewing']
const preset = (id, description) => `    - id: spike-preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: spike-${id}
        name: Spike ${id}
        description: ${description}
        plugins: []`
const yaml = `# R4 spike overlay (scripts/spikes/r4-overlay.mjs): Anima rows off, two bare presets, the spike row.
${off.map(id => `- { id: ${id}, disabled: true }`).join('\n')}
- insert:
${preset('waking', 'R4 spike parent session.')}
${preset('viewing', 'R4 spike viewing child.')}
    - id: anima-r4-spike
      name: ${spike}
      config:
        out: ${dir}
        cwd: ${join(dir, 'cwd')}
        sessionId: ${run}
        model: { provider: deepseek-official, model: deepseek-flash }
`
writeFileSync(join(dir, 'spike.patch.yml'), yaml)
console.log(join(dir, 'spike.patch.yml'))
