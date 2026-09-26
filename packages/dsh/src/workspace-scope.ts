/**
 * Reading a workspace's declared PLUR scope.
 *
 * Mirrors `@plur-ai/core`'s own project-store discovery: look for `.plur.yaml`
 * with a `scope:` key, walking up from the session's working directory and
 * stopping at the git root so one project never inherits a parent project's
 * scope.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

/**
 * Depth ceiling for the upward walk.
 *
 * The walk already stops at a git root or the filesystem root, but a session
 * cwd is host-supplied and this runs on a live agent's path — a bound means a
 * pathological directory tree cannot turn scope resolution into a long
 * synchronous stat storm.
 */
const MAX_DEPTH = 32

/**
 * Read the scope a workspace declares for itself.
 *
 * @param cwd - the session's working directory.
 * @returns the declared scope, or `undefined` when the workspace declares none.
 *   Never throws: an unreadable or malformed file narrows to the configured
 *   default rather than widening, because failing open on a privacy boundary is
 *   the wrong direction to fail.
 */
export async function readWorkspaceScope(cwd: string): Promise<string | undefined> {
  return findWorkspaceScope(cwd)?.scope
}

/** A declared workspace scope and the file that declared it. */
export interface WorkspaceScopeDecl {
  scope: string
  /** The `.plur.yaml` path; trust is checked against its directory. */
  file: string
}

/**
 * {@link readWorkspaceScope}, also returning which file declared the scope.
 *
 * @param cwd - the session's working directory.
 * @returns the declaration, or `undefined`. Never throws.
 */
export function findWorkspaceScope(cwd: string): WorkspaceScopeDecl | undefined {
  let dir = cwd
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    try {
      const candidate = join(dir, '.plur.yaml')
      if (existsSync(candidate)) {
        const raw = yaml.load(readFileSync(candidate, 'utf8')) as { scope?: unknown } | null
        const scope = raw?.scope
        // A non-string scope is a malformed file, not an instruction.
        if (typeof scope === 'string' && scope.trim()) return { scope: scope.trim(), file: candidate }
        return undefined
      }
      // Stop at the git root: an inner repository must not inherit an outer
      // project's scope just because it happens to live inside its tree.
      if (existsSync(join(dir, '.git'))) return undefined
    } catch {
      return undefined
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * The workspace reader the plugin wires (decision E3, 2026-09-26): a declared
 * scope is adopted only when the directory holding the `.plur.yaml` is trusted
 * (`plur trust <dir>` — core's `Plur.isDirectoryTrusted`, the check
 * @plur-ai/opencode already made). A cloned repository must not choose which
 * scope — possibly a remote team store — this harness reads and writes.
 *
 * `scope: global` is never adopted, trusted or not: the ambient global store is
 * never this plugin's scope (scope.ts). Either refusal warns once per file and
 * narrows to the configured/derived default. A throwing check fails closed.
 *
 * @param trusts - is this directory trusted?
 * @param warn - where refusals are reported.
 * @returns a reader with {@link readWorkspaceScope}'s contract.
 */
export function trustedWorkspaceScope(
  trusts: (dir: string) => Promise<boolean> | boolean,
  warn: (msg: string) => void,
): (cwd: string) => Promise<string | undefined> {
  const warned = new Set<string>()
  const once = (key: string, msg: string) => {
    if (warned.has(key)) return
    warned.add(key)
    try { warn(msg) } catch { /* a warning must never break scope resolution */ }
  }
  return async (cwd: string) => {
    const decl = findWorkspaceScope(cwd)
    if (!decl) return undefined
    const dir = dirname(decl.file)
    if (decl.scope === 'global') {
      once(`global\u0000${decl.file}`,
        `[plur] Ignored scope "global" in ${decl.file} — this plugin never uses the ambient global store; ` +
        'using the workspace default scope instead.')
      return undefined
    }
    let trusted = false
    try {
      trusted = (await trusts(dir)) === true
    } catch {
      trusted = false
    }
    if (trusted) return decl.scope
    once(decl.file,
      `[plur] Ignored scope "${decl.scope}" in ${decl.file} — ${dir} is not a trusted directory, so the ` +
      `workspace default scope is used instead. If this project is yours, run: plur trust ${dir}`)
    return undefined
  }
}
