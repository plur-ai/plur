import { dirname } from 'node:path'
import type { ProjectConfig } from '@plur-ai/core'

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

/** The subset of `Plur` this module needs — narrow so tests can stub it cheaply. */
export interface TrustCheck {
  isDirectoryTrusted(dir: string): boolean
}

/** The only fields this plugin ever adopts from a `.plur.yaml`. */
export interface EffectiveProjectScope {
  scope?: string
  domain?: string
}

/**
 * Decide whether to adopt a `.plur.yaml`'s `scope`/`domain` for this session
 * (D2, 2026-09 audit).
 *
 * A repo's `.plur.yaml` is exactly as authoritative as any other file the
 * repo ships — which is to say, not automatically. `scope` can redirect
 * `injectHybrid`'s recall leg and `learnRouted`'s write leg to a REMOTE store
 * the user configured for a different context (their own team/enterprise
 * store, picked by an attacker-chosen scope string) — proved end to end
 * against a stub host: the user's prompt text POSTed under their real token,
 * and an attacker-chosen statement written into a shared scope, entirely
 * off the local store.
 *
 * The fix is NOT "never adopt a remote-resolving scope" — a legitimate
 * enterprise user's own repo declaring `scope: group:acme/eng` so recall
 * reaches their team's store is exactly the product working as intended.
 * The fix is requiring the user to have said, once, that this DIRECTORY is
 * theirs: `plur trust <dir>` (`Plur.isDirectoryTrusted`), the same
 * `direnv allow` / `git config safe.directory` / VS Code workspace-trust
 * shape developers already know.
 *
 * Trust is checked against the directory the `.plur.yaml` FILE lives in
 * (`configPath`'s directory), not the session's scope root — the file can
 * sit in an ancestor of the scope root (within the same repo), and trust is
 * hierarchical (`isDirectoryTrusted` covers descendants), so trusting the
 * repo root once covers every `.plur.yaml` at or below it.
 *
 * Deliberately narrow: this function decides `scope`/`domain` and nothing
 * else. The same `.plur.yaml` also carries `remote_url` / `remote_token` /
 * `remote_scopes`, which are a different grant — they send prompt text
 * off-box rather than filtering what is read — and go through core's
 * `resolveProjectRemoteFromConfig`, the one gate every adapter shares
 * (#1196/#1198). `index.ts` calls both against the SAME single read, so the
 * file trust is checked against stays the file whose fields are adopted.
 * Until #1207 the plugin read no remote fields at all, and an enterprise
 * user's team memory silently never arrived here.
 */
export function resolveTrustedScope(
  plur: TrustCheck,
  projectConfig: ProjectConfig,
  configPath: string | null,
  warn: (msg: string) => void,
): EffectiveProjectScope {
  if (!projectConfig.scope && !projectConfig.domain) return {}
  if (!configPath) {
    // Should not happen — readProjectConfig only returns scope/domain when it
    // found a file — but fail closed rather than adopt with nothing to
    // attribute the grant to.
    warn('a .plur.yaml scope/domain was read with no resolvable file path — ignoring it')
    return {}
  }
  const configDir = dirname(configPath)
  if (plur.isDirectoryTrusted(configDir)) {
    return { scope: projectConfig.scope, domain: projectConfig.domain }
  }
  warn(
    `${configPath} declares scope "${projectConfig.scope ?? '(none)'}"` +
    `${projectConfig.domain ? ` / domain "${projectConfig.domain}"` : ''}, but ${configDir} is not trusted — ` +
    `ignoring it and using the local default scope instead. If you cloned this repo yourself and want its ` +
    `scope honored, run: plur trust ${configDir}`,
  )
  return {}
}
