/**
 * Build the browser half into DSH's client-module factory format
 * (docs/DSH-INTEGRATION.md §8e): one CJS bundle wrapped in
 * window.__ModuleLoader__.load({ id, factory }). React and Cordis come from
 * the host's platform module table, so they stay external.
 */
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url)
const { name } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

await build({
  entryPoints: [new URL('src/client/index.tsx', root).pathname],
  outfile: new URL('lib/client.js', root).pathname,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})
