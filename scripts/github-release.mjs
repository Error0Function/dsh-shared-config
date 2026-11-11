/** Validate immutable GitHub assets, upload missing files, and compare both copies. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import { candidateFiles } from './candidate.mjs'

export function githubPlan(release, latest, candidate, tagCommit, files) {
  assert.equal(tagCommit, candidate.sourceCommit, 'Release tag points to a different commit')
  const prerelease = semver.prerelease(candidate.version) !== null
  const latestVersion = latest?.tag_name
  if (latestVersion) assert.ok(semver.valid(latestVersion), 'Invalid GitHub latest release tag')
  const makeLatest = !prerelease && (!latestVersion || semver.gte(candidate.version, latestVersion))
  if (!release) return { create: true, prerelease, makeLatest, missing: [...candidateFiles] }
  assert.equal(release.tag_name, candidate.version, 'GitHub Release tag differs from candidate')
  assert.equal(release.prerelease, prerelease, 'GitHub Release prerelease status differs')
  assert.equal(release.draft, false, 'Existing GitHub Release is a draft')
  const missing = []
  for (const name of candidateFiles) {
    const matches = release.assets.filter(asset => asset.name === name)
    assert.ok(matches.length <= 1, 'Duplicate GitHub Release asset: ' + name)
    if (!matches.length) missing.push(name)
    else assert.ok(files.get(name)?.equals(files.get('local:' + name)), 'GitHub Release asset differs from candidate: ' + name)
  }
  return { create: false, prerelease, makeLatest, missing }
}

async function main() {
  const [mode] = process.argv.slice(2)
  assert.ok(['--check', '--publish', '--verify'].includes(mode), 'Use --check, --publish, or --verify')
  const candidate = JSON.parse(await readFile(new URL('../dist/candidate.json', import.meta.url), 'utf8'))
  const repo = process.env.GITHUB_REPOSITORY
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/, 'GITHUB_REPOSITORY is required')
  const headers = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  async function api(path, options = {}, allowMissing = false) {
    const response = await fetch('https://api.github.com/repos/' + repo + path, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30000) })
    if (allowMissing && response.status === 404) return undefined
    assert.ok(response.ok, 'GitHub API ' + path + ': HTTP ' + response.status)
    return response.json()
  }
  let tag = await api('/git/ref/tags/' + encodeURIComponent(candidate.version))
  while (tag.object.type === 'tag') tag = await api('/git/tags/' + tag.object.sha)
  assert.equal(tag.object.type, 'commit', 'Release tag must resolve to a commit')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(sourceCommit, candidate.sourceCommit, 'Checkout differs from candidate')
  const latest = await api('/releases/latest', {}, true)
  let release = await api('/releases/tags/' + encodeURIComponent(candidate.version), {}, true)
  const files = new Map()
  for (const name of candidateFiles) files.set('local:' + name, await readFile(new URL('../dist/' + name, import.meta.url)))
  if (release) {
    const assets = []
    for (let page = 1; ; page++) {
      const batch = await api('/releases/' + release.id + '/assets?per_page=100&page=' + page)
      assets.push(...batch)
      if (batch.length < 100) break
    }
    release.assets = assets
    for (const asset of assets.filter(asset => candidateFiles.includes(asset.name))) {
      const response = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(30000) })
      assert.ok(response.ok, 'GitHub asset download failed: HTTP ' + response.status)
      files.set(asset.name, Buffer.from(await response.arrayBuffer()))
    }
  }
  const plan = githubPlan(release, latest, candidate, tag.object.sha, files)
  if (mode === '--verify') {
    assert.ok(!plan.create && plan.missing.length === 0, 'GitHub Release is incomplete')
    await writeFile(new URL('../dist/github-published.tgz', import.meta.url), files.get('dsh-shared-config.tgz'))
    console.log('Verified GitHub tag, candidate identity, and all downloaded asset bytes')
    return
  }
  if (mode === '--check') {
    console.log('GitHub Release checked; missing assets: ' + plan.missing.join(', '))
    return
  }
  if (plan.create) {
    release = await api('/releases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      tag_name: candidate.version, target_commitish: candidate.sourceCommit, name: candidate.version,
      draft: false, prerelease: plan.prerelease, make_latest: String(plan.makeLatest), generate_release_notes: true,
    }) })
  }
  for (const name of plan.missing) {
    const url = release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(name)
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: files.get('local:' + name), signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, 'GitHub asset upload failed without replacing any asset: HTTP ' + response.status)
  }
  console.log('Uploaded missing GitHub assets; existing assets were preserved')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
