/** Shared native ConfigEditor behavior through real Loader composition. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import SharedConfigEditor from '../src/index.ts'
import { editPatch } from '../src/document.ts'

test('stores config while retaining unrelated YAML', () => {
  const raw = '# user comment\n- id: ordinary\n  config:\n    expression: !!js ctx.value\n'
  const next = editPatch(raw, 'new-user-plugin', 'user-plugin', { custom: { setting: 7 } })
  assert.ok(next.includes('# user comment') && next.includes('!!js ctx.value'))
  assert.ok(next.includes('new-user-plugin') && next.includes('setting: 7'))
})
test('reset removes the shared config while retaining activation metadata', () => {
  const next = editPatch('- id: item\n  disabled: true\n  config: { count: 4 }\n', 'item', 'example', undefined)
  assert.deepEqual(parse(next), [{ id: 'item', disabled: true }])
})
test('refuses a shared entry belonging to another module', () => {
  assert.throws(() => editPatch('- id: item\n  name: different\n', 'item', 'example', { count: 4 }), /another plugin/)
  assert.throws(() => editPatch('- id: item\n  name: different\n  config: { count: 4 }\n', 'item', 'example', undefined), /another plugin/)
  assert.throws(() => editPatch('not a list', 'item', 'example', {}), /sequence/)
})

test('shares edits across profiles and resets to each profile inheritance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shared-editor-'))
  let contexts: Context[] = []
  try {
    await writeFile(join(home, 'package.json'), '{"name":"shared-config-test"}\n')
    const makeProfile = async (name: string, count: number): Promise<ProfileContext> => {
      const directory = join(home, 'profiles', name)
      initProfile(directory, ['test-bundle'])
      const bundle = join(directory, 'node_modules', 'test-bundle')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: shared-config-editor\n      name: cordis:editor\n    - id: example\n      name: cordis:example\n      config: { count: ${count} }\n`)
      await writeFile(join(directory, 'cordis.yml'), '[]\n')
      return { name, startedBundles: ['test-bundle'], dir: directory,
        patchPath: join(directory, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
        cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    }
    const profileA = await makeProfile('profile-a', 3)
    const profileB = await makeProfile('profile-b', 5)
    const sharedPath = join(home, 'cordis.patch.yml')
    await writeFile(sharedPath, '# retained home comment\n- id: unrelated\n  name: cordis:unrelated\n  config: { value: 1 }\n')

    let failNextApply = false
    const example = {
      Config: z.object({ count: z.number().min(0).default(3) }),
      apply() {
        if (failNextApply) {
          failNextApply = false
          throw new Error('simulated plugin restart failure')
        }
      },
    }
    const start = async (profile: ProfileContext): Promise<Context> => boot('test', join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile), root => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { editor: SharedConfigEditor, example })
    })
    const entryFor = (context: Context) => context.configEditor.entries().find(entry => entry.options.id === 'example')!

    contexts.push(await start(profileA))
    contexts.push(await start(profileB))
    const [contextA, contextB] = contexts
    const entryA = entryFor(contextA!)
    const entryB = entryFor(contextB!)
    assert.equal(contextA!.configEditor.configuration().find(row => row.entry === entryA)?.inherited.count, 3)
    assert.equal(contextB!.configEditor.configuration().find(row => row.entry === entryB)?.inherited.count, 5)
    assert.equal(entryA.options.name, 'cordis:example')
    assert.equal(entryB.options.name, 'cordis:example')

    await contextA!.configEditor.edit(entryA, current => ({ ...current, count: 7 }))
    assert.equal(contextB!.configEditor.configuration().find(row => row.entry === entryB)?.override.count, 7)
    await contextB!.configEditor.edit(entryB, current => ({ ...current, count: Number(current.count) + 1 }))
    assert.deepEqual(entryB.fiber?.effectiveConfig, { count: 8 })
    const edited = await readFile(sharedPath, 'utf8')
    assert.match(edited, /# retained home comment/u)
    assert.match(edited, /id: unrelated[\s\S]*value: 1/u)
    assert.match(edited, /count: 8/u)

    await contextA!.fiber.dispose()
    contexts = [contextB!]
    const reloadedA = await start(profileA)
    contexts.push(reloadedA)
    const reloadedEntryA = entryFor(reloadedA)
    assert.deepEqual(reloadedEntryA.fiber?.effectiveConfig, { count: 8 })
    await reloadedA.configEditor.edit(reloadedEntryA, (_current, inherited) => inherited)
    assert.deepEqual(reloadedEntryA.fiber?.effectiveConfig, { count: 3 })
    assert.deepEqual(reloadedA.configEditor.configuration().find(row => row.entry === reloadedEntryA)?.override, {})

    await contextB!.fiber.dispose()
    contexts = [reloadedA]
    const reloadedB = await start(profileB)
    contexts.push(reloadedB)
    const reloadedEntryB = entryFor(reloadedB)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 5 })

    const beforeInvalidEdit = await readFile(sharedPath, 'utf8')
    await assert.rejects(reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: -1 })))
    assert.equal(await readFile(sharedPath, 'utf8'), beforeInvalidEdit)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 5 })

    const beforeReconcileFailure = await readFile(sharedPath, 'utf8')
    failNextApply = true
    await assert.rejects(reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: 12 })), /simulated plugin restart failure/)
    assert.equal(await readFile(sharedPath, 'utf8'), beforeReconcileFailure)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 5 })

    const overlayProfile: ProfileContext = { ...profileB, overlays: [{ id: 'example', config: { count: 99 } }] }
    const overlayContext = await start(overlayProfile)
    contexts.push(overlayContext)
    const overlayEntry = entryFor(overlayContext)
    const beforeOverlayEdit = await readFile(sharedPath, 'utf8')
    await assert.rejects(overlayContext.configEditor.edit(overlayEntry, () => ({ count: 6 })), /command-line overlay/)
    assert.equal(await readFile(sharedPath, 'utf8'), beforeOverlayEdit)
    assert.deepEqual(overlayEntry.fiber?.effectiveConfig, { count: 99 })
  } finally {
    for (const context of contexts) await context.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
