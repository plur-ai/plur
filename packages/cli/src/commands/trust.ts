import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { findProjectConfigPath, readProjectConfigFromPath, FolderMapError } from '@plur-ai/core'
import { nonceRequired, fail, nonceSession } from './folders.js'

/**
 * Split `[dir] [--nonce <n>]`. Returns null on a malformed argument
 * list so the caller can print its usage.
 */
export function parseTrustArgs(args: string[]): { dir?: string; nonce?: string } | null {
  let dir: string | undefined
  let nonce: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--nonce') {
      const v = args[++i]
      if (!v || v.startsWith('--')) return null
      nonce = v
    } else if (a.startsWith('--') || dir !== undefined) {
      return null
    } else {
      dir = a
    }
  }
  return { ...(dir !== undefined ? { dir } : {}), ...(nonce !== undefined ? { nonce } : {}) }
}

/**
 * The terminal-or-nonce gate `plur folders set` has, for `plur trust`.
 * Outside an interactive terminal a grant needs a `--nonce` issued
 * for this folder and `{ trusted: true }`; a person at a terminal needs none.
 * `plur untrust` is not gated: a revocation only removes trust.
 * See nonceRequired for what the gate does not stop.
 */
export function refuseTrustWithoutNonce(nonce: string | undefined, json: boolean): void {
  if (nonce !== undefined || !nonceRequired(process.stdin.isTTY, process.stdout.isTTY)) return
  fail(new FolderMapError('nonce-required',
    'Not an interactive terminal: plur trust needs the --nonce the ask flow issued for this answer. ' +
    'Run plur trust yourself in a terminal to grant trust by hand.'), json)
}

/**
 * `plur trust [dir]` — vouch for a directory, like `direnv allow` or VS Code
 * workspace trust. Adapters (e.g. `packages/opencode/src/scope.ts`) check it
 * before adopting a `.plur.yaml` scope/domain found there; a project file can
 * never grant itself trust. `--list` prints trusted directories; no dir means cwd.
 */
/** What a grant covers, and what it does not. */
export const TRUST_COVERS =
  'Trust covers the .plur.yaml files in every folder below it. A repository\'s own memory store (.plur/engrams.yaml) is still added only after you decide on that repository: plur folders set <repo> --on, or plur trust <repo>.'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.includes('--list')) {
    const plur = createPlur(flags)
    const dirs = plur.listTrustedDirectories()
    if (shouldOutputJson(flags)) {
      outputJson({ trusted: dirs, count: dirs.length })
      return
    }
    if (dirs.length === 0) {
      outputText('No trusted directories.')
      return
    }
    dirs.forEach(d => outputText(d))
    return
  }

  const parsed = parseTrustArgs(args)
  if (!parsed) return exit(1, 'Usage: plur trust [dir] [--nonce <n>] | plur trust --list\n' + TRUST_COVERS)
  const dir = parsed.dir || process.cwd()
  refuseTrustWithoutNonce(parsed.nonce, shouldOutputJson(flags))
  const plur = createPlur(flags)
  // The grant is `trusted: true` in the folder map. A map that cannot
  // be read is refused rather than overwritten.
  let trusted: string
  try {
    trusted = plur.trustDirectory(dir, parsed.nonce !== undefined ? { nonce: parsed.nonce, ...nonceSession() } : undefined)
  } catch (err) {
    if (err instanceof FolderMapError && err.code.startsWith('nonce-')) return fail(err, shouldOutputJson(flags))
    return exit(1, (err as Error).message)
  }

  // This is the one moment a human is in the loop before a `.plur.yaml`'s
  // scope/domain (and, if it declares one, a REMOTE store URL) starts being
  // honored, so show what the grant enables, as `direnv allow` shows the
  // `.envrc`. Look for a `.plur.yaml` at or above the trusted directory (the
  // same walk `resolveTrustedScope` uses) and show what it declares — or say
  // plainly that there is nothing to show yet.
  const configPath = findProjectConfigPath(dir)
  const config = readProjectConfigFromPath(configPath)
  const declares = configPath && (config.scope || config.domain || config.remote_url)

  if (shouldOutputJson(flags)) {
    outputJson({
      success: true,
      trusted,
      ...(configPath ? { config_path: configPath } : {}),
      ...(config.scope ? { scope: config.scope } : {}),
      ...(config.domain ? { domain: config.domain } : {}),
      ...(config.remote_url ? { remote_url: config.remote_url } : {}),
    })
    return
  }

  outputInfo(`Trusted: ${trusted}`, flags)
  outputInfo(TRUST_COVERS, flags)
  if (declares) {
    outputInfo(`This authorizes ${configPath}:`, flags)
    if (config.scope) outputInfo(`  scope:  ${config.scope}`, flags)
    if (config.domain) outputInfo(`  domain: ${config.domain}`, flags)
    if (config.remote_url) outputInfo(`  remote_url: ${config.remote_url}  (writes/recalls for this scope can reach this remote store)`, flags)
  } else if (configPath) {
    outputInfo(`${configPath} exists but declares no scope/domain/remote_url — nothing for adapters to adopt yet.`, flags)
  } else {
    outputInfo('No .plur.yaml found here (or above, within this project) — nothing for an adapter to adopt yet. This grant takes effect if one is added later.', flags)
  }
  outputInfo('Recorded in folders.yaml, and in trust.yaml for adapters on an older core (the opencode plugin). A .plur.yaml in this directory (or below it) may now use the remote it names, and adapters that check trust honour its scope/domain.', flags)
}
