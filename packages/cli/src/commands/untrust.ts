import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * `plur untrust [dir]` — revoke a directory trust grant made by `plur trust`.
 * See `trust.ts` for the model. Exact match only: untrusting a repo root
 * does not need to walk anything, because a subdirectory was never its own
 * entry (trust checks are hierarchical, grants are not).
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const dir = args[0] || process.cwd()
  const removed = plur.untrustDirectory(dir)
  if (shouldOutputJson(flags)) {
    outputJson({ success: true, removed })
    return
  }
  outputText(removed ? `Untrusted: ${dir}` : `${dir} was not trusted.`)
}
