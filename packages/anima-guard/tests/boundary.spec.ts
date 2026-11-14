import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The persona's packages: inside the plugin is inside the persona (docs/CONSTITUTION.md). */
const PERSONA = ['anima-core', 'anima-life', 'anima-memory', 'anima-adapter-local', 'anima-adapter-qq', 'anima-adapter-bili']
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
