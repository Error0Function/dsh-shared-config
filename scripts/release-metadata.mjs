/** Validate npm release identity and compare the downloaded archive byte for byte. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import semver from 'semver'

const registry = 'https://registry.npmjs.org/'

export function releasePlan(version, tag, metadata, integrity, checkOnly = false) {
  assert.equal(semver.valid(version), version, 'Invalid package version: ' + version)
  assert.equal(tag, version, 'Release tag must be ' + version)
  const prerelease = semver.prerelease(version) !== null
  const defaultTag = prerelease ? 'next' : 'latest'
  const current = metadata?.['dist-tags']?.[defaultTag]
  if (current) assert.ok(semver.valid(current), 'Invalid npm ' + defaultTag + ' version: ' + current)
  const distTag = current && semver.gt(current, version) ? 'version-' + version : defaultTag
  const versionTag = metadata?.['dist-tags']?.['version-' + version]
  assert.ok(!versionTag || versionTag === version, 'Version-specific npm tag points to a different version')
  const existing = metadata?.versions?.[version]
  if (existing) {
    const identical = existing.dist?.integrity === integrity
    assert.ok(checkOnly || identical, version + ' already exists on npm with different contents; choose a new version')
    return { prerelease, distTag, defaultTag, publish: false, existing: true, identical }
  }
  return { prerelease, distTag, defaultTag, publish: !checkOnly, existing: false, identical: false }
}

export function verifyDistTags(version, plan, metadata, before) {
  assert.equal(metadata?.['dist-tags']?.[plan.distTag], version, 'npm ' + plan.distTag + ' must point to ' + version)
  const previous = before?.['dist-tags']?.[plan.defaultTag]
  if (plan.distTag !== plan.defaultTag) {
    assert.equal(metadata?.['dist-tags']?.[plan.defaultTag], previous, 'npm default dist-tag changed while backfilling an old version')
  }
}

export async function registryMetadata(name, timeoutMs = 20_000) {
  const response = await fetch(registry + encodeURIComponent(name) + '?check=' + Date.now(), { signal: AbortSignal.timeout(timeoutMs) })
  if (response.status === 404) return undefined
  assert.ok(response.ok, 'npm metadata lookup failed: HTTP ' + response.status)
  return response.json()
}

export async function waitForPublication(name, version, metadata, integrity, distTag, {
  lookup = registryMetadata, pause = sleep, now = () => performance.now(), timeoutMs = 300_000, intervalMs = 10_000,
} = {}) {
  const deadline = now() + timeoutMs
  const missing = name + '@' + version + ' and npm ' + distTag + ' did not become visible within ' + timeoutMs + 'ms'
  for (;;) {
    releasePlan(version, version, metadata, integrity)
    if (metadata?.versions?.[version] && metadata?.['dist-tags']?.[distTag] === version) return metadata
    const remaining = deadline - now()
    assert.ok(remaining > 0, missing)
    await pause(Math.min(intervalMs, remaining))
    const requestBudget = Math.floor(deadline - now())
    assert.ok(requestBudget > 0, missing)
    metadata = await lookup(name, Math.min(20_000, requestBudget))
  }
}

async function main() {
  const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const [tag, mode] = process.argv.slice(2)
  assert.ok(mode === undefined || mode === '--check-only' || mode === '--verify', 'Unknown release mode')
  const archive = await readFile(new URL('../dist/dsh-shared-config.tgz', import.meta.url))
  const digest = createHash('sha256').update(archive).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
  let metadata = await registryMetadata(name)
  const plan = releasePlan(version, tag, metadata, integrity, mode === '--check-only')
  if (mode === '--verify') {
    const before = JSON.parse(await readFile(new URL('../dist/npm-plan.json', import.meta.url), 'utf8'))
    if (before.plan.publish) {
      console.log('Verifying npm visibility for ' + name + '@' + version + ' and ' + before.plan.distTag + ' (up to 5 minutes)')
      metadata = await waitForPublication(name, version, metadata, integrity, before.plan.distTag)
    }
    const published = metadata?.versions?.[version]
    assert.ok(published, name + '@' + version + ' is not on npm')
    if (before.plan.publish) verifyDistTags(version, before.plan, metadata, before.metadata)
    const response = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(20000) })
    assert.ok(response.ok, 'npm tarball download failed: HTTP ' + response.status)
    const downloaded = Buffer.from(await response.arrayBuffer())
    assert.ok(downloaded.equals(archive), 'Published tarball differs from the tested archive')
    await writeFile(new URL('../dist/npm-published.tgz', import.meta.url), downloaded)
    console.log('Verified npm ' + name + '@' + version + ' and exact archive bytes')
    return
  }
  await writeFile(new URL('../dist/npm-plan.json', import.meta.url), JSON.stringify({ plan, metadata }) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      'prerelease=' + plan.prerelease + '\ndist_tag=' + plan.distTag + '\npublish=' + plan.publish + '\nexisting=' + plan.existing + '\n')
  }
  if (mode === '--check-only' && plan.existing && !plan.identical) {
    console.log('Rehearsal only: ' + version + ' already exists with different contents; a new version is required to publish')
  }
  console.log('Release ' + tag + '; dist-tag=' + plan.distTag + '; publish=' + plan.publish + '; sha256=' + digest)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
