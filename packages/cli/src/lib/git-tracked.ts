import { spawnSync } from 'child_process'
import { realpathSync } from 'fs'

/**
 * Does git track `file` (relative to `folder`)? `true` tracked, `false` only
 * when git positively reports it untracked inside a real work tree whose top
 * level is `folder` itself, and `null` when that cannot be told: no git, a
 * folder that is not a repository (an archive or copied tree, or a `.git`
 * that is not a valid repository), a folder nested inside another
 * repository's work tree (for example under a directory that repository
 * ignores), git refusing the repository, a path beyond a symlink, or a
 * timeout. Callers that trust a file only because git does not track it must
 * require `false`.
 */
export function gitFileTracked(folder: string, file: string, timeout = 5000): boolean | null {
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
