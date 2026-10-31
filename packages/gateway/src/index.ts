export { ProvenanceGateway, GatewayError, DEFAULT_GATEWAY_URL, DEFAULT_NOTARY_ADDRESS, EXPERIMENTAL_NOTE, isDefaultGateway, expectedNotaryFor, notaryClaim, type NotarySignature, type GatewayDocument } from './client.js'
export { anchorManifest, type AnchorRecord } from './anchor.js'
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
