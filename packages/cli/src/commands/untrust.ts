import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'

/**
 * `plur untrust [dir]` — revoke a directory trust grant made by `plur trust`.
 * See `trust.ts` for the model. Exact match only: untrusting a repo root
 * does not need to walk anything, because a subdirectory was never its own
 * entry (trust checks are hierarchical, grants are not).
 *
 * E3 (2026-09 audit): when `removed` is false, that used to always print
 * "was not trusted" — true of the literal string match, but false of the
 * question a user actually asked a revocation command: "is this directory
 * still trusted after this?" If a covering ancestor grant still trusts it
 * (trust ${dir}/sub after trust ${dir} was granted), the honest answer is
 * "yes, still trusted, via that ancestor" — so this now checks
 * `coveringTrustedAncestor` and names it, plus the command that actually
 * revokes it, instead of silently doing nothing while claiming success.
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const dir = args[0] || process.cwd()
  const removed = plur.untrustDirectory(dir)

  if (removed) {
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, removed: true })
      return
    }
    outputText(`Untrusted: ${dir}`)
    return
  }

  const coveringAncestor = plur.coveringTrustedAncestor(dir)
  if (shouldOutputJson(flags)) {
    outputJson({
      success: true,
      removed: false,
      still_trusted: coveringAncestor !== null,
      ...(coveringAncestor !== null ? { covering_ancestor: coveringAncestor } : {}),
    })
    return
  }
  if (coveringAncestor !== null) {
    outputText(
      `${dir} has no trust grant of its own, but is STILL TRUSTED — covered by ${coveringAncestor}. ` +
      `To actually revoke it, run: plur untrust ${coveringAncestor}`,
    )
  } else {
    outputText(`${dir} was not trusted.`)
  }
}
