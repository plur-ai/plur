import { folderOffEntries, folderMapProblem, type Plur } from '@plur-ai/core'
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
 * Gated: every tool that reads or writes engrams or episodes, or returns
 * their text (FOLDER_GATED_TOOLS). Not gated: the admin and diagnostic tools
 * (ADMIN_UNGATED_TOOLS) and plur_admin's `help`. Some admin tools still read
 * stores to count or probe them (status, doctor, stores_list); none returns
 * engram text. Every registered tool is in exactly one of the two sets (a
 * test holds this), so a new tool cannot slip through ungated unnoticed.
 *
 * A folder map that exists but cannot be read or parsed fails SAFE: the gated
 * tools do nothing and name the file and the problem. `on` and `ask` folders
 * are unchanged. The gate never writes folders.yaml.
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
  // returns the statements of recently retrieved engrams
  'plur_receipt',
])

/** The tools that stay available in an `off` folder: admin and diagnostics. */
export const ADMIN_UNGATED_TOOLS: ReadonlySet<string> = new Set([
  'plur_status',
  'plur_doctor',
  'plur_stores_list',
  'plur_stores_add',
  'plur_sync_status',
  'plur_packs_list',
  'plur_packs_discover',
  'plur_packs_preview',
  'plur_scopes_discover',
  'plur_suggest_scope',
  'plur_session_scope',
])

/** The non-error answer a gated tool gives in an `off` folder (or under a broken map). */
export interface FolderOffAnswer {
  success: true
  plur: 'off'
  folder?: string
  reason?: 'folder-map-unreadable'
  file?: string
  message: string
}

function log(line: string): void {
  try { process.stderr.write(`[plur] ${line}\n`) } catch { /* never fail a tool over a log line */ }
}

function unreadable(file: string, problem: string): FolderOffAnswer {
  return {
    success: true,
    plur: 'off',
    reason: 'folder-map-unreadable',
    file,
    message:
      `PLUR memory is paused: the folder map ${JSON.stringify(file)} ${problem}. ` +
      `Until it is fixed, PLUR cannot tell whether memory is allowed in this folder, so nothing was read from or ` +
      `written to memory. This is not an error — carry on without memory. The user can fix the file, or ` +
      `rewrite it from a terminal with plur folders set / plur folders rm.`,
  }
}

/**
 * The `off` answer when PLUR must do nothing here, else null (the tool runs as
 * before):
 *  - the folder map exists but cannot be read or parsed → fail safe, naming
 *    the file and the problem;
 *  - any of `dirs` resolves to `off` → off, naming every map entry that turns
 *    it off and the command for each.
 * Resolved on every call, so a decision changed mid-session applies to the
 * next call. A missing folder map is not a problem (no decisions yet).
 */
export function folderOffAnswer(plur: Plur, dirs: string[]): FolderOffAnswer | null {
  const root = plur.storageRoot
  let problem: { file: string; problem: string } | null
  try {
    problem = folderMapProblem(root)
  } catch (err) {
    problem = { file: `${root}/folders.yaml`, problem: `could not be checked (${(err as Error)?.message ?? err})` }
  }
  if (problem) {
    log(`folder map ${problem.file} ${problem.problem}; memory tools do nothing until it is fixed.`)
    return unreadable(problem.file, problem.problem)
  }
  for (const dir of dirs) {
    let mode: string
    try {
      mode = plur.resolveFolderPolicy(dir).mode
    } catch (err) {
      const why = `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`
      log(`folder map: ${why}; memory tools do nothing.`)
      return unreadable(`${root}/folders.yaml`, why)
    }
    if (mode !== 'off') continue
    let entries: string[] = []
    try { entries = folderOffEntries(dir, { root }).map(e => e.path) } catch { /* name the folder itself */ }
    if (entries.length === 0) entries = [dir]
    const cmds = entries.map(e => folderOnCommand(e, root))
    const how = cmds.every(c => c !== null)
      ? cmds.join(entries.length > 1 ? ' and ' : '')
      : `plur folders set <folder> --on for ${entries.length > 1 ? 'each of ' : ''}${entries.map(e => JSON.stringify(e)).join(', ')} (see plur folders list)`
    const through = entries.length === 1 && entries[0] === dir
      ? ''
      : ` through ${entries.length > 1 ? 'the entries' : 'the entry'} ${entries.map(e => JSON.stringify(e)).join(', ')}`
    return {
      success: true,
      plur: 'off',
      folder: dir,
      message:
        `PLUR is off for this folder (${JSON.stringify(dir)}): your folder map turns memory off here${through}, ` +
        `so nothing was read from or written to memory. This is not an error — carry on without memory. ` +
        `Only the user can turn it back on, from a terminal: ${how}`,
    }
  }
  return null
}
