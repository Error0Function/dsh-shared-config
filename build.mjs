/** Build the public Host entry and declarations using this package's dependencies. */
import { mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })
await build({
  entryPoints: {
    index: 'src/index.ts',
    'agent-prompt': 'src/agent-prompt.ts',
  },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'external',
})
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.build.json'], { stdio: 'inherit' })
console.log('Built dsh-shared-config Host entry and declarations')
