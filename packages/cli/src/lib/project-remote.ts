/**
 * The project-remote trust gate lives in `@plur-ai/core`
 * (`packages/core/src/project-remote.ts`), where every adapter can reach it.
 * This module is the CLI's import path for it; see the core file for why the
 * gate fails closed.
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
 * hook actually checks: with a non-default store a bare `plur trust <dir>`
 * would record the grant in `~/.plur` and the refusal would repeat.
 * Core's wording is kept; only its closing command is replaced, and if that
 * wording changes the line is passed through unchanged.
 */
export function projectRemoteRefusalNotice(refusedFrom: string, storageRoot?: string): string {
  const line = coreRefusalNotice(refusedFrom)
  const bare = `plur trust ${refusedFrom}`
  if (!line.endsWith(bare)) return line
  const cmd = trustCommand(refusedFrom, storageRoot)
  return line.slice(0, -bare.length) + (cmd ?? 'plur trust for that directory, from a terminal (its path cannot be printed as a safe command)')
}
