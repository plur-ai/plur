import type { OpenClawPluginDefinition, OpenClawPluginApi } from './types.js'
import { PlurContextEngine, type PlurContextEngineOptions } from './context-engine.js'

const plugin: OpenClawPluginDefinition = {
  id: 'plur-claw',
  name: 'PLUR Memory Engine',
  version: '0.1.0',
  kind: 'context-engine',

  register(api: OpenClawPluginApi) {
    api.registerContextEngine('plur-claw', () => new PlurContextEngine())
  },
}

export default plugin
export { PlurContextEngine, type PlurContextEngineOptions }
export { ensureSystemPrompt, PLUR_SYSTEM_SECTION } from './system-prompt.js'
export type {
  ContextEngine, AssembleResult, IngestResult, CompactResult, BootstrapResult,
  AgentMessage, OpenClawPluginApi, OpenClawPluginDefinition,
} from './types.js'
