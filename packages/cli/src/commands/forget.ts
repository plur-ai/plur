import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

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
    const engram = plur.getById(target)
    if (!engram) exit(1, `Engram not found: ${target}`)
    if (engram.status === 'retired') exit(1, `Already retired: ${target}`)
    await plur.forget(target, reason)
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, retired: { id: target, statement: engram.statement } })
    } else {
      outputText(`Retired: [${target}] ${engram.statement}`)
    }
    return
  }

  // Search mode
  const matches = plur.recall(target, { limit: 100 })
  if (matches.length === 0) {
    if (shouldOutputJson(flags)) {
      outputJson({ success: false, error: `No active engrams matching "${target}"` })
    } else {
      exit(1, `No active engrams matching "${target}"`)
    }
    return
  }
  if (matches.length === 1) {
    await plur.forget(matches[0].id, reason)
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, retired: { id: matches[0].id, statement: matches[0].statement } })
    } else {
      outputText(`Retired: [${matches[0].id}] ${matches[0].statement}`)
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
