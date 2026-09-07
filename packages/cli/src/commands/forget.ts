import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

const USAGE = 'Usage: plur forget <id-or-search> [--search] [--reason <reason>] [--scope <scope>]'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let target = ''
  let reason: string | undefined
  let scope: string | undefined
  let isSearch = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--reason' && i + 1 < args.length) { reason = args[++i]; i++ }
    else if (arg === '--scope') {
      // A dangling `--scope` must not become the target or be dropped: an
      // operator who typed it meant to disambiguate, and silently forgetting
      // that is how a scope-targeted retire turns into a first-match-wins one.
      if (i + 1 >= args.length || args[i + 1].trim() === '') exit(1, `--scope requires a value\n${USAGE}`)
      scope = args[++i]; i++
    }
    else if (arg === '--search') { isSearch = true; i++ }
    else if (!target) { target = arg; i++ }
    else { i++ }
  }

  if (!target) {
    exit(1, USAGE)
  }

  // If it looks like an ID (ENG-* or ABS-*), use direct forget
  // If --search flag or doesn't look like an ID, use search mode
  if (!isSearch && /^(ENG|ABS|META)-/.test(target)) {
    // With an explicit scope, let forget() do the resolving (#831): getById is
    // first-match-wins across stores, so on a colliding id it can return — and
    // this command would then echo as retired — an engram that is not the one
    // forget() acts on. Same rule as the MCP plur_forget handler.
    const engram = scope ? null : await plur.getById(target)
    if (engram) {
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

    // Not in the local corpus, or an explicit scope was given — let
    // plur.forget() resolve. getById reads the primary store, the local
    // secondary stores and the REMOTE CACHE, and that cache is a synchronous
    // peek nothing warms in a one-shot CLI process, so every remote engram —
    // namespaced (ENG-GPL-…) or not — missed here and was reported "Engram
    // not found" before forget() ever ran (#1119, #1109). forget() routes a
    // namespaced id to the store its prefix declares (#86), walks the remotes
    // for a bare id (#84), refuses an ambiguous id (#831) and an unreachable
    // declared store (#1114), and throws "Engram not found" when the id is
    // nowhere. Nothing is caught here: each of those reaches the entry point's
    // error handler as what it is, so a retire that DID happen is never
    // reported as a failure, and a failure is never dressed up as a retire.
    //
    // No statement to echo on this path — the local corpus did not have one —
    // so the report names what was asked for and, when given, where.
    await plur.forget(target, reason, { force: true, ...(scope ? { scope } : {}) })
    if (shouldOutputJson(flags)) {
      outputJson({ success: true, retired: { id: target, ...(scope ? { scope } : {}) } })
    } else {
      outputInfo(`Retired: [${target}]${scope ? ` (scope: ${scope})` : ''}`, flags)
    }
    return
  }

  // Search mode. remote:false (#776) — forget-by-search resolves LOCAL
  // retirement targets; dialing every remote host with the search phrase
  // would leak it and could surface un-forgettable remote rows as matches.
  //
  // So the only store a search hit can live in is the local one, and the only
  // `--scope` consistent with that is `primary` (the #831 escape hatch that
  // skips the remote collision probe). A remote scope here would route the
  // LOCAL match's id to that server and retire whatever row shares the id
  // there — while this command echoed the local statement as the thing
  // retired. That is the wrong-target retire #831 exists to refuse; refuse it.
  if (scope !== undefined && scope !== 'primary') {
    exit(1, `--scope "${scope}" cannot be combined with search mode: forget-by-search resolves LOCAL engrams only. `
      + 'Pass the exact id to target that store, or --scope primary.')
  }
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
    // ref-count decrement (see the direct-ID branch above). `scope` here can
    // only be `primary` (guarded above) and is passed through, not dropped.
    await plur.forget(matches[0].id, reason, { force: true, ...(scope ? { scope } : {}) })
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
