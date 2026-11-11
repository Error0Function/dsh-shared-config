/** Preset-selected guidance and bundle patch composition. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt, { renderPrompt, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { parse } from 'yaml'
import * as AgentPrompt from '../src/agent-prompt.ts'

test('gates shared-config guidance by the live Agent preset', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    const creatorScope = createScope(ctx, { agent: 'creator' })
    const standardScope = createScope(ctx, { agent: 'standard' })
    let creatorPreset = 'cordis'
    ctx.provide('agentPresets', {
      composedPreset: (agentContext: Context) => agentContext === creatorScope.ctx ? creatorPreset : 'preset-standard',
    })
    const creator = { ctx: creatorScope.ctx, session: { header: { agentPreset: 'standard' } } }
    const standard = { ctx: standardScope.ctx, session: { header: { agentPreset: 'cordis' } } }
    const fiber = await ctx.plugin(AgentPrompt)
    const assemble = (agent: typeof creator | typeof standard) => ctx.systemPrompt.assemble({
      scope: scopeOf(agent.ctx), agent,
    } as AssembleContext & { readonly agent: typeof agent })

    const creatorPrompt = renderPrompt(await assemble(creator))
    assert.match(creatorPrompt, /multiple DSH profiles using the same \$DSH_HOME/u)
    assert.match(creatorPrompt, /Finish the plugin task/u)
    assert.doesNotMatch(renderPrompt(await assemble(standard)), /dsh-shared-config/u)
    assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble()), /dsh-shared-config/u)
    creatorPreset = 'standard'
    assert.doesNotMatch(renderPrompt(await assemble(creator)), /dsh-shared-config/u)
    creatorPreset = 'cordis'
    assert.match(renderPrompt(await assemble(creator)), /dsh-shared-config/u)
    await fiber.dispose()
    assert.doesNotMatch(renderPrompt(await assemble(creator)), /dsh-shared-config/u)
    await creatorScope.dispose()
    await standardScope.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('validates preset IDs with defaults and a serializable schema', () => {
  const serialized = JSON.parse(JSON.stringify(AgentPrompt.Config))
  const list = serialized.refs[serialized.refs[serialized.uid].dict.presetIds]
  const item = serialized.refs[list.inner]
  assert.equal(list.type, 'array')
  assert.equal(item.type, 'string')
  assert.deepEqual(list.meta.default, ['cordis'])
  assert.deepEqual(item.meta.pattern, { source: '\\S', flags: 'u' })
  assert.equal(item.meta.required, true)
  for (const schema of [AgentPrompt.Config, new z<AgentPrompt.Config>(serialized)]) {
    assert.deepEqual(schema(), { presetIds: ['cordis'] })
    assert.deepEqual(schema({ presetIds: [] }), { presetIds: [] })
    assert.deepEqual(schema({ presetIds: ['cordis', 'ptc-creator'] }), { presetIds: ['cordis', 'ptc-creator'] })
    assert.deepEqual(schema({ presetIds: [' custom preset/中文 '] }), { presetIds: [' custom preset/中文 '] })
    for (const invalid of [[''], [' \t\n'], [null], [42], [undefined], 'cordis', {}]) {
      assert.throws(() => schema({ presetIds: invalid as string[] }))
    }
  }
})

test('preserves live, projection and header identity precedence', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    const scope = createScope(ctx, { agent: 'identity-fallback' })
    let live: unknown
    let projection: unknown
    let liveThrows = false
    let projectionThrows = false
    ctx.provide('agentPresets', { composedPreset: () => {
      if (liveThrows) throw new Error('live unavailable')
      return live
    } })
    ctx.provide('sessionProjections', { stateOf: () => {
      if (projectionThrows) throw new Error('projection unavailable')
      return projection
    } })
    await ctx.plugin(AgentPrompt, { presetIds: ['ptc-creator', ' custom preset/中文 '] })
    const agent = { ctx: scope.ctx, session: { header: { agentPreset: 'ptc-creator' } } }
    const assemble = async () => renderPrompt(await ctx.systemPrompt.assemble({
      scope: scopeOf(agent.ctx), agent,
    } as AssembleContext & { readonly agent: typeof agent }))
    const cases = [
      { live: 'ptc-creator', projection: 'standard', header: 'standard', enabled: true },
      { live: 'standard', projection: 'ptc-creator', header: 'ptc-creator', enabled: false },
      { live: undefined, projection: 'ptc-creator', header: 'standard', enabled: true },
      { live: '', projection: 'standard', header: 'ptc-creator', enabled: false },
      { live: 42, projection: 'ptc-creator', header: 'standard', enabled: true },
      { live: undefined, projection: undefined, header: 'ptc-creator', enabled: true },
      { live: undefined, projection: '', header: 'ptc-creator', enabled: true },
      { live: undefined, projection: 42, header: 'ptc-creator', enabled: true },
      { live: 'ignored', projection: 'ptc-creator', header: 'standard', liveThrows: true, enabled: true },
      { live: undefined, projection: 'ignored', header: 'ptc-creator', projectionThrows: true, enabled: true },
      { live: ' custom preset/中文 ', projection: undefined, header: 'standard', enabled: true },
      { live: 'custom preset/中文', projection: undefined, header: 'standard', enabled: false },
      { live: undefined, projection: undefined, header: 'unknown', enabled: false },
    ]
    for (const scenario of cases) {
      live = scenario.live
      projection = scenario.projection
      liveThrows = scenario.liveThrows ?? false
      projectionThrows = scenario.projectionThrows ?? false
      agent.session.header.agentPreset = scenario.header
      assert.equal((await assemble()).includes('dsh-shared-config'), scenario.enabled, JSON.stringify(scenario))
    }
    await scope.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('assembles configured guidance through the Loader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-config-prompt-'))
  const configs = { default: {}, custom: { presetIds: ['ptc-creator'] }, multiple: { presetIds: ['cordis', 'ptc-creator'] }, disabled: { presetIds: [] } }
  const actual: Record<string, Record<string, boolean>> = {}
  let guidance = ''
  try {
    for (const [label, config] of Object.entries(configs)) {
      const filename = join(directory, `${label}.yml`)
      await writeFile(filename, JSON.stringify([
        { id: 'system-prompt', name: 'cordis:systemPrompt' },
        { id: 'shared-config-agent-prompt', name: 'cordis:agentPrompt', config },
      ]))
      const ctx = await boot('test', filename, [], root => {
        Object.assign(root.loader.builtins, { systemPrompt: SystemPrompt, agentPrompt: AgentPrompt })
      })
      try {
        const scope = createScope(ctx, { agent: 'loader-prompt' })
        const selection: Record<string, boolean> = {}
        for (const identity of ['cordis', 'ptc-creator', 'standard']) {
          const agent = { ctx: scope.ctx, session: { header: { agentPreset: identity } } }
          const prompt = renderPrompt(await ctx.systemPrompt.assemble({
            scope: scopeOf(agent.ctx), agent,
          } as AssembleContext & { readonly agent: typeof agent }))
          selection[identity] = prompt.includes('dsh-shared-config')
          if (label === 'default' && identity === 'cordis') guidance = prompt
        }
        actual[label] = selection
        await scope.dispose()
      } finally {
        await ctx.fiber.dispose()
      }
    }
    assert.deepEqual(actual, {
      default: { cordis: true, 'ptc-creator': false, standard: false },
      custom: { cordis: false, 'ptc-creator': true, standard: false },
      multiple: { cordis: true, 'ptc-creator': true, standard: false },
      disabled: { cordis: false, 'ptc-creator': false, standard: false },
    })
    t.assert.snapshot({ guidance, selection: actual })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('mounts the prompt as a root contribution', async () => {
  const rows = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<Record<string, unknown>>
  const rootInsert = rows.find(row => row.insert)?.insert as Array<Record<string, unknown>> | undefined
  assert.deepEqual(rootInsert?.find(row => row.id === 'shared-config-agent-prompt'), {
    id: 'shared-config-agent-prompt', name: 'dsh-shared-config/agent-prompt',
  })
  assert.equal(rows.some(row => row.id === 'preset-cordis'), false)
})
