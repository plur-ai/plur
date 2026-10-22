/**
 * What `@plur-ai/plur-enterprise` builds on: the sign-in, upload count, tool
 * config and version helpers the plur CLI already has. Imported as
 * `@plur-ai/cli/enterprise-api`. Each export is a contract with that package —
 * test/enterprise-api.test.ts pins the list, so a change here is deliberate.
 */
export { deviceSignIn, DEVICE_KEY_RE } from './commands/login.js'
export { countUploadCandidates } from './commands/upload.js'
export { CLI_VERSION } from './version.js'
export { urlOpener } from './lib/open-url.js'
export { readCodexEntry, codexMcpEnvironment, patchCodexEntry } from './codex-config.js'
export { unambiguousJsonc } from './opencode-config.js'
export { parseJsonc } from './lib/jsonc.js'
export { resolveCodexBinary } from './lib/codex-binary.js'
export { codexConfigTomlPath } from './mcp-config.js'
export { deviceName, isHeadless, isVsCodeRemote, isWslRelease } from './enterprise/device-name.js'
export {
  backupSecretFile, fetchMe, personalScopeOf, redactConsoleWith, takeoverMessage,
  type BackupHost, type FetchFn, type MeAnswer,
} from './enterprise/sign-in-shared.js'
export { backupWriter, type Backup } from './enterprise/backup.js'
