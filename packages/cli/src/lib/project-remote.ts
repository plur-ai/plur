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
export {
  resolveProjectRemote,
  resolveProjectRemoteFromConfig,
  projectRemoteRefusalNotice,
  type ProjectRemote,
} from '@plur-ai/core'
