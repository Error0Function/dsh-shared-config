/** Guidance for sharing DSH plugin configuration in selected presets. */
import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'

interface AgentLike {
  readonly ctx: Context
  readonly session: { readonly header?: { readonly agentPreset?: unknown } }
}

interface PresetRegistry {
  composedPreset(context: Context): string | undefined
}

interface SessionProjections {
  stateOf(session: unknown, key: string): unknown
}

/** Read an optional service without making preset support a load-time dependency. */
function service<T>(ctx: Context, name: string): T | undefined {
  const value = ctx.get(name)
  return value === undefined || value === null ? undefined : value as T
}

/** Resolve the live preset identity, with durable session fallbacks. */
function presetOf(ctx: Context, agent: AgentLike): string | undefined {
  const registry = service<PresetRegistry>(ctx, 'agentPresets')
  if (registry !== undefined) {
    try {
      const id = registry.composedPreset(agent.ctx)
      if (typeof id === 'string' && id !== '') return id
    } catch (error) {
      void error
    }
  }
  const projections = service<SessionProjections>(ctx, 'sessionProjections')
  if (projections !== undefined) {
    try {
      const id = projections.stateOf(agent.session, 'agentPreset')
      if (typeof id === 'string' && id !== '') return id
    } catch (error) {
      void error
    }
  }
  const id = agent.session.header?.agentPreset
  return typeof id === 'string' && id !== '' ? id : undefined
}

function isSelectedAssembly(context: AssembleContext, presetIds: readonly string[]): boolean {
  const agent = (context as AssembleContext & { readonly agent?: AgentLike }).agent
  if (agent === undefined) return false
  const preset = presetOf(agent.ctx, agent)
  return preset !== undefined && presetIds.includes(preset)
}

/** Cordis plugin name. */
export const name = 'dsh-shared-config/agent-prompt'

/** The prompt registry used by the root composition. */
export const inject = ['systemPrompt']

/** Presets whose Agents receive shared-configuration guidance. */
export interface Config {
  presetIds: string[]
}

/** Runtime schema for the prompt row; an empty list disables guidance. */
export const Config: z<Config> = z.object({
  presetIds: z.array(z.string().pattern(/\S/u).required()).default(['cordis']),
})

/**
 * Guidance shown to Agents using a configured preset.
 * @param ctx - the root composition that owns this prompt section.
 * @param config - preset identities; each must contain a non-whitespace character.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-shared-config:creator-guidance',
    order: 100,
    text: (context) => isSelectedAssembly(context, config.presetIds) ? `Use dsh-shared-config's editor workflow to save a plugin setting to $DSH_HOME/cordis.patch.yml when it should be shared by multiple DSH profiles using the same $DSH_HOME and the editor supports it. Keep plugin installation, enablement, and profile-specific settings in the requested profile's local configuration. If the editor cannot handle the setting or is unavailable, use the appropriate local configuration and continue without waiting for shared storage. Finish the plugin task; when configuration changed, briefly say what was shared and what stayed local.` : '',
  }), 'dsh-shared-config.creator-guidance')
}
