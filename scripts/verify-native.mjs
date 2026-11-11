/** Exercise the native DSH installer in an owned temporary home. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { valid } from 'semver'

const args = process.argv.slice(2).filter(arg => arg !== '--')
const source = args.includes('--source')
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const dshTestVersion = manifest.config.dshTestVersion
assert.equal(valid(dshTestVersion), dshTestVersion, 'Native checks require an exact DSH test version')
const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Run native checks through pnpm run test:source or test:native')
const temp = await mkdtemp(join(tmpdir(), 'dsh-shared-config-native-'))
const run = (command, commandArgs, cwd, env = process.env, capture = false) => execFileSync(command, commandArgs, {
  cwd, env, timeout: 300000, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
})
const runPnpm = (commandArgs, cwd) => /\.[cm]?js$/i.test(pnpm)
  ? run(process.execPath, [pnpm, ...commandArgs], cwd) : run(pnpm, commandArgs, cwd)
let passed = false
try {
  let dshBin = process.env.DSH_BIN
  if (!dshBin) {
    const runtime = join(temp, 'runtime')
    await mkdir(runtime)
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'native-dsh-consumer', private: true, type: 'module', packageManager: manifest.packageManager,
      dependencies: { '@deepseek-ai/dsh': dshTestVersion } }) + '\n')
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), 'packages:\n  - .\nautoInstallPeers: true\n')
    runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile'], runtime)
    const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
    const dsh = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    assert.equal(dsh.version, dshTestVersion)
    dshBin = join(packageRoot, typeof dsh.bin === 'string' ? dsh.bin : dsh.bin.dsh)
  }
  dshBin = resolve(dshBin)
  const runtimeManifest = JSON.parse(await readFile(join(dirname(dshBin), '..', 'package.json'), 'utf8'))
  assert.equal(runtimeManifest.name, '@deepseek-ai/dsh', 'DSH_BIN must point to the native CLI package entry')
  assert.equal(runtimeManifest.version, dshTestVersion, 'DSH_BIN version differs from the verified target')
  let spec = resolve(option('--archive') ?? join(root, 'dist/dsh-shared-config.tgz'))
  let repository
  let expectedCommit
  if (source) {
    repository = (option('--repository') ?? manifest.repository.url).replace(/^git\+/, '')
    const ref = option('--ref')
    const checkout = join(temp, 'source')
    run('git', ['clone', '--no-checkout', '--filter=blob:none', repository, checkout], root)
    if (ref && /^[a-f0-9]{40}$/.test(ref)) {
      run('git', ['fetch', 'origin', ref], checkout)
      expectedCommit = run('git', ['rev-parse', 'FETCH_HEAD^{commit}'], checkout, process.env, true).trim()
      assert.equal(expectedCommit, ref, 'Fixed Git commit resolved differently')
    } else {
      const refs = run('git', ['ls-remote', repository, ref ? 'refs/tags/' + ref : 'HEAD', ...(ref ? ['refs/tags/' + ref + '^{}'] : [])], root, process.env, true).trim().split(/\r?\n/)
      assert.ok(refs[0], 'Git source ref is missing')
      expectedCommit = (refs.find(line => line.endsWith('^{}')) ?? refs[0]).split(/\s+/)[0]
    }
    assert.match(expectedCommit, /^[a-f0-9]{40}$/, 'Git source must resolve to an exact commit')
    if (option('--commit')) assert.equal(expectedCommit, option('--commit'), 'Remote source ref moved')
    run('git', ['checkout', '--detach', expectedCommit], checkout)
    const files = run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], checkout, process.env, true).split(/\r?\n/)
    assert.ok(!files.some(file => file.startsWith('lib/')), 'Git source must not include prebuilt lib')
    const sourceManifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
    assert.equal(sourceManifest.config.dshTestVersion, dshTestVersion, 'Git source DSH target differs')
    assert.equal(sourceManifest.version, manifest.version, 'Git source version differs')
    assert.equal(sourceManifest.packageManager, manifest.packageManager, 'Git source package manager differs')
    assert.ok(sourceManifest.scripts.prepare, 'Git source must declare its prepare build')
    spec = 'git+' + repository + (ref ? '#' + ref : '')
    console.log('Native source ' + (ref ?? 'default branch') + ' resolves to ' + expectedCommit)
  }
  const home = join(temp, 'home')
  const profile = join(home, 'profiles', 'headless')
  await mkdir(profile, { recursive: true })
  const allowBuilds = source ? { [manifest.name + '@git+' + repository + '#' + expectedCommit]: true } : {}
  if (source && repository.startsWith('https://github.com/')) {
    const slug = repository.slice('https://github.com/'.length).replace(/\.git$/, '')
    allowBuilds[manifest.name + '@https://codeload.github.com/' + slug + '/tar.gz/' + expectedCommit] = true
  }
  await writeFile(join(profile, 'pnpm-workspace.yaml'), YAML.stringify({ packages: ['.'], autoInstallPeers: true, allowBuilds }))
  const bin = join(temp, 'bin')
  await mkdir(bin)
  const launcherArgs = /\.[cm]?js$/i.test(pnpm) ? [process.execPath, pnpm] : [pnpm]
  if (process.platform === 'win32') {
    await writeFile(join(bin, 'pnpm.cmd'), '@' + launcherArgs.map(arg => '"' + arg + '"').join(' ') + ' %*\r\n')
  } else {
    const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'"
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec ' + launcherArgs.map(quote).join(' ') + ' "$@"\n')
    await chmod(join(bin, 'pnpm'), 0o755)
  }
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY: '0', CI: 'true' }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = bin + delimiter + dirname(process.execPath) + delimiter + (process.env.PATH ?? '')
  const peers = Object.keys(manifest.peerDependencies).map(name => name + '@' + manifest.devDependencies[name])
  run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', spec, ...peers, '@deepseek-ai/dsh-scope@' + manifest.devDependencies['@deepseek-ai/dsh-scope']], temp, env)
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', manifest.name, 'package.json'), 'utf8'))
  assert.equal(installed.version, manifest.version)
  if (source) {
    const lock = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
    assert.ok(lock.includes(expectedCommit), 'Native lockfile did not record the resolved Git commit')
  }
  await readFile(join(profile, 'node_modules', manifest.name, 'lib/index.js'))
  await readFile(join(profile, 'node_modules', manifest.name, 'lib/agent-prompt.js'))
  await copyFile(new URL('./package-smoke.mjs', import.meta.url), join(profile, 'package-smoke.mjs'))
  run(process.execPath, ['package-smoke.mjs'], profile, env)
  console.log('Verified native ' + (source ? spec + ' at ' + expectedCommit : 'candidate tarball') + ', exports, Loader activation, and configuration behavior')
  passed = true
} finally {
  if (passed) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  else console.error('Native install failed; retained source, home, and diagnostics at ' + temp)
}
