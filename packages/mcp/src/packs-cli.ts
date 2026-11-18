/**
 * `plur-mcp packs …` — the branch logic, separated from the process.
 *
 * `index.ts` is the binary entrypoint: importing it runs a top-level
 * `process.argv` dispatch and calls `process.exit`, so logic there can only be
 * tested by spawning a process. The branches here (missing argument, unknown
 * subcommand, not-found) return a result instead of writing and exiting, so
 * they are assertable in-process; `index.ts` only turns the result into
 * streams and an exit code.
 */

/** What `installPack` reports back; `neutralized` is optional so a stub can omit it. */
export interface InstallOutcome {
  name: string
  installed: number
  /** ENGRAM-STANDARD-v1 §5.6.5: what the install changed on the way in, per field. */
  neutralized?: { pinned_stripped: number; locked_downgraded: number }
}

/** Just enough of `Plur` for this command, so tests need no real store. */
export interface PacksCapablePlur {
  // `Plur.installPack` is declared `Promise<ReturnType<typeof installPack>>`
  // where `installPack` is itself async, so its type is a nested promise.
  // Awaiting it flattens either shape, and structural typing needs the
  // declaration to accept both.
  installPack(source: string): Promise<InstallOutcome | PromiseLike<InstallOutcome>>
  listPacks(): Array<{ name: string; engram_count: number; manifest?: { version?: string } | null }>
  uninstallPack(name: string): { name: string; engram_count: number }
}

export interface PacksCliResult {
  stdout: string
  stderr: string
  exitCode: number
}

const ok = (stdout: string): PacksCliResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr: string): PacksCliResult => ({ stdout: '', stderr, exitCode: 1 })

/**
 * @param args  the arguments AFTER `packs` — `['install', './pack']`
 */
export async function packsCommand(args: string[], plur: PacksCapablePlur): Promise<PacksCliResult> {
  const [sub, arg] = args

  if (sub === 'install') {
    if (!arg) return fail('Usage: plur-mcp packs install <path>\n')
    try {
      const result = await plur.installPack(arg)
      let out = `Installed pack '${result.name}' (${result.installed} engrams)\n`
      // §5.6.5: a pack altered on the way in must say so, per field. This is
      // the surface a script wrapping `plur-mcp packs install` reads.
      const n = result.neutralized
      if (n?.pinned_stripped) out += `  neutralized: pinned removed from ${n.pinned_stripped} engram(s)\n`
      if (n?.locked_downgraded) out += `  neutralized: commitment: locked downgraded to decided on ${n.locked_downgraded} engram(s)\n`
      return ok(out)
    } catch (err) {
      return fail(`Error: ${(err as Error).message}\n`)
    }
  }

  if (sub === 'list') {
    const packs = plur.listPacks()
    if (packs.length === 0) return ok('No packs installed.\n')
    return ok(packs.map(p => {
      const version = p.manifest?.version ? ` v${p.manifest.version}` : ''
      return `${p.name}${version} (${p.engram_count} engrams)\n`
    }).join(''))
  }

  if (sub === 'uninstall') {
    if (!arg) return fail('Usage: plur-mcp packs uninstall <name>\n')
    try {
      // No not-found branch: `uninstallPack` throws when the pack is absent, so
      // reaching this line already means it was removed.
      const result = plur.uninstallPack(arg)
      return ok(`Uninstalled pack '${result.name}' (${result.engram_count} engrams removed)\n`)
    } catch (err) {
      return fail(`Error: ${(err as Error).message}\n`)
    }
  }

  return fail(`Unknown packs subcommand: ${sub ?? '(none)'}\nAvailable: install, list, uninstall\n`)
}
