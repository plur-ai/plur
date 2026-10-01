import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { projectRemoteRefusalNotice as coreRefusalNotice, findPlurMarker, type FolderPolicy, type ProjectConfig } from '@plur-ai/core'

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
  /** The store whose `trust.yaml` answers (`Plur.storageRoot`). */
  readonly storageRoot?: string
}

/**
 * One argument of a printed command, or null when it cannot be quoted safely
 * (#1228 review; the rule of #1418's folder question): POSIX single quotes;
 * Windows double quotes, refused for $, backtick, %, ! and the curly double
 * quotes, which PowerShell and cmd expand; never a line-breaking, bidi or
 * zero-width character.
 */
function shellWord(s: string, platform: NodeJS.Platform = process.platform): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(s)) return null
  if (/^[A-Za-z0-9_@+=:,./~-]+$/.test(s)) return s
  if (platform === 'win32') {
    if (/[$`%!"\u201c\u201d\u201e]/.test(s) || s.endsWith('\\')) return null
    return `"${s}"`
  }
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The trust command that reaches the store this plugin checks (audit 1228-c
 * #1). The plugin opens `PLUR_PATH` when opencode's environment sets it; a bare
 * `plur trust <dir>` in a shell without it writes `~/.plur/trust.yaml`, which
 * this plugin never reads — so a non-default store is named with `--path`.
 */
export function trustCommand(dir: string, storageRoot?: string, platform: NodeJS.Platform = process.platform): string {
  const target = shellWord(dir, platform)
  const custom = storageRoot && resolve(storageRoot) !== resolve(join(homedir(), '.plur'))
  const store = custom ? shellWord(resolve(storageRoot!), platform) : ''
  if (target === null || store === null) return '`plur trust` for that directory, from a terminal (its path cannot be printed as a safe command)'
  return custom ? `plur --path ${store} trust ${target}` : `plur trust ${target}`
}

/** Core's remote-refusal line, closing with {@link trustCommand} for this store. */
export function projectRemoteRefusalNotice(refusedFrom: string, storageRoot?: string): string {
  const line = coreRefusalNotice(refusedFrom)
  const bare = `plur trust ${refusedFrom}`
  if (!line.endsWith(bare)) return line
  return line.slice(0, -bare.length) + trustCommand(refusedFrom, storageRoot)
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
    `scope honored, run: ${trustCommand(configDir, plur.storageRoot)}`,
  )
  return {}
}

/** The subset of `Plur` the folder decision needs. */
export interface FolderPolicySource {
  resolveFolderPolicy(dir: string): FolderPolicy
}

/**
 * What the folder map decides for `dir` (#1347): `Plur.resolveFolderPolicy`,
 * keyed on the store this plugin opened. A resolver failure must never break
 * the turn and must not switch memory on where the map could have said off:
 * it falls back to the rule the CLI hooks use (a project marker means on,
 * otherwise a silent-until-asked `ask`), the same fallback as the CLI's
 * `hookFolderPolicy`.
 */
export function folderPolicy(plur: FolderPolicySource, dir: string, warn: (msg: string) => void): FolderPolicy {
  try {
    return plur.resolveFolderPolicy(dir)
  } catch (err) {
    warn(`folder map: could not resolve ${dir} (${(err as Error)?.message ?? err}); using the project marker.`)
    const marker = findPlurMarker(dir)
    return marker
      ? { mode: 'on', remoteAllowed: false, source: marker }
      : { mode: 'ask', remoteAllowed: false, source: 'default' }
  }
}
