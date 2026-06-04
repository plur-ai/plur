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
    const { status } = plur.addStore(path, scope, { shared, readonly })

    if (shouldOutputJson(flags)) {
      outputJson({ success: true, status, path, scope })
    } else {
      const verb = status === 'already_registered' ? 'Already registered' : status === 'overwritten' ? 'Reassigned' : 'Added'
      outputText(`${verb} store: ${path} (scope: ${scope})`)
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
