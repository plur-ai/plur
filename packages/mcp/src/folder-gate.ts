import { folderOffEntry, type Plur } from '@plur-ai/core'
import { folderOnCommand } from './tools.js'

/**
 * The folder map's `off` decision in the MCP server.
 *
 * The editor hooks and the opencode plugin go silent in a folder the user
 * marked `plur: off` in `<PLUR home>/folders.yaml`. The MCP server is the
 * other way in: an agent can call plur_learn or plur_recall itself. So before
 * any of the tools below runs, the server resolves the folder policy for the
 * editor's workspace, and in an `off` folder it answers — without an error —
 * that PLUR is off here, and touches no store at all: no local file, no
 * outbox row, no request to a remote store.
 *
 * Gated: every tool that reads or writes engrams or episodes. Not gated: the
 * admin and diagnostic tools (status, doctor, stores, sync status, packs
 * listing and preview, scope discovery and suggestion, the session's default
 * scope, the receipt) and plur_admin's `help`. `on` and `ask` folders are
 * unchanged. The server never writes folders.yaml; only `plur folders set`
 * from a terminal does.
 */
export const FOLDER_GATED_TOOLS: ReadonlySet<string> = new Set([
  // write engrams
  'plur_learn',
  'plur_learn_batch',
  'plur_feedback',
  'plur_pin',
  'plur_forget',
  'plur_ingest',
  'plur_promote',
  'plur_rescope',
  'plur_episode_to_engram',
  'plur_report_failure',
  'plur_extract_meta',
  'plur_validate_meta',
  'plur_tensions',
  'plur_tensions_purge',
  'plur_packs_install',
  'plur_packs_uninstall',
  // read engrams
  'plur_recall',
  'plur_recall_hybrid',
  'plur_inject',
  'plur_inject_hybrid',
  'plur_similarity_search',
  'plur_meta_engrams',
  'plur_history',
  'plur_provenance',
  'plur_profile',
  'plur_packs_export',
  // episodes and sessions
  'plur_capture',
  'plur_timeline',
  'plur_session_start',
  'plur_session_end',
  // move engrams between the local store and a remote
  'plur_sync',
  'plur_outbox',
])

/** The non-error answer a gated tool gives in an `off` folder. */
export interface FolderOffAnswer {
  success: true
  plur: 'off'
  folder: string
  message: string
}

/**
 * The `off` answer for the first of `dirs` that resolves to `off`, else null
 * (the tool runs as before). Resolved on every call, so a decision changed
 * mid-session applies to the next call. A folder map that cannot be read
 * leaves the tool running as before, with a line on stderr.
 */
export function folderOffAnswer(plur: Plur, dirs: string[]): FolderOffAnswer | null {
  for (const dir of dirs) {
    let mode: string
    try {
      mode = plur.resolveFolderPolicy(dir).mode
    } catch (err) {
      try { process.stderr.write(`[plur] folder map: could not resolve ${dir} (${(err as Error)?.message ?? err}); memory tools run as before.\n`) } catch { /* never fail a tool over a log line */ }
      continue
    }
    if (mode !== 'off') continue
    let entry = dir
    try { entry = folderOffEntry(dir, { root: plur.storageRoot })?.path ?? dir } catch { /* name the folder itself */ }
    const cmd = folderOnCommand(entry, plur.storageRoot)
    return {
      success: true,
      plur: 'off',
      folder: dir,
      message:
        `PLUR is off for this folder (${JSON.stringify(dir)}): your folder map turns memory off here` +
        (entry !== dir ? ` through the entry ${JSON.stringify(entry)}` : '') +
        `, so nothing was read from or written to memory. This is not an error — carry on without memory. ` +
        `Only the user can turn it back on, from a terminal: ` +
        (cmd !== null ? cmd : `plur folders set <that folder> --on (see plur folders list)`),
    }
  }
  return null
}
