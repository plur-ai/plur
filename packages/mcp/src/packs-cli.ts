/**
 * `plur-mcp packs …` — the branch logic, separated from the process (#545).
 *
 * This lived inline in `index.ts`, which is the binary entrypoint: importing it
 * runs a top-level `process.argv` dispatch and calls `process.exit`. So the only
 * way to test the CLI branches was to spawn a real process — and spawning is the
 * contention class #793 had to serialise a whole vitest project to contain.
 *
 * The branches here are the only real logic in the command (`runPacks`
 * otherwise delegates to already-tested core): missing argument, unknown
 * subcommand, and not-found. Returning a result instead of writing and exiting
 * makes those three assertable in-process, and leaves `index.ts` with the one
 * job a binary should have — turn a result into streams and an exit code.
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
      // reaching this line already means it was removed. The `else` that used
      // to sit here could not run — see `UninstallResult.removed` (#545).
      const result = plur.uninstallPack(arg)
      return ok(`Uninstalled pack '${result.name}' (${result.engram_count} engrams removed)\n`)
    } catch (err) {
      return fail(`Error: ${(err as Error).message}\n`)
    }
  }

  return fail(`Unknown packs subcommand: ${sub ?? '(none)'}\nAvailable: install, list, uninstall\n`)
}
