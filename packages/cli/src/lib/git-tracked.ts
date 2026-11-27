import { spawnSync } from 'child_process'

/**
 * Does git track `file` (relative to `folder`)? `true` tracked, `false` only
 * when git positively reports it untracked inside a real work tree, and `null`
 * when that cannot be told: no git, a folder that is not a repository (an
 * archive or copied tree, or a `.git` that is not a valid repository), git
 * refusing the repository, a path beyond a symlink, or a timeout. Callers that
 * trust a file only because git does not track it must require `false`.
 */
export function gitFileTracked(folder: string, file: string, timeout = 5000): boolean | null {
  // Git index/worktree/config overrides belong to the launching process,
  // not necessarily the project whose file is being inspected.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const options = { cwd: folder, env, encoding: 'utf8' as const, timeout, windowsHide: true }
  const repo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], options)
  if (repo.status !== 0 || repo.stdout?.trim() !== 'true') return null
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], options)
  return result.status === 0 ? true : result.status === 1 ? false : null
}
