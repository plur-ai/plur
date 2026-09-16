import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo } from '../output.js'

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
  if (shouldOutputJson(flags)) {
    outputJson({ success: true, trusted })
    return
  }
  outputInfo(`Trusted: ${trusted}`, flags)
  outputInfo('A .plur.yaml scope/domain in this directory (or below it) will now be honored by adapters that check trust (e.g. the opencode plugin).', flags)
}
