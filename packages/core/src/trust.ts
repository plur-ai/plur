import { homedir } from 'os'
import { canonicalize } from './project-config.js'
import { loadFolderMap, isTrustedInMap, setFolderEntry, clearFolderTrust, removeLegacyTrustEntry } from './folders.js'

/**
 * Directory trust — a one-time, explicit, per-directory grant, the same
 * shape as `direnv allow`, `git config safe.directory`, and VS Code's
 * workspace trust.
 *
 * Why this exists (2026-09 audit, D2): a `.plur.yaml` a repo ships can set
 * `scope`/`domain`, and an adapter (opencode, claw, ...) that adopts those
 * values automatically lets a directory the user merely opened — cloned,
 * not vetted — redirect that session's recall/writes to a scope the user
 * never chose FOR THAT SESSION. Team/remote stores are the legitimate use of
 * `.plur.yaml` (an enterprise user's own repo declaring `scope:
 * group:acme/eng` so recall reaches their team's store) — the fix is not to
 * refuse remote scopes, it is to require the user to have said, once, "I
 * trust this directory."
 *
 * Stored under the PLUR home, never inside the project — a repo cannot grant
 * itself trust; only a human running `plur trust` on their own machine can.
 *
 * #1347: the grant now lives in the folder map (`<root>/folders.yaml`) as
 * `trusted: true` on an entry. A pre-#1347 `<root>/trust.yaml` is imported
 * once, on the first read of a missing folders.yaml. Nothing is ever added
 * to trust.yaml; `untrustDirectory` removes a revoked grant from it too.
 * These functions keep their signatures and results; see folders.ts.
 */

/**
 * True when `dir` — or an ancestor of it — has been explicitly trusted.
 *
 * Hierarchical: trusting a repo root also trusts everything below it (VS
 * Code's workspace-trust shape). The target is canonicalised; stored entries
 * are matched as written or with their parent canonicalised (#778, #1334 —
 * fails closed).
 */
export function isDirectoryTrusted(dir: string, root: string): boolean {
  return isTrustedInMap(loadFolderMap(root).folders, dir)
}

/**
 * Grant trust to `dir`. Idempotent. Returns the canonicalized path recorded,
 * so a caller can echo back exactly what was trusted.
 */
export function trustDirectory(dir: string, root: string): string {
  const target = canonicalize(dir)
  setFolderEntry(root, target, { trusted: true }, { configuredScopes: [] })
  return target
}

/**
 * Revoke trust from `dir`. Exact entry only — untrusting a root does not
 * walk its previously-covered descendants (they were never their own
 * entries). Returns whether a grant was removed.
 *
 * The grant is removed from folders.yaml AND from a legacy trust.yaml, so a
 * downgrade or a re-import cannot bring it back. trust.yaml is only ever
 * shrunk, never added to.
 */
export function untrustDirectory(dir: string, root: string): boolean {
  const fromMap = clearFolderTrust(root, dir)
  const fromLegacy = removeLegacyTrustEntry(root, dir)
  return fromMap || fromLegacy
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
 * E3 (2026-09 audit): `untrustDirectory` is an exact-match removal, so
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
