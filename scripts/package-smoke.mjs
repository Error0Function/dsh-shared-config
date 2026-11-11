/** Run the packed bundle from a clean consumer without credentials. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, loadProfileDirectory, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SharedConfigEditor from 'dsh-shared-config'
import * as AgentPrompt from 'dsh-shared-config/agent-prompt'

assert.equal(typeof AgentPrompt.apply, 'function')

const consumer = process.cwd()
const home = await mkdtemp(join(consumer, '.smoke-home-'))
const contexts = []
try {
  const presetModule = join(consumer, 'node_modules', '@deepseek-ai', 'dsh-agent-preset')
  await mkdir(presetModule, { recursive: true })
  await writeFile(join(presetModule, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-preset', version: '1.0.0', type: 'module', exports: './index.js' }))
  await writeFile(join(presetModule, 'index.js'), `export default class AgentPreset {
  static [Symbol.for('cordis.group')] = true
  constructor(_ctx, config) {
    globalThis.__dshSharedConfigPresetConfigs ??= []
    globalThis.__dshSharedConfigPresetConfigs.push(config)
  }
}
`)
  const fixture = join(consumer, 'node_modules', 'shared-config-fixture')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'shared-config-fixture', version: '1.0.0',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(fixture, 'cordis.patch.yml'), `- insert:
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
    - id: config-editor
      name: '@deepseek-ai/dsh-config-editor'
    - id: example
      name: cordis:example
      config: { count: 3 }
    - id: shortcuts
      name: cordis:example
      config: { count: 5 }
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        name: Cordis
        description: ''
        order: 0
        plugins: []
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
  const creatorScope = createScope(desktop, { agent: 'creator' })
  const standardScope = createScope(desktop, { agent: 'standard' })
  const creator = { ctx: creatorScope.ctx, session: { header: { agentPreset: 'cordis' } } }
  const standard = { ctx: standardScope.ctx, session: { header: { agentPreset: 'standard' } } }
  assert.match(renderPrompt(await desktop.systemPrompt.assemble({ scope: scopeOf(creator.ctx), agent: creator })), /dsh-shared-config/u)
  assert.doesNotMatch(renderPrompt(await desktop.systemPrompt.assemble({ scope: scopeOf(standard.ctx), agent: standard })), /dsh-shared-config/u)
  const promptEntry = desktop.configEditor.entries().find(item => item.options.id === 'shared-config-agent-prompt')
  assert.ok(promptEntry)
  assert.deepEqual(AgentPrompt.Config(), { presetIds: ['cordis'] })
  await desktop.configEditor.edit(promptEntry, current => ({ ...current, presetIds: ['cordis', 'ptc-creator'] }))
  const customScope = createScope(desktop, { agent: 'custom-creator' })
  const custom = { ctx: customScope.ctx, session: { header: { agentPreset: 'ptc-creator' } } }
  assert.match(renderPrompt(await desktop.systemPrompt.assemble({ scope: scopeOf(custom.ctx), agent: custom })), /dsh-shared-config/u)
  assert.match(renderPrompt(await desktop.systemPrompt.assemble({ scope: scopeOf(creator.ctx), agent: creator })), /dsh-shared-config/u)
  const promptAccepted = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
  await assert.rejects(desktop.configEditor.edit(promptEntry, current => ({ ...current, presetIds: [' '] })))
  assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), promptAccepted)
  await creatorScope.dispose()
  await standardScope.dispose()
  await customScope.dispose()
  const entry = desktop.configEditor.entries().find(item => item.options.id === 'example')
  assert.ok(entry)
  await desktop.configEditor.edit(entry, current => ({ ...current, count: 7 }))
  const accepted = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
  assert.match(accepted, /count: 7/)
  await assert.rejects(desktop.configEditor.edit(entry, () => ({ count: -1 })))
  assert.equal(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), accepted)
  const web = await start('web')
  const promptRow = web.configEditor.configuration().find(item => item.entry.options.id === 'shared-config-agent-prompt')
  assert.ok(promptRow)
  assert.deepEqual(promptRow.override.presetIds, ['cordis', 'ptc-creator'])
  assert.deepEqual(promptRow.inherited, {})
  const webScope = createScope(web, { agent: 'web-creator' })
  const webAgent = { ctx: webScope.ctx, session: { header: { agentPreset: 'ptc-creator' } } }
  const webPrompt = async () => renderPrompt(await web.systemPrompt.assemble({ scope: scopeOf(webAgent.ctx), agent: webAgent }))
  assert.match(await webPrompt(), /dsh-shared-config/u)
  await web.configEditor.edit(promptRow.entry, current => ({ ...current, presetIds: [] }))
  assert.doesNotMatch(await webPrompt(), /dsh-shared-config/u)
  webAgent.session.header.agentPreset = 'cordis'
  assert.doesNotMatch(await webPrompt(), /dsh-shared-config/u)
  await web.configEditor.edit(promptRow.entry, (_current, inherited) => inherited)
  assert.match(await webPrompt(), /dsh-shared-config/u)
  assert.doesNotMatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), /id: shared-config-agent-prompt/u)
  await webScope.dispose()
  const row = web.configEditor.configuration().find(item => item.entry.options.id === 'example')
  assert.ok(row)
  assert.equal(row.override.count, 7)
  assert.equal(row.inherited.count, 3)
  await web.configEditor.edit(row.entry, (_current, inherited) => inherited)
  assert.doesNotMatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8'), /id: example/)
  console.log('Packed bundle smoke test passed for cold boot, unchanged shortcuts, edits, rejection, cross-profile restore, and reset')
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
