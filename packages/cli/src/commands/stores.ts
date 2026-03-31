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
    plur.addStore(path, scope, { shared, readonly })

    if (shouldOutputJson(flags)) {
      outputJson({ success: true, path, scope })
    } else {
      outputText(`Added store: ${path} (scope: ${scope})`)
    }
    return
  }

  if (!subcommand || subcommand === 'list') {
    const storeList = plur.listStores()
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
