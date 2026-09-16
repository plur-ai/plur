import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'
import { findProjectConfigPath, readProjectConfigFromPath } from '@plur-ai/core'

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
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  if (args.includes('--list')) {
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

  const dir = args[0] || process.cwd()
  const trusted = plur.trustDirectory(dir)

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
  outputInfo('A .plur.yaml scope/domain in this directory (or below it) will now be honored by adapters that check trust (e.g. the opencode plugin).', flags)
}
