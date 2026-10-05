import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { findProjectConfigPath, readProjectConfigFromPath, FolderMapError } from '@plur-ai/core'
import { nonceRequired, fail, nonceSession } from './folders.js'

/**
 * Split `[dir] [--nonce <n>]` (#1378). Returns null on a malformed argument
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
 * The terminal-or-nonce gate `plur folders set` has, for `plur trust`
 * (#1378). Outside an interactive terminal a grant needs a `--nonce` issued
 * for this folder and `{ trusted: true }`; a person at a terminal needs none.
 * `plur untrust` is not gated: a revocation only removes trust (#1477 review).
 * See nonceRequired for what the gate does not stop.
 */
export function refuseTrustWithoutNonce(nonce: string | undefined, json: boolean): void {
  if (nonce !== undefined || !nonceRequired(process.stdin.isTTY, process.stdout.isTTY)) return
  fail(new FolderMapError('nonce-required',
    'Not an interactive terminal: plur trust needs the --nonce the ask flow issued for this answer. ' +
    'Run plur trust yourself in a terminal to grant trust by hand.'), json)
}

/**
 * `plur trust [dir]` — grant a directory the same "I vouch for this" status
 * `direnv allow` / `git config safe.directory` / VS Code workspace trust
 * grant (D2, 2026-09 audit). An adapter (opencode today; see
 * `packages/opencode/src/scope.ts`) checks this before adopting a
 * `.plur.yaml` scope/domain it finds in that directory — a project file
 * cannot grant itself trust, only this command, run by the human who owns
 * the machine, can.
 *
 * Enterprise flow this exists for: clone the company repo (whose
 * `.plur.yaml` says `scope: group:acme/eng`), run `plur trust .` once,
 * recall/writes reach the team store from then on.
 *
 * `--list` prints every trusted directory; bare `plur trust` (no dir) trusts
 * the current directory, matching `direnv allow`'s no-argument default.
 */
/** What a grant covers, and what it does not (#1589 audit rounds 2 and 3). */
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
  // #1347: the grant is `trusted: true` in the folder map. A map that cannot
  // be read is refused rather than overwritten.
  let trusted: string
  try {
    trusted = plur.trustDirectory(dir, parsed.nonce !== undefined ? { nonce: parsed.nonce, ...nonceSession() } : undefined)
  } catch (err) {
    if (err instanceof FolderMapError && err.code.startsWith('nonce-')) return fail(err, shouldOutputJson(flags))
    return exit(1, (err as Error).message)
  }

  // E7 (2026-09 audit): this is the one moment a human is in the loop before
  // a `.plur.yaml`'s scope/domain (and, if it declares one, a REMOTE store
  // URL) starts being honored — `direnv allow` shows you the `.envrc` at
  // this exact point, and this used to print only `Trusted: <path>` with no
  // hint of what that grant actually enables. Look for a `.plur.yaml` at or
  // above the trusted directory (the same walk `resolveTrustedScope` uses)
  // and show what it declares — or say plainly that there is nothing to
  // show yet.
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
