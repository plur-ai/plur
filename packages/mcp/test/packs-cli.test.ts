/**
 * #545 — the packs CLI's own branches, which were the only untested logic in it.
 *
 * `runPacks` delegates the work to already-tested core, so the happy paths were
 * covered by proxy. What was not covered is the part core does not do: which
 * stream a message goes to, and what exit code follows. Those are the contract
 * a script wrapping `plur-mcp packs` depends on, and a wrong exit code is
 * invisible until someone's CI silently passes on a failed install.
 *
 * Testable in-process because the branch logic moved out of the binary
 * entrypoint — see `packs-cli.ts` for why that was worth doing rather than
 * spawning.
 */
import { describe, it, expect } from 'vitest'
import { packsCommand, type PacksCapablePlur } from '../src/packs-cli.js'

/** A store stub. Every method records that it was (or was not) reached. */
function stubPlur(overrides: Partial<PacksCapablePlur> = {}): PacksCapablePlur & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async installPack(source: string) { calls.push(`install:${source}`); return { name: 'demo', installed: 3 } },
    listPacks() { calls.push('list'); return [] },
    uninstallPack(name: string) { calls.push(`uninstall:${name}`); return { name, engram_count: 7 } },
    ...overrides,
  }
}

describe('packs CLI branches (#545)', () => {
  describe('failures go to stderr and exit 1', () => {
    it.each([
      ['install with no path', ['install'], 'Usage: plur-mcp packs install <path>'],
      ['uninstall with no name', ['uninstall'], 'Usage: plur-mcp packs uninstall <name>'],
      ['unknown subcommand', ['frobnicate'], 'Unknown packs subcommand: frobnicate'],
      ['no subcommand at all', [], 'Unknown packs subcommand: (none)'],
    ])('%s', async (_label, args, expected) => {
      const plur = stubPlur()
      const res = await packsCommand(args, plur)
      expect(res.exitCode, 'a usage error must be a non-zero exit').toBe(1)
      expect(res.stderr).toContain(expected)
      expect(res.stdout, 'errors must not go to stdout — scripts parse it').toBe('')
      expect(plur.calls, 'the store must not be touched on a usage error').toEqual([])
    })
  })

  it('reports a not-found uninstall as an error, from the thrown message', async () => {
    // The path that used to have an unreachable `else` beside it. `uninstallPack`
    // throws; the catch is what actually reports not-found.
    const plur = stubPlur({
      uninstallPack(name: string): { name: string; engram_count: number } {
        throw new Error(`Pack not found: ${name}. Use 'plur packs list' to see installed packs.`)
      },
    })
    const res = await packsCommand(['uninstall', 'ghost'], plur)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('Pack not found: ghost')
    expect(res.stdout).toBe('')
  })

  it('reports a failed install as an error', async () => {
    const plur = stubPlur({
      async installPack(): Promise<{ name: string; installed: number }> { throw new Error('manifest is invalid') },
    })
    const res = await packsCommand(['install', './broken'], plur)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('Error: manifest is invalid')
  })

  describe('successes go to stdout and exit 0', () => {
    it('install', async () => {
      const res = await packsCommand(['install', './demo'], stubPlur())
      expect(res).toMatchObject({ exitCode: 0, stderr: '' })
      expect(res.stdout).toBe("Installed pack 'demo' (3 engrams)\n")
    })

    it('install reports what was neutralized, per field (§5.6.5), and stays quiet when nothing was', async () => {
      const altered = stubPlur({
        async installPack() { return { name: 'demo', installed: 3, neutralized: { pinned_stripped: 2, locked_downgraded: 1 } } },
      })
      const res = await packsCommand(['install', './demo'], altered)
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe(
        "Installed pack 'demo' (3 engrams)\n"
        + '  neutralized: pinned removed from 2 engram(s)\n'
        + '  neutralized: commitment: locked downgraded to decided on 1 engram(s)\n',
      )
      const clean = stubPlur({
        async installPack() { return { name: 'demo', installed: 3, neutralized: { pinned_stripped: 0, locked_downgraded: 0 } } },
      })
      expect((await packsCommand(['install', './demo'], clean)).stdout).toBe("Installed pack 'demo' (3 engrams)\n")
    })

    it('uninstall', async () => {
      const res = await packsCommand(['uninstall', 'demo'], stubPlur())
      expect(res).toMatchObject({ exitCode: 0, stderr: '' })
      expect(res.stdout).toBe("Uninstalled pack 'demo' (7 engrams removed)\n")
    })

    it('list, when empty, says so rather than printing nothing', async () => {
      const res = await packsCommand(['list'], stubPlur())
      expect(res).toMatchObject({ exitCode: 0, stdout: 'No packs installed.\n' })
    })

    it('list renders a version only when the manifest carries one', async () => {
      const plur = stubPlur({
        listPacks: () => [
          { name: 'with-version', engram_count: 2, manifest: { version: '1.2.0' } },
          { name: 'no-version', engram_count: 5 },
        ],
      })
      const res = await packsCommand(['list'], plur)
      expect(res.stdout).toBe('with-version v1.2.0 (2 engrams)\nno-version (5 engrams)\n')
    })
  })
})
