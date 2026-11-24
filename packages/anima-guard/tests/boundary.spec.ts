import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The persona's packages: inside the plugin is inside the persona (docs/CONSTITUTION.md). */
const PERSONA = ['anima-core', 'anima-life', 'anima-memory', 'anima-adapter-qq', 'anima-adapter-bili']
const OUTSIDE = ['@anima/guard', '@anima/page']
const packages = join(import.meta.dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('the persona never reaches outside itself', () => {
  for (const name of PERSONA) {
    it(`${name} imports nothing outside the persona`, () => {
      const manifest = JSON.parse(readFileSync(join(packages, name, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
      expect(deps.filter(dep => OUTSIDE.includes(dep))).toEqual([])
      const offending = sources(join(packages, name, 'src')).filter(file => OUTSIDE.some(pkg => readFileSync(file, 'utf8').includes(`'${pkg}`)))
      expect(offending).toEqual([])
    })
  }
})

describe('the Anima plugin is the persona only', () => {
  const root = join(packages, '..')
  it('its bundle installs no row of the outside; the guard bundle installs them', () => {
    const persona = readFileSync(join(root, 'bundle', 'cordis.patch.yml'), 'utf8')
    expect(persona).not.toMatch(/'@anima\/(guard|page)'/)
    expect(Object.keys((JSON.parse(readFileSync(join(root, 'bundle', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies)).not.toEqual(expect.arrayContaining(['@anima/guard']))
    const outside = readFileSync(join(root, 'guard-bundle', 'cordis.patch.yml'), 'utf8')
    expect(outside).toContain("name: '@anima/guard'")
    expect(outside).toContain("name: '@anima/page'")
  })
})

/**
 * Every refusal code raised inside the persona, classified (docs/CONSTITUTION.md:
 * inside the persona nothing refuses her except physiology). A new code fails
 * this test until it is classified here; there is no class for rules.
 * - `physiology`: her body (asleep, her eyes).
 * - `fact`: what is true of the world or of her own records (unknown id, offline, nothing there).
 * - `plumbing`: load, wiring and argument shape, not a decision about her.
 * - `until-R5`: first-design rules the roadmap removes in that phase.
 */
const REFUSALS: Record<string, 'physiology' | 'fact' | 'plumbing' | 'until-R5'> = {
  'anima/asleep': 'physiology',
  'anima/view-no-note': 'physiology', 'anima/view-timeout': 'physiology', 'anima/no-vision': 'physiology',
  'anima/unknown-channel': 'fact', 'anima/unknown-alarm': 'fact', 'anima/unknown-memory': 'fact', 'anima/unknown-segment': 'fact',
  'anima/goal-closed': 'fact', 'anima/goal-not-found': 'fact', 'anima/no-forward': 'fact', 'anima/no-image': 'fact',
  'anima/self-model-unknown': 'fact', 'anima/self-model-conflict': 'fact',
  'anima/qq-offline': 'fact', 'anima/qq-failed': 'fact', 'anima/qq-timeout': 'fact', 'anima/partly-sent': 'fact', 'anima/forward-failed': 'fact', 'anima/look-failed': 'fact',
  'anima/bili-error': 'fact', 'anima/bili-network': 'fact', 'anima/bili-risk-control': 'fact', 'anima/bili-login-needed': 'fact', 'anima/bili-login-pending': 'fact', 'anima/ffmpeg-failed': 'fact',
  'anima/empty-message': 'plumbing', 'anima/empty-memory': 'plumbing', 'anima/goal-empty': 'plumbing', 'anima/self-model-text': 'plumbing',
  'anima/bad-args': 'plumbing', 'anima/bad-time': 'plumbing',
  'anima/config-invalid': 'plumbing', 'anima/config-moved': 'plumbing', 'anima/config-removed': 'plumbing', 'anima/constitution-empty': 'plumbing',
  'anima/behavior-duplicate': 'plumbing', 'anima/behavior-name': 'plumbing', 'anima/resolver-duplicate': 'plumbing', 'anima/status-duplicate': 'plumbing',
  'anima/platform-duplicate': 'plumbing', 'anima/owner-line-duplicate': 'plumbing',
  'anima/delivery-not-durable': 'plumbing', 'anima/delivery-timeout': 'plumbing', 'anima/no-session': 'plumbing', 'anima/no-session-controller': 'plumbing', 'anima/no-sessions': 'plumbing',
  'anima/session-archived': 'plumbing', 'anima/session-id-mismatch': 'plumbing', 'anima/session-missing': 'plumbing', 'anima/session-resolve': 'plumbing', 'anima/state-corrupt': 'plumbing',
  'anima/no-schedule': 'plumbing', 'anima/no-attachments': 'plumbing', 'anima/not-anima-session': 'plumbing', 'anima/wrong-session': 'plumbing',
  'anima/no-subagents': 'plumbing', 'anima/no-workspace-registry': 'plumbing',
  'anima/no-channel': 'plumbing', 'anima/no-run': 'plumbing', 'anima/ffmpeg-missing': 'plumbing', 'anima/qr-too-long': 'plumbing', 'anima/bili-cookie-file': 'plumbing',
  'anima/look-too-large': 'plumbing', 'anima/bili-too-large': 'plumbing',
  'anima/no-scope': 'until-R5',
}

describe('inside the persona, nothing refuses her but physiology', () => {
  it('every refusal code inside the persona is classified, and none is a rule', () => {
    const found = new Set<string>()
    for (const name of PERSONA) {
      for (const file of sources(join(packages, name, 'src'))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/AnimaError\('(anima\/[a-z0-9-]+)'|:\s*'(anima\/[a-z0-9-]+)'/g)) found.add(match[1] ?? match[2]!)
      }
    }
    expect([...found].filter(code => REFUSALS[code] === undefined).sort()).toEqual([])
    // Codes removed in R2 and R4 because they were rules inside her (a clock, a bedtime, a policy).
    for (const code of ['anima/self-model-slow', 'anima/self-model-full', 'anima/not-allowed', 'anima/not-allowlisted', 'anima/not-bedtime', 'anima/night']) expect(found.has(code)).toBe(false)
  })
})
