import { createPlur, type GlobalFlags } from '../plur.js'
import { requirePinPolicyConfirmation } from '../lib/pin-confirm.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { emitPlan, readPlan, parseLimit, undoCommand } from '../lib/journal-cli.js'
import type { RescopePlan } from '@plur-ai/core'

const USAGE =
  'Usage: plur rescope <engram-id> [<engram-id> ...] --to <scope> [--keep-local] [--dry-run]\n' +
  '       plur rescope --plan [--out <file>]\n' +
  '       plur rescope --apply <file> [--limit N] --yes\n' +
  '       plur rescope --undo <change-id>\n' +
  '  Moves engram(s) to another scope. Remote target scopes (configured\n' +
  '  writable stores) receive a pushed copy (server assigns the id) and the local\n' +
  '  original is retired with a superseded_by link; local targets (local, global,\n' +
  '  project:*) are rewritten in place, preserving id and activation.\n' +
  '  --keep-local  keep the local original active after a remote push\n' +
  '  --dry-run     preview every decision without changing anything\n' +
  '  --plan        propose a scope for every global engram from its domain, tags\n' +
  '                and wording, using the scopes\' covers (the router learn uses).\n' +
  '                Unplaced engrams stay global and are counted. Changes nothing;\n' +
  '                writes the plan to --out (or stdout).\n' +
  '  --apply       apply a plan as one undoable change. Only locally owned rows\n' +
  '                moving to scopes kept on this machine; a team-server target is\n' +
  '                refused (move it with --to). --limit N stops after N moves (try\n' +
  '                one first); without --yes it only previews.\n' +
  '  --undo        restore every engram a --apply moved, exactly'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const ids: string[] = []
  let to: string | undefined
  let keepLocal = false
  let dryRun = false
  let plan = false
  let out: string | undefined
  let applyFile: string | undefined
  let undoId: string | undefined
  let limit: number | undefined
  let yes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') {
      to = args[i + 1]
      i++
    } else if (a === '--keep-local') {
      keepLocal = true
    } else if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--plan') {
      plan = true
    } else if (a === '--out') {
      out = args[++i]
    } else if (a === '--apply') {
      applyFile = args[++i]
    } else if (a === '--undo') {
      undoId = args[++i]
    } else if (a === '--limit') {
      limit = parseLimit(args[++i])
    } else if (a === '--yes') {
      yes = true
    } else if (a.startsWith('--')) {
      exit(1, `Unknown flag: ${a}\n${USAGE}`)
    } else {
      ids.push(a)
    }
  }

  const modes = [plan, applyFile !== undefined, undoId !== undefined, ids.length > 0 || to !== undefined].filter(Boolean).length
  if (modes > 1) exit(1, `Use one of: <ids> --to <scope>, --plan, --apply <file>, --undo <change-id>.\n${USAGE}`)

  if (plan) return await runPlan(out, flags)
  if (applyFile !== undefined) {
    if (!applyFile) exit(1, `--apply needs a plan file.\n${USAGE}`)
    return await runApply(applyFile, limit, yes, flags)
  }
  if (undoId !== undefined) {
    if (!undoId) exit(1, `--undo needs a change id.\n${USAGE}`)
    return await undoCommand(createPlur(flags), undoId, 'rescope.apply', flags)
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

async function runPlan(out: string | undefined, flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const plan = await plur.planRescope()
  emitPlan(plan, out)
  const byScope = new Map<string, number>()
  for (const i of plan.items) byScope.set(i.to_scope, (byScope.get(i.to_scope) ?? 0) + 1)
  const remote = plan.items.filter(i => i.route === 'remote').length
  const lines = [
    `Rescope plan: ${plan.considered} global engram(s) considered, ${plan.items.length} placed, ${plan.unmapped.count} stay global (no scope's covers match).`,
    ...[...byScope.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${n.toString().padStart(5)}  -> ${s}`),
    ...(remote > 0 ? [`  ${remote} target a team server: --apply refuses those; move them with plur rescope <id> --to <scope>.`] : []),
    out ? `Written to ${out}. Review it, then: plur rescope --apply ${out} --limit 1 --yes` : '',
  ].filter(Boolean)
  // Without --out the plan itself is on stdout, so the summary goes to stderr.
  if (!out) process.stderr.write(lines.join('\n') + '\n')
  else if (shouldOutputJson(flags)) outputJson({ out, considered: plan.considered, placed: plan.items.length, unmapped: plan.unmapped.count })
  else outputText(lines.join('\n'))
}

async function runApply(file: string, limit: number | undefined, yes: boolean, flags: GlobalFlags): Promise<void> {
  if (yes) await requirePinPolicyConfirmation(createPlur(flags, { readonly: true }), `Apply the rescope plan ${file}`)
  const plan = readPlan<RescopePlan>(file, 'plur.rescope-plan')
  if (!yes) {
    const take = limit ?? plan.items.length
    const local = plan.items.filter(i => i.route === 'local')
    outputText(
      `Would move up to ${Math.min(take, local.length)} engram(s) from ${file} as one undoable change; `
      + `${plan.items.length - local.length} target a team server or an invalid scope and would be refused.\n`
      + `Nothing changed. Re-run with --yes to apply${limit === undefined ? ' (try --limit 1 first)' : ''}.`,
    )
    process.exit(1)
  }
  const plur = createPlur(flags)
  try {
    const result = await plur.applyRescopePlan(plan, limit !== undefined ? { limit } : {})
    if (shouldOutputJson(flags)) {
      outputJson({ change_id: result.change?.id ?? null, applied: result.applied, refused: result.refused })
    } else {
      for (const a of result.applied) outputText(`${a.id}: ${a.from_scope} -> ${a.to_scope}`)
      for (const r of result.refused) outputText(`${r.id}: refused — ${r.reason}`)
      outputText(result.change
        ? `Moved ${result.applied.length} engram(s) as change ${result.change.id}. Undo with: plur rescope --undo ${result.change.id}`
        : 'Nothing to move: no change recorded.')
    }
  } catch (err) {
    exit(1, `Error: ${(err as Error).message}`)
  }
}
