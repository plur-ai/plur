import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { projectRemoteRefusalNotice as coreRefusalNotice, formatServerSessionLine, type FolderPolicy, type ProjectConfig } from '@plur-ai/core'

/**
 * Which path this session's memory is scoped by.
 *
 * `worktree` is the right answer inside a git repo and a trap outside one:
 * opencode reports it as "/" in a plain directory, which would scope
 * every non-repo session to the filesystem root.
 */
export function resolveScopeRoot(ctx: { directory?: string; worktree?: string }): string {
  const wt = ctx.worktree
  if (wt && wt !== '/' && wt.length > 1) return wt
  if (ctx.directory) return ctx.directory
  return process.cwd()
}

/**
 * The folder the folder-map decision is about: the
 * folder opencode is OPEN IN — `directory` — the way the CLI hooks decide on
 * the editor's working folder. Not the git worktree root: an `off` rule for
 * `/repo/private` must hold when opencode runs there, even though `/repo` is
 * the worktree and is `on`, and an undecided subfolder is asked about itself.
 */
export function resolveFolderDir(ctx: { directory?: string; worktree?: string }): string {
  if (ctx.directory) return ctx.directory
  return resolveScopeRoot(ctx)
}

/** The subset of `Plur` this module needs — narrow so tests can stub it cheaply. */
export interface TrustCheck {
  isDirectoryTrusted(dir: string): boolean
  /** The store whose `trust.yaml` answers (`Plur.storageRoot`). */
  readonly storageRoot?: string
}

/**
 * One argument of a printed command, or null when it cannot be quoted safely:
 * POSIX single quotes;
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
 * The trust command that reaches the store this plugin checks. The plugin opens `PLUR_PATH` when opencode's environment sets it; a bare
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
 * Decide whether to adopt a `.plur.yaml`'s `scope`/`domain` for this session.
 * A repo's `.plur.yaml` is not automatically trusted: `scope` can redirect recall and writes
 * to a REMOTE store under the user's real token. Remote-resolving scopes need the user to
 * have trusted the directory once (`plur trust <dir>`, `Plur.isDirectoryTrusted`).
 * Trust is checked against the directory holding the FILE (hierarchical, so trusting the
 * repo root covers it). Decides only `scope`/`domain`; remote settings go through core's
 * `resolveProjectRemoteFromConfig`, and `index.ts` passes both the SAME single read.
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
  bindFolderPolicy(dir: string, policy: FolderPolicy): void
  bindFolderUnresolved(dir: string, why: string): void
}

/**
 * What the folder map decides for `dir` (`Plur.resolveFolderPolicy`). A resolver failure
 * never breaks the turn and fails SAFE: treated like `ask` with no memory and a notice.
 * The instance is bound to the decision: the repository-default boundary and remote-only
 * mode apply only to a bound instance.
 */
export function folderPolicy(plur: FolderPolicySource, dir: string, warn: (msg: string) => void): FolderPolicy {
  try {
    const policy = plur.resolveFolderPolicy(dir)
    plur.bindFolderPolicy(dir, policy)
    if (policy.mode === "on" && policy.git?.kind === "unknown") {
      warn(formatServerSessionLine({ host: "", status: "ok", target: policy.git, keyExpiresAt: null }))
    }
    return policy
  } catch (err) {
    const why = (err as Error)?.message ?? String(err)
    warn(`folder map: could not resolve ${dir} (${why}); memory is off here.`)
    try { plur.bindFolderUnresolved(dir, why) } catch { /* admission still refuses memory */ }
    return { mode: "ask", remoteAllowed: false, source: "default", reason: "resolver-error" }
  }
}
