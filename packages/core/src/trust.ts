import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import yaml from 'js-yaml'
import { logger } from './logger.js'
import { canonicalize } from './project-config.js'

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
 * Stored under the PLUR home (`<root>/trust.yaml`), never inside the
 * project — a repo cannot grant itself trust; only a human running
 * `plur trust` on their own machine can.
 */

interface TrustFile {
  version: 1
  trusted: string[]
}

function trustFilePath(root: string): string {
  return join(root, 'trust.yaml')
}

function loadTrustFile(root: string): TrustFile {
  const file = trustFilePath(root)
  if (!existsSync(file)) return { version: 1, trusted: [] }
  try {
    const raw = yaml.load(readFileSync(file, 'utf8')) as Partial<TrustFile> | null | undefined
    const trusted = Array.isArray(raw?.trusted)
      ? raw!.trusted.filter((t): t is string => typeof t === 'string')
      : []
    return { version: 1, trusted }
  } catch (err) {
    logger.warning(`[plur:trust] cannot parse ${file}: ${(err as Error).message} — treating as no trusted directories`)
    return { version: 1, trusted: [] }
  }
}

function saveTrustFile(root: string, data: TrustFile): void {
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  writeFileSync(trustFilePath(root), yaml.dump(data), 'utf8')
}

/**
 * True when `dir` — or an ancestor of it — has been explicitly trusted.
 *
 * Hierarchical: trusting a repo root also trusts everything below it (VS
 * Code's workspace-trust shape). A `.plur.yaml` living in a subdirectory of a
 * trusted repo is exactly as much the user's own project as the root is;
 * requiring a separate grant per subdirectory would make the common flow
 * ("clone the repo, `plur trust .` once") not actually work.
 *
 * Paths are canonicalized before comparing (`canonicalize`, shared with
 * `project-config.ts` — see #778 there for why a plain string compare fails
 * OPEN on a symlinked path component).
 */
export function isDirectoryTrusted(dir: string, root: string): boolean {
  const target = canonicalize(dir)
  const { trusted } = loadTrustFile(root)
  return trusted.some(t => target === t || target.startsWith(t + sep))
}

/**
 * Grant trust to `dir`. Idempotent. Returns the canonicalized path recorded,
 * so a caller can echo back exactly what was trusted.
 */
export function trustDirectory(dir: string, root: string): string {
  const target = canonicalize(dir)
  const data = loadTrustFile(root)
  if (!data.trusted.includes(target)) {
    data.trusted.push(target)
    data.trusted.sort()
    saveTrustFile(root, data)
  }
  return target
}

/**
 * Revoke trust from `dir`. Exact match only — untrusting a root does not
 * walk its previously-covered descendants (there is nothing to walk; they
 * were never their own entries). Returns whether an entry was removed.
 */
export function untrustDirectory(dir: string, root: string): boolean {
  const target = canonicalize(dir)
  const data = loadTrustFile(root)
  const idx = data.trusted.indexOf(target)
  if (idx === -1) return false
  data.trusted.splice(idx, 1)
  saveTrustFile(root, data)
  return true
}

/** List every directory this user has explicitly trusted (canonicalized, sorted). */
export function listTrustedDirectories(root: string): string[] {
  return loadTrustFile(root).trusted
}
