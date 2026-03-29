import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  const subcommand = args[0]

  if (!subcommand || subcommand === 'list') {
    const packs = plur.listPacks()
    if (shouldOutputJson(flags)) {
      outputJson({ packs, count: packs.length })
    } else {
      if (packs.length === 0) {
        outputText('No packs installed.')
        return
      }
      packs.forEach(p => {
        const version = p.manifest?.version ?? 'unknown'
        outputText(`${p.name} v${version} (${p.engram_count} engrams)`)
      })
    }
    return
  }

  if (subcommand === 'install') {
    const source = args[1]
    if (!source) {
      exit(1, 'Usage: plur packs install <source>')
    }
    const result = plur.installPack(source)
    if (shouldOutputJson(flags)) {
      outputJson(result)
    } else {
      outputText(`Installed pack "${result.name}": ${result.installed} engrams`)
    }
    return
  }

  exit(1, `Unknown packs subcommand: "${subcommand}". Use: list, install`)
}
