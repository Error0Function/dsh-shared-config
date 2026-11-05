/** Refuse mismatched release tags and write a checksum for the verified package. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.argv[2]
assert.equal(tag, `v${version}`, `Release tag must be v${version}`)
const prerelease = version.includes('-')
const archive = new URL('../dist/dsh-shared-config.tgz', import.meta.url)
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(new URL('../dist/SHA256SUMS', import.meta.url), `${digest}  dsh-shared-config.tgz\n`)
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`)
console.log(`Release ${tag}; prerelease=${prerelease}; sha256=${digest}`)
