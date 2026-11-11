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
import * as AgentPrompt from '../src/agent-prompt.ts'
import SystemPrompt, { renderPrompt, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

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

test('shares preset guidance settings, preserves profile overrides and isolates other homes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shared-guidance-'))
  const contexts = new Set<Context>()
  try {
    const makeProfile = async (home: string, name: string): Promise<ProfileContext> => {
      await mkdir(home, { recursive: true })
      await writeFile(join(home, 'package.json'), '{"name":"shared-guidance-test"}\n')
      const dir = join(home, 'profiles', name)
      initProfile(dir, ['test-bundle'])
      const bundle = join(dir, 'node_modules', 'test-bundle')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'shared-config-editor', name: 'cordis:editor' },
        { id: 'system-prompt', name: 'cordis:systemPrompt' },
        { id: 'shared-config-agent-prompt', name: 'cordis:agentPrompt' },
      ] }]))
      await writeFile(join(dir, 'cordis.yml'), '[]\n')
      return { name, startedBundles: ['test-bundle'], dir,
        patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
        cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    }
    const home = join(directory, 'shared-home')
    const profileA = await makeProfile(home, 'default')
    const profileB = await makeProfile(home, 'custom')
    const profileC = await makeProfile(join(directory, 'separate-home'), 'default')
    const localPatch = JSON.stringify([{ id: 'shared-config-agent-prompt', config: { presetIds: ['ptc-creator'] } }])
    await writeFile(profileB.patchPath, localPatch)
    const start = async (profile: ProfileContext): Promise<Context> => {
      const context = await boot('test', join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile), root => {
        root.provide('profileContext', profile)
        Object.assign(root.loader.builtins, { editor: SharedConfigEditor, systemPrompt: SystemPrompt, agentPrompt: AgentPrompt })
      })
      contexts.add(context)
      return context
    }
    const entryFor = (context: Context) => context.configEditor.entries().find(entry => entry.options.id === 'shared-config-agent-prompt')!
    const hasGuidance = async (context: Context, identity: string): Promise<boolean> => {
      const scope = createScope(context, { agent: 'shared-guidance' })
      try {
        const agent = { ctx: scope.ctx, session: { header: { agentPreset: identity } } }
        return renderPrompt(await context.systemPrompt.assemble({
          scope: scopeOf(agent.ctx), agent,
        } as AssembleContext & { readonly agent: typeof agent })).includes('dsh-shared-config')
      } finally {
        await scope.dispose()
      }
    }
    let contextA = await start(profileA)
    const contextB = await start(profileB)
    const contextC = await start(profileC)
    const entryB = entryFor(contextB)
    assert.equal(await hasGuidance(contextA, 'cordis'), true)
    assert.equal(await hasGuidance(contextB, 'ptc-creator'), true)
    assert.equal(await hasGuidance(contextB, 'cordis'), false)
    assert.equal(await hasGuidance(contextC, 'cordis'), true)

    await contextA.configEditor.edit(entryFor(contextA), () => ({ presetIds: ['ptc-creator'] }))
    assert.equal(await hasGuidance(contextA, 'cordis'), false)
    assert.equal(await hasGuidance(contextA, 'ptc-creator'), true)
    await contextB.configEditor.edit(entryB, current => {
      assert.deepEqual(current, { presetIds: ['ptc-creator'] })
      return { presetIds: [] }
    })
    assert.equal(await hasGuidance(contextB, 'ptc-creator'), false)
    await contextA.fiber.dispose()
    contexts.delete(contextA)
    contextA = await start(profileA)
    assert.equal(await hasGuidance(contextA, 'cordis'), false)
    assert.equal(await hasGuidance(contextA, 'ptc-creator'), false)
    const sharedPath = join(home, 'cordis.patch.yml')
    const beforeInvalid = await readFile(sharedPath, 'utf8')
    await assert.rejects(contextB.configEditor.edit(entryB, () => ({ presetIds: [''] })))
    assert.equal(await readFile(sharedPath, 'utf8'), beforeInvalid)
    assert.equal(await hasGuidance(contextB, 'ptc-creator'), false)

    await contextB.configEditor.edit(entryB, (_current, inherited) => {
      assert.deepEqual(inherited, { presetIds: ['ptc-creator'] })
      return inherited
    })
    assert.equal(await hasGuidance(contextB, 'ptc-creator'), true)
    await contextA.fiber.dispose()
    contexts.delete(contextA)
    contextA = await start(profileA)
    assert.equal(await hasGuidance(contextA, 'cordis'), true)
    assert.equal(await hasGuidance(contextA, 'ptc-creator'), false)
    assert.equal(await readFile(profileB.patchPath, 'utf8'), localPatch)
    assert.equal(await hasGuidance(contextC, 'cordis'), true)
    await assert.rejects(readFile(join(profileC.home, 'cordis.patch.yml')), { code: 'ENOENT' })
  } finally {
    for (const context of contexts) await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
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

    let applyFailuresRemaining = 0
    const example = {
      Config: z.object({ count: z.number().min(0).default(3) }),
      apply() {
        if (applyFailuresRemaining > 0) {
          applyFailuresRemaining -= 1
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

    await reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: { __jsExpr: '6 + 4' } }))
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 10 })
    assert.match(await readFile(sharedPath, 'utf8'), /!!js 6 \+ 4/u)
    const beforeInvalidExpression = await readFile(sharedPath, 'utf8')
    await assert.rejects(reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: { __jsExpr: '-1' } })))
    assert.equal(await readFile(sharedPath, 'utf8'), beforeInvalidExpression)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 10 })
    await reloadedB.configEditor.edit(reloadedEntryB, (_current, inherited) => inherited)

    const beforeInvalidEdit = await readFile(sharedPath, 'utf8')
    await assert.rejects(reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: -1 })))
    assert.equal(await readFile(sharedPath, 'utf8'), beforeInvalidEdit)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 5 })

    const beforeReconcileFailure = await readFile(sharedPath, 'utf8')
    applyFailuresRemaining = 1
    await assert.rejects(reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: 12 })), /simulated plugin restart failure/)
    assert.equal(await readFile(sharedPath, 'utf8'), beforeReconcileFailure)
    assert.deepEqual(reloadedEntryB.fiber?.effectiveConfig, { count: 5 })

    applyFailuresRemaining = 2
    const beforeRollbackFailure = await readFile(sharedPath, 'utf8')
    await assert.rejects(
      reloadedB.configEditor.edit(reloadedEntryB, () => ({ count: 13 })),
      error => error instanceof AggregateError
        && error.errors.length === 2
        && /restoring the previous configuration failed too/u.test(error.message),
    )
    assert.equal(await readFile(sharedPath, 'utf8'), beforeRollbackFailure)

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
