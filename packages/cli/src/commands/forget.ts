import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

/**
 * Flags this command accepts (#986). `forget` RETIRES a memory, and an
 * unrecognised flag was swallowed while it went ahead — the most damaging
 * place in the tool for a silent misunderstanding.
 */
export const FLAGS = ['--search', '--reason', '--force']

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let target = ''
  let reason: string | undefined
  let isSearch = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--reason' && i + 1 < args.length) { reason = args[++i]; i++ }
    else if (arg === '--search') { isSearch = true; i++ }
    else if (!target) { target = arg; i++ }
    else { i++ }
  }

  if (!target) {
    exit(1, 'Usage: plur forget <id-or-search> [--search] [--reason <reason>]')
  }

  // If it looks like an ID (ENG-* or ABS-*), use direct forget
  // If --search flag or doesn't look like an ID, use search mode
  if (!isSearch && /^(ENG|ABS|META)-/.test(target)) {
    const engram = await plur.getById(target)
    if (!engram) exit(1, `Engram not found: ${target}`)
    if (engram.status === 'retired') exit(1, `Already retired: ${target}`)
    // force (#766): `plur forget` is an explicit user-facing forget — same
    // surface as MCP plur_forget. Without force, a multiply-learned engram
    // (reference_count > 1) only decrements and stays active, and a later
    // learn() at a different scope re-matches it and inherits the old scope.
    await plur.forget(target, reason, { force: true })
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, retired: { id: target, statement: engram.statement } })
    } else {
      outputInfo(`Retired: [${target}] ${engram.statement}`, flags)
    }
    return
  }

  // Search mode. remote:false (#776) — forget-by-search resolves LOCAL
  // retirement targets; dialing every remote host with the search phrase
  // would leak it and could surface un-forgettable remote rows as matches.
  const matches = await plur.recall(target, { limit: 100, remote: false })
  if (matches.length === 0) {
    if (shouldOutputJson(flags)) {
      outputJson({ success: false, error: `No active engrams matching "${target}"` })
    } else {
      exit(1, `No active engrams matching "${target}"`)
    }
    return
  }
  if (matches.length === 1) {
    // force (#766): explicit user-facing forget — full retirement, not a
    // ref-count decrement (see the direct-ID branch above).
    await plur.forget(matches[0].id, reason, { force: true })
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, retired: { id: matches[0].id, statement: matches[0].statement } })
    } else {
      outputInfo(`Retired: [${matches[0].id}] ${matches[0].statement}`, flags)
    }
    return
  }
  // Multiple matches — show them
  if (shouldOutputJson(flags)) {
    outputJson({
      success: false,
      matches: matches.slice(0, 20).map(e => ({ id: e.id, statement: e.statement })),
      total: matches.length,
      error: `${matches.length} matches. Specify exact ID.`,
    })
  } else {
    outputText(`${matches.length} matches found. Specify exact ID:`)
    for (const e of matches.slice(0, 20)) {
      outputText(`  ${e.id}  ${e.statement}`)
    }
  }
}
