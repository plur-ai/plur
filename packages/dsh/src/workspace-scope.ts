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
  let dir = cwd
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    try {
      const candidate = join(dir, '.plur.yaml')
      if (existsSync(candidate)) {
        const raw = yaml.load(readFileSync(candidate, 'utf8')) as { scope?: unknown } | null
        const scope = raw?.scope
        // A non-string scope is a malformed file, not an instruction.
        if (typeof scope === 'string' && scope.trim()) return scope.trim()
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
