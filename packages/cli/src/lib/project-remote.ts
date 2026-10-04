/**
 * The project-remote trust gate now lives in `@plur-ai/core`
 * (`packages/core/src/project-remote.ts`), where every adapter can reach it —
 * including `@plur-ai/opencode`, which cannot import from this package and
 * would otherwise have had to copy the block, reproducing #1196 in one more
 * place (#1207).
 *
 * This module stays as the CLI's import path so no hook call site moved. Read
 * the core file for the two bugs that shaped the gate and why it fails closed.
 */
import { projectRemoteRefusalNotice as coreRefusalNotice } from '@plur-ai/core'
import { trustCommand } from '../plur.js'

export {
  resolveProjectRemote,
  resolveProjectRemoteFromConfig,
  type ProjectRemote,
} from '@plur-ai/core'

/**
 * Core's refusal line, naming a trust command that writes to the store the
 * hook actually checks (audit 1228-c #1): with a non-default store the bare
 * `plur trust <dir>` recorded the grant in `~/.plur` and the refusal repeated.
 * Core's wording is kept; only its closing command is replaced, and if that
 * wording ever changes the line is passed through unchanged.
 */
export function projectRemoteRefusalNotice(refusedFrom: string, storageRoot?: string): string {
  const line = coreRefusalNotice(refusedFrom)
  const bare = `plur trust ${refusedFrom}`
  if (!line.endsWith(bare)) return line
  const cmd = trustCommand(refusedFrom, storageRoot)
  return line.slice(0, -bare.length) + (cmd ?? 'plur trust for that directory, from a terminal (its path cannot be printed as a safe command)')
}
