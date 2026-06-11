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

    if (shouldOutputJson(flags)) {
      // result.scope is the EXISTING entry's scope on already_registered —
      // local stores have path-only identity, so it may differ from the request.
      outputJson({ success: true, status: result.status, path, scope: result.scope })
    } else {
      const verb = result.status === 'already_registered' ? 'Already registered' : result.status === 'overwritten' ? 'Reassigned' : 'Added'
      outputText(`${verb} store: ${path} (scope: ${result.scope})`)
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

  exit(1, 'Usage: plur stores <add|list>')
}
