/** Installation policy evaluated by the public DSH compatibility checker. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest: object = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('installation permits later 0.2 versions, including prereleases', () => {
  for (const version of ['0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2', '0.2.3-alpha.1', '0.2.99']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
})

test('installation rejects versions below the baseline and the next minor series', () => {
  for (const version of ['0.2.1', '0.2.2-alpha.1', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, version)
    assert.equal(issue.exempted, false)
  }
})
