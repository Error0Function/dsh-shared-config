/** Freeze and recover the one archive consumed by every release job. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { valid } from 'semver'

export const archiveName = 'dsh-shared-config.tgz'
export const candidateFiles = [archiveName, 'candidate.json', 'SHA256SUMS']
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const lockSha256 = value => sha256(value.toString('utf8').replaceAll('\r\n', '\n'))
const root = new URL('../', import.meta.url)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

export function validateCandidate(candidate, archive, manifest, lock, sourceCommit) {
  assert.equal(candidate.schema, 1, 'Unknown candidate schema')
  assert.equal(candidate.name, manifest.name, 'Candidate package name changed')
  assert.equal(candidate.version, manifest.version, 'Candidate package version changed')
  assert.equal(candidate.sourceCommit, sourceCommit, 'Candidate source commit changed')
  assert.equal(candidate.lockSha256, lockSha256(lock), 'Candidate lockfile changed')
  assert.equal(candidate.packageManager, manifest.packageManager, 'Candidate package manager changed')
  assert.equal(candidate.dsh, manifest.config.dshTestVersion, 'Candidate DSH target changed')
  assert.equal(candidate.archiveSha256, sha256(archive), 'Candidate archive checksum mismatch')
  assert.equal(candidate.archiveIntegrity, 'sha512-' + createHash('sha512').update(archive).digest('base64'), 'Candidate archive integrity mismatch')
  assert.match(candidate.sourceCommit, /^[a-f0-9]{40}$/, 'Candidate source must be an exact commit')
  assert.match(candidate.node, /^v24\./, 'Candidate must use Node 24')
  assert.equal(valid(candidate.dsh), candidate.dsh, 'Candidate DSH target must be an exact version')
  return candidate
}

export function recoveryPlan(artifacts, name, attempt, requestedRun) {
  const matches = artifacts.filter(artifact => artifact.name === name)
  assert.ok(matches.length <= 1, 'Multiple candidates exist for the same source')
  if (matches.length) {
    assert.ok(!matches[0].expired, 'Original candidate expired; do not rebuild a release retry')
    return { restore: true, artifactId: String(matches[0].id) }
  }
  assert.ok(!requestedRun && Number(attempt) === 1, 'Original candidate is missing; do not rebuild a release retry')
  return { restore: false, artifactId: '' }
}

async function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''))
  }
}

async function main() {
  const mode = process.argv[2]
  const sourceCommit = git('rev-parse', 'HEAD')
  if (mode === '--lookup') {
    const requestedRun = process.env.CANDIDATE_RUN_ID ?? ''
    if (requestedRun) assert.match(requestedRun, /^\d+$/, 'Candidate run id must be numeric')
    const name = 'candidate-' + sourceCommit
    const endpoint = requestedRun ? '/actions/runs/' + requestedRun + '/artifacts?' : '/actions/artifacts?name=' + name + '&'
    const artifacts = []
    for (let page = 1; ; page++) {
      const response = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY + endpoint + 'per_page=100&page=' + page, {
        headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000),
      })
      assert.ok(response.ok, 'Candidate artifact lookup failed: HTTP ' + response.status)
      const result = await response.json()
      artifacts.push(...result.artifacts)
      if (result.artifacts.length < 100) break
    }
    const plan = recoveryPlan(artifacts, name, process.env.GITHUB_RUN_ATTEMPT, requestedRun)
    assert.ok(plan.restore || process.env.REQUIRE_EXISTING !== 'true', 'Release tag must reuse the reviewed candidate from a prior CI run')
    const runId = plan.restore ? (requestedRun || String(artifacts.find(artifact => String(artifact.id) === plan.artifactId).workflow_run.id)) : process.env.GITHUB_RUN_ID
    await output({ restored: plan.restore, artifact_id: plan.artifactId, run_id: runId, artifact_name: name })
    console.log(plan.restore ? 'Reuse original candidate artifact ' + plan.artifactId : 'Create the first candidate for ' + sourceCommit)
    return
  }
  assert.ok(mode === '--create' || mode === '--verify', 'Use --lookup, --create, or --verify')
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const lock = await readFile(new URL('pnpm-lock.yaml', root))
  const archive = await readFile(new URL('dist/' + archiveName, root))
  let candidate
  if (mode === '--create') {
    assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '', 'Create a candidate only from a clean source checkout')
    const pnpm = process.env.npm_execpath
    assert.ok(pnpm, 'Create candidates with pnpm run candidate:create')
    const args = /\.[cm]?js$/i.test(pnpm) ? [pnpm, '--version'] : ['--version']
    const version = execFileSync(/\.[cm]?js$/i.test(pnpm) ? process.execPath : pnpm, args, { encoding: 'utf8' }).trim()
    assert.equal('pnpm@' + version, manifest.packageManager, 'Use the pinned package manager')
    candidate = { schema: 1, name: manifest.name, version: manifest.version, sourceCommit,
      lockSha256: lockSha256(lock), packageManager: manifest.packageManager, node: process.version,
      dsh: manifest.config.dshTestVersion, archiveSha256: sha256(archive),
      archiveIntegrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') }
    await writeFile(new URL('dist/candidate.json', root), JSON.stringify(candidate, null, 2) + '\n')
  } else {
    candidate = JSON.parse(await readFile(new URL('dist/candidate.json', root), 'utf8'))
  }
  validateCandidate(candidate, archive, manifest, lock, sourceCommit)
  const metadata = await readFile(new URL('dist/candidate.json', root))
  const sums = sha256(archive) + '  ' + archiveName + '\n' + sha256(metadata) + '  candidate.json\n'
  if (mode === '--create') await writeFile(new URL('dist/SHA256SUMS', root), sums)
  else assert.equal(await readFile(new URL('dist/SHA256SUMS', root), 'utf8'), sums, 'Candidate checksum manifest changed')
  console.log('Verified candidate ' + candidate.version + ' from ' + sourceCommit + ', sha256=' + candidate.archiveSha256)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
