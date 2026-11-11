/** Release identity, recovery, and immutable-channel regression tests. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import YAML from 'yaml'
import { satisfies, valid } from 'semver'
import { releasePlan, verifyDistTags, waitForPublication } from '../scripts/release-metadata.mjs'
import { candidateFiles, recoveryPlan, sha256, validateCandidate } from '../scripts/candidate.mjs'
import { githubPlan } from '../scripts/github-release.mjs'

const integrity = 'sha512-tested-archive'
const stable = { 'dist-tags': { latest: '0.1.4' }, versions: {} }

test('stable releases advance latest while prereleases use next', () => {
  assert.deepEqual(releasePlan('0.1.5', '0.1.5', stable, integrity), {
    prerelease: false, distTag: 'latest', defaultTag: 'latest', publish: true, existing: false, identical: false,
  })
  assert.equal(releasePlan('0.1.5-alpha.1', '0.1.5-alpha.1', stable, integrity).distTag, 'next')
})

test('canonical versions and exact no-v tags are required', () => {
  assert.throws(() => releasePlan('invalid', 'invalid', stable, integrity), /Invalid package version/)
  assert.throws(() => releasePlan('v0.1.5', 'v0.1.5', stable, integrity), /Invalid package version/)
  assert.throws(() => releasePlan('0.1.5', 'v0.1.5', stable, integrity), /Release tag must/)
  assert.throws(() => releasePlan('0.1.5', '0.1.5', { 'dist-tags': { latest: 'invalid' } }, integrity), /Invalid npm latest/)
})

test('old missing npm versions publish under a version-specific tag without moving latest or next', () => {
  for (const [version, defaultTag, newer] of [['0.1.3', 'latest', '0.1.4'], ['0.2.0-alpha.1', 'next', '0.2.0-alpha.2']]) {
    const before = { 'dist-tags': { [defaultTag]: newer }, versions: {} }
    const plan = releasePlan(version, version, before, integrity)
    assert.equal(plan.distTag, 'version-' + version)
    assert.equal(plan.publish, true)
    verifyDistTags(version, plan, { 'dist-tags': { ...before['dist-tags'], [plan.distTag]: version } }, before)
    assert.throws(() => verifyDistTags(version, plan, { 'dist-tags': { [defaultTag]: version, [plan.distTag]: version } }, before), /default dist-tag changed/)
    assert.throws(() => verifyDistTags(version, plan, before, before), /must point/)
    assert.throws(() => releasePlan(version, version, { 'dist-tags': { ...before['dist-tags'], [plan.distTag]: newer } }, integrity), /Version-specific/)
  }
})

test('an identical published archive resumes without a second publication', () => {
  const metadata = { ...stable, versions: { '0.1.4': { dist: { integrity } } } }
  assert.equal(releasePlan('0.1.4', '0.1.4', metadata, integrity).publish, false)
  assert.equal(releasePlan('0.1.4', '0.1.4', metadata, integrity).identical, true)
})

test('existing npm content mismatches stop publication and rehearsals never publish', () => {
  const metadata = { ...stable, versions: { '0.1.4': { dist: { integrity: 'sha512-old' } } } }
  assert.throws(() => releasePlan('0.1.4', '0.1.4', metadata, integrity), /different contents/)
  assert.equal(releasePlan('0.1.4', '0.1.4', metadata, integrity, true).publish, false)
  assert.equal(releasePlan('0.1.5', '0.1.5', stable, integrity, true).publish, false)
  assert.equal(releasePlan('0.1.0', '0.1.0', undefined, integrity).publish, true)
})

test('npm verification waits for the published version and then keeps the no-republish decision', async () => {
  const visible = { 'dist-tags': { latest: '0.1.5' }, versions: { '0.1.5': { dist: { integrity } } } }
  let elapsed = 0
  let lookups = 0
  const pauses = []
  const metadata = await waitForPublication('dsh-shared-config', '0.1.5', undefined, integrity, 'latest', {
    now: () => elapsed,
    pause: async milliseconds => { pauses.push(milliseconds); elapsed += milliseconds },
    lookup: async name => {
      assert.equal(name, 'dsh-shared-config')
      return ++lookups === 1 ? stable : visible
    },
  })
  assert.equal(metadata, visible)
  assert.deepEqual(pauses, [10_000, 10_000])
  assert.equal(releasePlan('0.1.5', '0.1.5', metadata, integrity).publish, false)
})

test('npm verification also waits for the expected dist-tag and stops on a newly visible wrong archive', async () => {
  const versionOnly = { ...stable, versions: { '0.1.5': { dist: { integrity } } } }
  const visible = { ...versionOnly, 'dist-tags': { latest: '0.1.5' } }
  let elapsed = 0
  let lookups = 0
  const options = {
    now: () => elapsed,
    pause: async milliseconds => { elapsed += milliseconds },
    lookup: async () => { lookups++; return visible },
  }
  assert.equal(await waitForPublication('dsh-shared-config', '0.1.5', versionOnly, integrity, 'latest', options), visible)
  assert.equal(lookups, 1)
  assert.equal(elapsed, 10_000)
  options.lookup = async () => {
    lookups++
    return { ...stable, versions: { '0.1.5': { dist: { integrity: 'sha512-other' } } } }
  }
  await assert.rejects(waitForPublication('dsh-shared-config', '0.1.5', stable, integrity, 'latest', options), /different contents/)
  assert.equal(lookups, 2)
  assert.equal(elapsed, 20_000)
})

test('npm version visibility waiting stops at the deadline and bounds its last request', async () => {
  let elapsed = 0
  const requestBudgets = []
  await assert.rejects(waitForPublication('dsh-shared-config', '0.1.5', stable, integrity, 'latest', {
    timeoutMs: 25_000, now: () => elapsed,
    pause: async milliseconds => { elapsed += milliseconds },
    lookup: async (name, budget) => { requestBudgets.push(budget); return undefined },
  }), /dsh-shared-config@0.1.5 and npm latest did not become visible within 25000ms/)
  assert.equal(elapsed, 25_000)
  assert.deepEqual(requestBudgets, [15_000, 5_000])
})

test('npm visibility waiting propagates network errors and does not wait on an existing identity mismatch', async () => {
  const failure = new Error('npm network failure')
  let lookups = 0
  let pauses = 0
  const options = {
    now: () => 0,
    pause: async () => { pauses++ },
    lookup: async () => { lookups++; throw failure },
  }
  await assert.rejects(waitForPublication('dsh-shared-config', '0.1.5', stable, integrity, 'latest', options), error => error === failure)
  assert.equal(lookups, 1)
  assert.equal(pauses, 1)
  const mismatch = { ...stable, versions: { '0.1.5': { dist: { integrity: 'sha512-other' } } } }
  await assert.rejects(waitForPublication('dsh-shared-config', '0.1.5', mismatch, integrity, 'latest', options), /different contents/)
  assert.equal(lookups, 1)
  assert.equal(pauses, 1)
})

const archive = Buffer.from('the only packed archive')
const lock = Buffer.from('frozen\nlockfile\n')
const sourceCommit = 'a'.repeat(40)
const manifest = { name: 'dsh-shared-config', version: '0.1.5', packageManager: 'pnpm@12.17.0', engines: { dsh: '>=0.2.2-rc.1' }, config: { dshTestVersion: '0.2.2-rc.1' } }
const candidate = { schema: 1, name: manifest.name, version: manifest.version, sourceCommit,
  packageManager: manifest.packageManager, dsh: manifest.config.dshTestVersion, node: 'v24.21.0',
  archiveSha256: sha256(archive), archiveIntegrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), lockSha256: sha256(lock) }

test('candidate verification binds source, toolchain, target, lockfile, and exact archive', () => {
  assert.equal(validateCandidate(candidate, archive, manifest, lock, sourceCommit), candidate)
  assert.equal(validateCandidate(candidate, archive, manifest, Buffer.from(lock.toString().replaceAll('\n', '\r\n')), sourceCommit), candidate)
  for (const [field, value] of Object.entries({ schema: 2, name: 'other', version: '0.1.6', sourceCommit: 'b'.repeat(40),
    packageManager: 'pnpm@11.0.0', dsh: '0.1.0', node: 'v22.0.0', archiveSha256: 'other', archiveIntegrity: 'other', lockSha256: 'other' })) {
    assert.throws(() => validateCandidate({ ...candidate, [field]: value }, archive, manifest, lock, sourceCommit), undefined, field)
  }
  assert.throws(() => validateCandidate(candidate, Buffer.from('repacked'), manifest, lock, sourceCommit), /archive checksum/)
  assert.throws(() => validateCandidate(candidate, archive, manifest, Buffer.from('changed lock'), sourceCommit), /lockfile changed/)
})

test('candidate identity uses the fixed test version independently of compatibility ranges', () => {
  assert.equal(validateCandidate(candidate, archive, { ...manifest, engines: { dsh: '>=0.2.0' } }, lock, sourceCommit), candidate)
  assert.throws(() => validateCandidate(candidate, archive, { ...manifest, config: { dshTestVersion: '0.2.3' } }, lock, sourceCommit), /DSH target changed/)
  assert.throws(() => validateCandidate({ ...candidate, dsh: '>=0.2.2-rc.1' }, archive, { ...manifest, config: { dshTestVersion: '>=0.2.2-rc.1' } }, lock, sourceCommit), /exact version/)
})

test('development dependencies match the fixed DSH test identity within declared ranges', async () => {
  const actual = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const target = actual.config.dshTestVersion
  assert.equal(valid(target), target)
  assert.ok(satisfies(target, actual.engines.dsh))
  for (const [name, range] of Object.entries(actual.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal(actual.devDependencies[name], target, name)
    assert.ok(satisfies(target, range), name)
  }
  assert.equal(actual.devDependencies['@deepseek-ai/dsh-scope'], target)
})

test('retries restore the original candidate and never replace missing or expired archives', () => {
  const name = 'candidate-' + sourceCommit
  assert.deepEqual(recoveryPlan([], name, 1, ''), { restore: false, artifactId: '' })
  assert.deepEqual(recoveryPlan([{ name, id: 123, expired: false }], name, 2, ''), { restore: true, artifactId: '123' })
  assert.throws(() => recoveryPlan([], name, 2, ''), /Original candidate is missing/)
  assert.throws(() => recoveryPlan([], name, 1, '456'), /Original candidate is missing/)
  assert.throws(() => recoveryPlan([{ name, id: 123, expired: true }], name, 1, ''), /Original candidate expired/)
  assert.throws(() => recoveryPlan([{ name, id: 1 }, { name, id: 2 }], name, 1, ''), /Multiple candidates/)
})

const release = { tag_name: candidate.version, prerelease: false, draft: false, assets: candidateFiles.map(name => ({ name })) }
const files = () => new Map(candidateFiles.flatMap(name => [[name, archive], ['local:' + name, archive]]))

test('GitHub recovery skips identical assets and uploads only the missing files', () => {
  assert.deepEqual(githubPlan(release, undefined, candidate, sourceCommit, files()).missing, [])
  assert.deepEqual(githubPlan({ ...release, assets: release.assets.slice(0, 1) }, undefined, candidate, sourceCommit, files()).missing, candidateFiles.slice(1))
  assert.equal(githubPlan(undefined, undefined, candidate, sourceCommit, files()).create, true)
  assert.equal(githubPlan(undefined, { tag_name: '0.1.6' }, candidate, sourceCommit, files()).makeLatest, false)
})

test('GitHub refuses moved tags, wrong release state, duplicate names, and changed asset bytes', () => {
  assert.throws(() => githubPlan(release, undefined, candidate, 'b'.repeat(40), files()), /different commit/)
  for (const update of [{ tag_name: '0.1.6' }, { prerelease: true }, { draft: true }, { assets: [...release.assets, release.assets[0]] }]) {
    assert.throws(() => githubPlan({ ...release, ...update }, undefined, candidate, sourceCommit, files()))
  }
  for (const name of candidateFiles) {
    const changed = files()
    changed.set(name, Buffer.from('different ' + name))
    assert.throws(() => githubPlan(release, undefined, candidate, sourceCommit, changed), /asset differs/)
  }
})

test('CI packs once, distributes one artifact, and release jobs never rebuild it', async () => {
  const ciText = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const releaseText = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const ci = YAML.parse(ciText)
  const workflow = YAML.parse(releaseText)
  assert.equal((ciText.match(/pnpm pack --out/g) ?? []).length, 1)
  assert.doesNotMatch(YAML.stringify(ci.jobs.consume), /pnpm pack|run build|run test:package/)
  assert.doesNotMatch(releaseText, /pnpm pack|run build|run test:package|--clobber|NPM_TOKEN/)
  const matrix = [
    { os: 'ubuntu-26.04', platform: 'linux', arch: 'x64' },
    { os: 'ubuntu-26.04-arm', platform: 'linux', arch: 'arm64' },
    { os: 'windows-2025', platform: 'win32', arch: 'x64' },
    { os: 'windows-11-arm', platform: 'win32', arch: 'arm64' },
    { os: 'macos-26-intel', platform: 'darwin', arch: 'x64' },
    { os: 'macos-26', platform: 'darwin', arch: 'arm64' },
  ]
  for (const name of ['consume', 'source']) {
    assert.deepEqual(ci.jobs[name].strategy.matrix.include, matrix)
    const setup = ci.jobs[name].steps.find(step => step.uses?.startsWith('actions/setup-node@'))
    assert.equal(setup.with.architecture, '${{ matrix.arch }}')
  }
  assert.match(ciText, /config\.dshTestVersion/)
  assert.doesNotMatch(ciText, /engines\.dsh/)
  assert.equal(workflow.concurrency.group, 'release-dsh-shared-config')
  assert.equal(workflow.concurrency.queue, 'max')
  assert.equal(workflow.jobs.release.permissions['id-token'], 'write')
  assert.equal(workflow.jobs.release.needs, 'check')
  assert.match(ciText, /REQUIRE_EXISTING:/)
  assert.match(ciText, /candidate:create/)
  assert.match(ciText, /candidate:verify/)
  assert.match(ciText, /test:source/)
  assert.match(releaseText, /github-release\.mjs --check/)
  assert.match(releaseText, /github-release\.mjs --verify/)
})
