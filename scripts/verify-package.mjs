/** Install the actual tarball in a private consumer and exercise its bundle through Loader. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const archive = resolve(process.argv[2] ?? 'dist/dsh-shared-config.tgz')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
const allowed = /^package\/(?:package\.json|README\.md|docs\/RELEASING\.md|LICENSE|cordis\.patch\.yml|icon\.svg|locale\/(?:en-US|zh-CN)\.json|lib\/(?:index\.js|index\.d\.ts|document\.d\.ts))$/
for (const name of listing) assert.match(name, allowed, `Unexpected packed file: ${name}`)
for (const name of ['lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml', 'docs/RELEASING.md', 'LICENSE', 'icon.svg', 'locale/en-US.json', 'locale/zh-CN.json']) {
  assert.ok(listing.includes(`package/${name}`), `Missing packed file: ${name}`)
}
const consumer = await mkdtemp(join(tmpdir(), 'dsh-shared-config-package-'))
try {
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    name: 'shared-config-consumer', private: true, type: 'module',
    dependencies: { ...manifest.peerDependencies, [manifest.name]: archive },
  }, null, 2) + '\n')
  await writeFile(join(consumer, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: true\n')
  const pnpm = process.env.npm_execpath
  assert.ok(pnpm, 'Run this check using pnpm run test:package')
  const args = ['install', '--ignore-scripts', '--no-frozen-lockfile']
  const isScript = /\.[cm]?js$/i.test(pnpm)
  execFileSync(isScript ? process.execPath : pnpm, isScript ? [pnpm, ...args] : args, { cwd: consumer, stdio: 'inherit' })
  await copyFile(new URL('./package-smoke.mjs', import.meta.url), join(consumer, 'package-smoke.mjs'))
  execFileSync(process.execPath, ['package-smoke.mjs'], { cwd: consumer, stdio: 'inherit' })
  const declarations = await readFile(join(consumer, 'node_modules', manifest.name, 'lib/index.d.ts'), 'utf8')
  assert.doesNotMatch(declarations, /shortcuts|compactionDefaults|DSH_REPO/)
  console.log(`Verified packed files, clean install, and native config edits: ${archive}`)
} finally {
  await rm(consumer, { recursive: true, force: true })
}
