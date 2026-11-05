/** Credential-free cold boot and shared edit using only a clean consumer's installed files. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import SharedConfigEditor from 'dsh-shared-config'

const consumer = process.cwd()
const home = await mkdtemp(join(consumer, '.smoke-home-'))
const contexts = []
try {
  const fixture = join(consumer, 'node_modules', 'shared-config-fixture')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'shared-config-fixture', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(fixture, 'cordis.patch.yml'), `- insert:
    - id: config-editor
      name: '@deepseek-ai/dsh-config-editor'
    - id: example
      name: cordis:example
      config: { count: 3 }
    - id: shortcuts
      name: cordis:example
      config: { count: 5 }
`)
  const start = async name => {
    const dir = join(home, 'profiles', name)
    initProfile(dir, ['shared-config-fixture', 'dsh-shared-config'])
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const profile = {
      name, startedBundles: ['shared-config-fixture', 'dsh-shared-config'],
      dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(consumer, 'package.json'), cwd: consumer, home,
      overlays: [], telemetryDisabledEnv: undefined,
    }
    const loaded = loadProfileDirectory('dsh', dir, profile.installAnchor)
    assert.deepEqual(loaded.skippedBundles, [])
    const ctx = await boot('dsh', join(dir, 'cordis.yml'), readProfilePatches('dsh', profile), root => {
      root.provide('profileContext', profile)
      root.loader.builtins.example = { Config: z.object({ count: z.number().min(0) }), apply() {} }
    })
    contexts.push(ctx)
    assert.ok(ctx.configEditor instanceof SharedConfigEditor)
    const entries = [...ctx.loader.entries()]
    assert.equal(entries.find(entry => entry.options.id === 'config-editor')?.options.disabled, true)
    assert.equal(entries.find(entry => entry.options.id === 'shared-config-editor')?.fiber?.state, 2)
    assert.equal(entries.find(entry => entry.options.id === 'shortcuts')?.fiber?.state, 2)
    return ctx
  }
  const desktop = await start('desktop')
  const entry = desktop.configEditor.entries().find(item => item.options.id === 'example')
  assert.ok(entry)
  await desktop.configEditor.edit(entry, current => ({ ...current, count: 7 }))
  const accepted = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
  assert.match(accepted, /count: 7/)
  await assert.rejects(desktop.configEditor.edit(entry, () => ({ count: -1 })))
  assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), accepted)
  const web = await start('web')
  const row = web.configEditor.configuration().find(item => item.entry.options.id === 'example')
  assert.ok(row)
  assert.equal(row.override.count, 7)
  assert.equal(row.inherited.count, 3)
  await web.configEditor.edit(row.entry, (_current, inherited) => inherited)
  assert.doesNotMatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), /id: example/)
  console.log('Packed bundle cold boot, unchanged shortcuts, edit, rejection, cross-profile restore, and reset passed')
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
