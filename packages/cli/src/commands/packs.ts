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

  if (subcommand === 'export') {
    const name = args[1]
    if (!name) {
      exit(1, 'Usage: plur packs export <name> [--domain <domain>] [--scope <scope>] [--output <dir>]')
    }
    let domain: string | undefined
    let scope: string | undefined
    let outputDir: string | undefined
    let i = 2
    while (i < args.length) {
      if (args[i] === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
      else if (args[i] === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
      else if (args[i] === '--output' && i + 1 < args.length) { outputDir = args[++i]; i++ }
      else { i++ }
    }
    if (!outputDir) {
      outputDir = `${plur.status().storage_root}/exports`
    }
    const engrams = plur.list({ domain, scope })
    const result = plur.exportPack(engrams, outputDir, { name, version: '1.0.0' })
    if (shouldOutputJson(flags)) {
      outputJson({ path: result.path, engram_count: result.engram_count, name })
    } else {
      outputText(`Exported pack "${name}": ${result.engram_count} engrams → ${result.path}`)
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

  exit(1, `Unknown packs subcommand: "${subcommand}". Use: list, install, export`)
}
