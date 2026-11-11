/** Native configuration edits saved in the shared Harness home. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { composeEntries, loadOptionalPatches, loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type {} from '@deepseek-ai/dsh-hmr'
import { editPatch } from './document.ts'

const flatten = (rows: EntryOptions[]): EntryOptions[] => rows.flatMap(row => [row,
  ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
const ACTIVE = 2 as FiberState.ACTIVE

/** Configure the wait time for the shared cross-process edit lock. */
export interface Config {
  lockWaitMs: number
}

/** Persist native ConfigEditor edits in a file shared by profiles in one DSH home. */
export default class SharedConfigEditor extends ConfigEditor {
  static Config: z<Config> = z.object({
    lockWaitMs: z.number().step(1).min(1).default(30000),
  })

  constructor(private readonly sharedContext: Context, private readonly options: Config) {
    super(sharedContext)
  }

  override get documentPath(): string { return join(this.sharedContext.profileContext.home, 'cordis.patch.yml') }

  override configuration(): ReturnType<ConfigEditor['configuration']> {
    const profile = this.sharedContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const home = loadOptionalPatches('dsh', this.documentPath) ?? []
    const inheritedRows = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))
    return this.entries().map(entry => ({
      entry,
      inherited: structuredClone((inheritedRows.find(row => row.id === entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((home.findLast(row => row.id === entry.options.id && row.config !== undefined)?.config ?? {}) as Record<string, unknown>),
    }))
  }

  override async edit(entry: Entry, change: Parameters<ConfigEditor['edit']>[1]): Promise<void> {
    const run = async (): Promise<void> => withFileLock(this.documentPath, async () => {
      const ctx = this.sharedContext
      const beforePatches = readProfilePatches('dsh', ctx.profileContext)
      await reconcileProfilePatches(ctx.root, beforePatches, 'dsh')
      if (!this.entries().includes(entry) || entry.fiber?.state !== ACTIVE) throw new Error('Configuration entry changed during reload')

      const profile = ctx.profileContext
      const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
      let before: string
      try { before = await readFile(this.documentPath, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; before = '[]\n' }
      const home = yaml.load(before, { schema: entryListSchema }) as PatchOptions[]
      const inheritedRows = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))
      const inherited = structuredClone((inheritedRows.find(candidate => candidate.id === entry.options.id)?.config ?? {}) as Record<string, unknown>)
      const currentRows = flatten(composeEntries([
        ...loaded.layers.map(layer => layer.patches), loaded.patches, home, [...profile.overlays],
      ]))
      const current = structuredClone((currentRows.find(candidate => candidate.id === entry.options.id)?.config ?? {}) as Record<string, unknown>)
      const next = change(current, inherited)
      const after = editPatch(before, entry.options.id, entry.options.name,
        isDeepStrictEqual(next, inherited) ? undefined : next)
      const candidate = yaml.load(after, { schema: entryListSchema }) as PatchOptions[]
      const effective = flatten(composeEntries([
        ...loaded.layers.map(layer => layer.patches), loaded.patches, candidate, [...profile.overlays],
      ])).find(candidate => candidate.id === entry.options.id)
      if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
        throw new Error(`Configuration for "${entry.options.id}" is overridden by a command-line overlay`)
      }
      entry.fiber!.resolveConfig(next)

      await writeFileAtomic(this.documentPath, after, { mode: 0o600 })
      try { await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh', [entry.options.id]) }
      catch (error) {
        let rollbackFailed = false
        let rollbackError: unknown
        try {
          await writeFileAtomic(this.documentPath, before, { mode: 0o600 })
          await reconcileProfilePatches(ctx.root, beforePatches, 'dsh')
        } catch (recoveryError) {
          rollbackFailed = true
          rollbackError = recoveryError
        }
        if (rollbackFailed) {
          throw new AggregateError([error, rollbackError],
            `Configuration update for "${entry.options.id}" failed, and restoring the previous configuration failed too`,
            { cause: error })
        }
        throw error
      }
    }, { waitMs: this.options.lockWaitMs })
    const hmr = this.sharedContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}
