import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

const USAGE =
  'Usage: plur rescope <engram-id> [<engram-id> ...] --to <scope> [--keep-local] [--dry-run]\n' +
  '  Moves engram(s) to another scope (#676). Remote target scopes (configured\n' +
  '  writable stores) receive a pushed copy (server assigns the id) and the local\n' +
  '  original is retired with a superseded_by link; local targets (local, global,\n' +
  '  project:*) are rewritten in place, preserving id and activation.\n' +
  '  --keep-local  keep the local original active after a remote push\n' +
  '  --dry-run     preview every decision without changing anything'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const ids: string[] = []
  let to: string | undefined
  let keepLocal = false
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') {
      to = args[i + 1]
      i++
    } else if (a === '--keep-local') {
      keepLocal = true
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a.startsWith('--')) {
      exit(1, `Unknown flag: ${a}\n${USAGE}`)
    } else {
      ids.push(a)
    }
  }
  if (ids.length === 0 || !to) {
    exit(1, USAGE)
  }

  const plur = createPlur(flags)
  const { results, success } = await plur.rescope(ids, to!, { keep_local: keepLocal, dry_run: dryRun })

  if (shouldOutputJson(flags)) {
    outputJson({ success, dry_run: dryRun || undefined, results })
  } else {
    for (const r of results) {
      const prefix = dryRun ? '[dry-run] ' : ''
      switch (r.status) {
        case 'rescoped':
          outputText(
            r.action === 'remote_push'
              ? `${prefix}${r.id}: ${r.from_scope} -> ${r.to_scope}${r.new_id ? ` (server id ${r.new_id})` : ''}${r.kept_local ? ' — local original kept' : ' — local original retired'}`
              : `${prefix}${r.id}: ${r.from_scope} -> ${r.to_scope} (in place)`,
          )
          break
        case 'deduped':
          outputText(`${prefix}${r.id}: identical engram already at ${r.to_scope} (${r.new_id}) — idempotent, no duplicate created`)
          break
        case 'noop':
          outputText(`${prefix}${r.id}: already in scope ${r.to_scope}`)
          break
        case 'error':
          outputText(`${prefix}${r.id}: ERROR — ${r.error}`)
          break
      }
    }
  }
  if (!success) process.exit(1)
}
