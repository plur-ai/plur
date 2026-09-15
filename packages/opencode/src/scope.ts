/**
 * Which path this session's memory is scoped by.
 *
 * `worktree` is the right answer inside a git repo and a trap outside one:
 * measured as "/" in a plain directory (opencode 1.18.30), which would scope
 * every non-repo session to the filesystem root.
 */
export function resolveScopeRoot(ctx: { directory?: string; worktree?: string }): string {
  const wt = ctx.worktree
  if (wt && wt !== '/' && wt.length > 1) return wt
  if (ctx.directory) return ctx.directory
  return process.cwd()
}
