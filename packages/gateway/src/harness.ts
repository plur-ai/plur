/**
 * The parts of the gateway package the installers and tools use that do not
 * depend on @plur-ai/core, so importing them does not load core.
 */
export {
  isPlurHookSpec,
  recordedCliEntries,
  isPlurHookCommand,
  matchesPlurHookLauncher,
  MAX_HOOK_COMMAND_LENGTH,
  PLUR_SETTINGS_SUBCOMMANDS,
  RECORDED_ENTRIES_MAX,
  nextRecordedEntries,
} from './hook-command.js'
export { makeHttpLlm, llmFromEnv } from './llm.js'
export {
  CLAUDE_INJECT_TIMEOUT_S,
  asHookLaunch,
  buildClaudeHooks,
  buildEnforcementHooks,
  buildInjectionHooks,
  mergeHookMaps,
  type HookEntry,
  type HookLaunch,
} from './claude-hooks.js'
