import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { parseTrustArgs } from './trust.js'

/**
 * `plur untrust [dir]` — revoke a directory trust grant made by `plur trust`.
 * See `trust.ts` for the model. Exact match only: untrusting a repo root
 * does not need to walk anything, because a subdirectory was never its own
 * entry (trust checks are hierarchical, grants are not).
 *
 * When there was no exact grant to remove, the directory may still be trusted
 * through a covering ancestor grant. That ancestor is reported, with the
 * command that actually revokes it, rather than claiming "was not trusted".
 */
export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const parsed = parseTrustArgs(args)
  if (!parsed) return exit(1, 'Usage: plur untrust [dir]')
  const dir = parsed.dir || process.cwd()
  // No terminal-or-nonce gate: a revocation only removes
  // trust, and scripts and runbooks that revoke must keep working. Only the
  // grant (`plur trust`) is gated. A `--nonce` is accepted and ignored — it
  // is neither checked nor consumed — so a caller that passes one still works.
  const plur = createPlur(flags)
  let removed: boolean
  try {
    removed = plur.untrustDirectory(dir)
  } catch (err) {
    return exit(1, (err as Error).message)
  }

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
