import { homedir } from 'os'
import { canonicalize } from './project-config.js'
import { loadFolderMap, isTrustedInMap, setFolderEntry, clearFolderTrust, removeLegacyTrustEntry, withFolderMapLock } from './folders.js'

/**
 * Directory trust — a one-time, explicit, per-directory grant (like `direnv allow`). Without it, a cloned repo's
 * `.plur.yaml` could redirect a session's recall and writes to a scope the user never chose; remote scopes are not
 * refused, the user must just have trusted the directory once.
 * Stored under the PLUR home, never in the project, so a repo cannot trust itself. The grant is `trusted: true` in
 * `<root>/folders.yaml`; a legacy `trust.yaml` is imported once and dual-written (see folders.ts).
 */

/**
 * True when `dir` — or an ancestor of it — has been explicitly trusted.
 *
 * Hierarchical: trusting a repo root also trusts everything below it (VS
 * Code's workspace-trust shape). The target is canonicalised; stored entries
 * are matched as written (fails closed) — neither an entry nor its parent is
 * resolved at compare time.
 */
export function isDirectoryTrusted(dir: string, root: string): boolean {
  return isTrustedInMap(loadFolderMap(root).folders, dir)
}

/**
 * Grant trust to `dir`. Idempotent. Returns the canonicalized path recorded,
 * so a caller can echo back exactly what was trusted.
 *
 * A `nonce` must be one issued for `dir` and the answer
 * `{ trusted: true }`; it is consumed once the grant is saved.
 */
export function trustDirectory(dir: string, root: string, opts?: { nonce?: string; now?: number; session?: string }): string {
  const target = canonicalize(dir)
  setFolderEntry(root, target, { trusted: true }, {
    configuredScopes: [],
    ...(opts?.nonce !== undefined ? { nonce: opts.nonce } : {}),
    ...(opts?.now !== undefined ? { now: opts.now } : {}),
    ...(opts?.session !== undefined ? { session: opts.session } : {}),
  })
  return target
}

/**
 * Revoke trust from `dir` (exact entry only; descendants are not walked). Returns whether a grant was removed.
 * Removed from folders.yaml AND trust.yaml so no older reader, downgrade or re-import brings it back. Takes no
 * nonce: only a grant is gated.
 */
export function untrustDirectory(dir: string, root: string): boolean {
  return withFolderMapLock(root, () => {
    const fromMap = clearFolderTrust(root, dir)
    const fromLegacy = removeLegacyTrustEntry(root, dir)
    return fromMap || fromLegacy
  })
}

/** List every directory this user has explicitly trusted (sorted). */
export function listTrustedDirectories(root: string): string[] {
  return loadFolderMap(root).folders.filter(e => e.trusted === true).map(e => e.path).sort()
}

/**
 * Find the trusted entry that COVERS `dir` — either `dir` itself (an exact
 * grant) or an ancestor directory whose grant is hierarchical over it.
 * Returns `null` when nothing covers `dir` at all.
 *
 * `untrustDirectory` is an exact-match removal, so
 * `plur untrust <subdir-of-a-trusted-repo>` must be able to name the grant
 * that still covers it rather than claim the directory is untrusted.
 */
export function coveringTrustedAncestor(dir: string, root: string): string | null {
  const home = homedir()
  const entries = loadFolderMap(root).folders.filter(e => e.trusted === true)
  const hit = entries
    .filter(e => isTrustedInMap([e], dir, home))
    .map(e => e.path)
    .sort()
  return hit[0] ?? null
}
