import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const subcommand = args[0]

  if (subcommand === 'add') {
    const path = args[1]
    const scope = args[2]
    if (!path || !scope) {
      exit(1, 'Usage: plur stores add <path> <scope> [--shared] [--readonly]')
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
      outputText(`${verb} store: ${path} (scope: ${result.scope})`)
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
      outputText('No remote stores configured. Add one scope with `plur stores add`, then run discover.')
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
        if (r.skipped.length) outputText(`  skipped ${r.skipped.length} non-shared scope(s) (not auto-registered): ${r.skipped.join(', ')}`)
      })
    } else {
      const total = discoveries.reduce((n, d) => n + d.unregistered.length, 0)
      if (total > 0) outputText(`\nRun \`plur stores discover --register\` to register all ${total} unregistered scope(s).`)
    }
    return
  }

  if (!subcommand || subcommand === 'list') {
    // Async variant — accurate remote store engram_count (issue #184)
    const storeList = await plur.listStoresAsync()
    if (shouldOutputJson(flags)) {
      outputJson({ stores: storeList, count: storeList.length })
    } else {
      if (storeList.length === 0) {
        outputText('No stores configured.')
        return
      }
      storeList.forEach(s => {
        const flags_str = [s.shared ? 'shared' : '', s.readonly ? 'readonly' : ''].filter(Boolean).join(', ')
        outputText(`${s.path} [${s.scope}] ${s.engram_count} engrams${flags_str ? ` (${flags_str})` : ''}`)
      })
    }
    return
  }

  exit(1, 'Usage: plur stores <add|list|discover>')
}
