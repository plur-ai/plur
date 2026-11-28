import { spawnSync } from 'child_process'
import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, join, relative } from 'path'

/**
 * Does git track `file` (relative to `folder`)? `true` tracked, `false` only
 * when git positively reports it untracked inside a real work tree, and
 * `null` when that cannot be told: no git, a folder that is not a repository
 * (an archive or copied tree, or a `.git` that is not a valid repository),
 * git refusing the repository, a path beyond a symlink, or a timeout. Callers
 * that trust a file only because git does not track it must require `false`.
 *
 * `requireOwnTopLevel` (default true) also requires the work tree's top
 * level to be `folder` itself: a folder nested inside another repository's
 * work tree (for example under a directory that repository ignores) is then
 * `null`. Callers that treat an untracked file as the user's own approval
 * need that; a caller that only asks whether the file is committed passes
 * false.
 */
export function gitFileTracked(folder: string, file: string, timeout = 5000, opts: { requireOwnTopLevel?: boolean } = {}): boolean | null {
  // git answers "untracked" for a path behind a symlinked directory (one the
  // repository may itself commit), so a symlink on the way, or a path that
  // leaves the folder, gives no answer.
  if (!plainPathUnder(folder, file)) return null
  // Git index/worktree/config overrides belong to the launching process,
  // not necessarily the project whose file is being inspected.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const options = { cwd: folder, env, encoding: 'utf8' as const, timeout, windowsHide: true }
  // core.fsmonitor off: the inspected repository's config does not get to start a program here.
  const git = (args: string[]) => spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], options)
  const repo = git(['rev-parse', '--is-inside-work-tree'])
  if (repo.status !== 0 || repo.stdout?.trim() !== 'true') return null
  const result = git(['ls-files', '--error-unmatch', '--', file])
  if (result.status === 0) return true
  if (result.status !== 1) return null
  if (opts.requireOwnTopLevel === false) return false
  // Untracked counts only in the folder's own work tree: in an enclosing
  // repository the file is untracked because that repository is not this
  // project, which says nothing about who wrote it.
  const top = git(['rev-parse', '--show-toplevel'])
  if (top.status !== 0 || !top.stdout?.trim()) return null
  try {
    return realpathSync(top.stdout.trim()) === realpathSync(folder) ? false : null
  } catch {
    return null
  }
}

/**
 * `file` (relative to `folder`, or absolute) lies inside `folder` and its
 * existing components are not symbolic links. A component that does not
 * exist ends the walk (the file is then absent); any other lstat error gives
 * false.
 */
function plainPathUnder(folder: string, file: string): boolean {
  const rel = isAbsolute(file) ? relative(folder, file) : file
  if (isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]+/).filter(p => p !== '' && p !== '.')
  if (parts.length === 0 || parts.includes('..')) return false
  let at = folder
  for (const part of parts) {
    at = join(at, part)
    try {
      if (lstatSync(at).isSymbolicLink()) return false
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
  return true
}
