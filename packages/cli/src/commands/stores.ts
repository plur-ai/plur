import { createPlur, type GlobalFlags } from '../plur.js'
import { AddRemoteStoreError, redactToken, redactTokenDeep } from '@plur-ai/core'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'

const REMOTE_USAGE =
  'Usage: plur stores add --url <url> --scope <scope> (--token <token> | --token-env <VAR> | --token -) [--overwrite-scope]'

/** Value following `name` in args, or undefined. A flag present with no value
 *  (or followed by another flag) yields '' so the caller can refuse it. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v === undefined || (v.startsWith('--') && v !== '-') ? '' : v
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `plur stores add --url <u> --scope <s> --token <t>|--token-env <VAR>|--token -`
 * (#1265). Verifies the token against the server's /me before anything is
 * written (Plur.addRemoteStore); refuses, writing nothing, when the token is
 * rejected or the scope is not one it is authorised for. The token is never
 * printed: not in text output, not in --json, not in an error.
 */
async function addRemote(args: string[], plur: ReturnType<typeof createPlur>, flags: GlobalFlags): Promise<void> {
  const url = flagValue(args, '--url')
  const scope = flagValue(args, '--scope')
  const tokenArg = flagValue(args, '--token')
  const tokenEnv = flagValue(args, '--token-env')
  if (!url || !scope) exit(1, REMOTE_USAGE)
  if (tokenArg !== undefined && tokenEnv !== undefined) exit(1, 'Pass one of --token or --token-env, not both.\n' + REMOTE_USAGE)

  let token: string
  if (tokenEnv !== undefined) {
    if (!tokenEnv) exit(1, REMOTE_USAGE)
    token = (process.env[tokenEnv] ?? '').trim()
    if (!token) exit(1, `--token-env ${tokenEnv}: that environment variable is unset or empty. Nothing was written.`)
  } else if (tokenArg === '-') {
    token = (await readStdin()).trim()
    if (!token) exit(1, '--token -: no token on stdin. Nothing was written.')
  } else if (tokenArg) {
    token = tokenArg
  } else {
    exit(1, REMOTE_USAGE)
  }

  const readonly = args.includes('--readonly')
  let result: Awaited<ReturnType<typeof plur.addRemoteStore>>
  try {
    result = await plur.addRemoteStore({
      url: url!, token, scope: scope!,
      // #1561: only the variable's name goes into config.yaml.
      ...(tokenEnv ? { tokenEnv } : {}),
      ...(readonly ? { readonly } : {}),
      ...(args.includes('--overwrite-scope') ? { overwriteScope: true } : {}),
    })
  } catch (err) {
    // AddRemoteStoreError messages are already token-free; anything else (an
    // addStore scope conflict, a write failure) is scrubbed here as well —
    // every encoding of the token, not only the exact string (audit of #1272).
    const raw = err instanceof Error ? err.message : String(err)
    let msg = redactToken(raw, token)
    // Core names its option; a CLI user needs the flag (review of #1272).
    if (err instanceof AddRemoteStoreError && err.code === 'scope_conflict') {
      msg = msg.replace('pass overwriteScope to replace that entry', 're-run with --overwrite-scope to replace that entry')
    }
    const code = err instanceof AddRemoteStoreError ? err.code : 'error'
    if (shouldOutputJson(flags)) {
      outputJson(redactTokenDeep({
        success: false, error: msg, code, url, scope,
        ...(err instanceof AddRemoteStoreError && err.authorised.length ? { authorised: err.authorised } : {}),
      }, token))
    }
    exit(1, redactToken(`Not registered: ${msg}. Nothing was written.`, token))
  }

  const kept = tokenEnv ? ` config.yaml records only the variable name (${tokenEnv}); it must be set wherever PLUR runs.` : ''
  const message = {
    added: `Added store: ${url} (scope: ${result.scope})`,
    already_registered: `Already registered: ${url} (scope: ${result.scope}) — nothing changed.`,
    token_rotated: `Updated the token for ${url} (scope: ${result.scope}) after it verified.`,
    overwritten: `Reassigned scope ${result.scope} to ${url}.`,
  }[result.status] + (result.status === 'already_registered' ? '' : kept)
  if (shouldOutputJson(flags)) {
    outputJson(redactTokenDeep({
      success: true, status: result.status, url, scope: result.scope,
      ...(result.username ? { username: result.username } : {}),
      message,
    }, token))
  } else {
    outputInfo(redactToken(
      message + (result.username && result.status !== 'already_registered' ? ` — verified as ${result.username}` : ''),
      token,
    ), flags)
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const subcommand = args[0]

  if (subcommand === 'add' && (args.includes('--url') || args.includes('--token') || args.includes('--token-env'))) {
    await addRemote(args, plur, flags)
    return
  }

  if (subcommand === 'add') {
    const path = args[1]
    const scope = args[2]
    if (!path || !scope) {
      exit(1, 'Usage: plur stores add <path> <scope> [--shared] [--readonly]\n' + REMOTE_USAGE)
    }
    const shared = args.includes('--shared')
    const readonly = args.includes('--readonly')
    const result = plur.addStore(path, scope, { shared, readonly })

    // #406: a local store is keyed by its PATH, so adding a NEW scope to an
    // already-registered path is a no-op for that scope (the existing entry's
    // scope wins). Don't report a plain success — say the requested scope was
    // not added.
    const scopeDropped = result.status === 'already_registered' && result.scope !== scope

    if (shouldOutputJson(flags)) {
      outputJson({
        success: !scopeDropped,
        status: result.status,
        path,
        scope: result.scope,
        ...(scopeDropped ? { requested_scope: scope } : {}),
      })
    } else if (scopeDropped) {
      outputText(
        `This path is already registered under scope "${result.scope}". A local store is keyed by its path, ` +
        `so the requested scope "${scope}" was NOT added. Use a separate store file for a different scope.`,
      )
    } else {
      const verb = {
        already_registered: 'Already registered',
        overwritten: 'Reassigned',
        token_rotated: 'Rotated token for',
        added: 'Added',
      }[result.status] ?? 'Added'
      // Confirmation of the requested add → suppressed by --quiet. The
      // scopeDropped branch above stays loud: the requested scope was NOT added.
      outputInfo(`${verb} store: ${path} (scope: ${result.scope})`, flags)
    }
    return
  }

  if (subcommand === 'discover') {
    const register = args.includes('--register')
    const discoveries = await plur.discoverRemoteScopes()
    const registered = register ? await plur.registerDiscoveredScopes() : []

    if (shouldOutputJson(flags)) {
      outputJson({ discovered: discoveries, ...(register ? { registered } : {}) })
      return
    }
    if (discoveries.length === 0) {
      outputText(
        'No remote stores configured. Add one scope first, then run discover:\n' +
        '  plur stores add --url <url> --scope <scope> --token-env <VAR>',
      )
      return
    }
    discoveries.forEach(d => {
      if (!d.ok) {
        outputText(`${d.url}: discovery failed — ${d.error}`)
        return
      }
      outputText(`${d.url} (${d.username || 'unknown'}, role ${d.role || 'unknown'})`)
      outputText(`  registered:   ${d.registered.join(', ') || '(none)'}`)
      outputText(`  unregistered: ${d.unregistered.join(', ') || '(none)'}`)
    })
    if (register) {
      registered.forEach(r => {
        if (!r.ok) { outputText(`${r.url}: register failed — ${r.error}`); return }
        outputText(`${r.url}: added ${r.added.length} scope(s)${r.added.length ? ` (${r.added.join(', ')})` : ''}`)
        // `skipped` now has three causes (a personal-family scope refused by the
        // #382 guard, a scope whose addStore threw — e.g. an endpoint conflict
        // from #397 — OR a dismissed scope the batch path respects, scope-audit
        // 2026-07-24), so the label stays neutral rather than asserting one cause.
        if (r.skipped.length) outputText(`  skipped ${r.skipped.length} scope(s) (not auto-registered): ${r.skipped.join(', ')}`)
      })
    } else {
      const total = discoveries.reduce((n, d) => n + d.unregistered.length, 0)
      if (total > 0) outputInfo(`\nRun \`plur stores discover --register\` to register all ${total} unregistered scope(s).`, flags)
    }
    return
  }

  if (subcommand === 'prune') {
    // #1356: removes ONLY entries that name the primary engrams file. They are
    // ignored at load already (#1319) but keep warning on every run until
    // they are gone. Any other store is left alone.
    let removed
    try {
      removed = plur.removeDuplicatePrimaryStores()
    } catch (err) {
      exit(1, `plur stores prune: ${(err as Error).message}`)
    }
    if (shouldOutputJson(flags)) {
      outputJson({ removed: removed.map(s => ({ path: s.path, scope: s.scope })), count: removed.length })
    } else if (removed.length === 0) {
      outputText('Nothing to prune: config.yaml lists no store that is the primary store file.')
    } else {
      for (const s of removed) outputText(`Removed store "${s.scope}" (${s.path}): it is the primary store file, which is always loaded.`)
    }
    return
  }

  if (!subcommand || subcommand === 'list') {
    // Async variant — accurate remote store engram_count (issue #184)
    const storeList = await plur.listStoresAsync()
    // Stores found from here that were not added because their folder has no
    // decision of its own (#1588, #1589 audit L3), with the command that adds them.
    let skipped: Array<{ path: string; folder: string }> = []
    try { skipped = plur.skippedProjectStores(process.cwd()) } catch { /* a hint never fails the list */ }
    if (shouldOutputJson(flags)) {
      outputJson({ stores: storeList, count: storeList.length, skipped })
    } else {
      if (storeList.length === 0) {
        outputText('No stores configured.')
      }
      storeList.forEach(s => {
        const flags_str = [s.shared ? 'shared' : '', s.readonly ? 'readonly' : ''].filter(Boolean).join(', ')
        outputText(`${s.path} [${s.scope}] ${s.engram_count} engrams${flags_str ? ` (${flags_str})` : ''}`)
      })
      for (const line of skippedStoreLines(skipped)) outputText(line)
    }
    return
  }

  exit(1, 'Usage: plur stores <add|list|discover|prune>')
}

/**
 * The text for project stores that were found but not added (#1589 audit L3).
 * Shared with `plur doctor`.
 */
export function skippedStoreLines(skipped: Array<{ path: string; folder: string }>): string[] {
  if (skipped.length === 0) return []
  const lines = ['', `Found ${skipped.length === 1 ? 'a memory store that was' : `${skipped.length} memory stores that were`} not added, because ${skipped.length === 1 ? 'its folder has' : 'their folders have'} no decision of ${skipped.length === 1 ? 'its' : 'their'} own (#1588):`]
  for (const s of skipped) {
    lines.push(`   - ${s.path}`)
    lines.push(`     To use it: plur folders set ${s.folder} --on`)
  }
  return lines
}
