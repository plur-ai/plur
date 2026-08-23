/**
 * plur provenance (#980).
 *
 * Follows the receipt command: prose by default, machine output when asked, and
 * never a blank where something was simply not recorded — a blank reads as
 * zero, an explicit "not recorded" reads as the truth.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '../src')

describe('plur provenance is wired up (#980)', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8')

  it('is registered in the command map', () => {
    expect(index).toContain("provenance: './commands/provenance.js'")
  })

  it('appears in the help text, with a line saying what it is for', () => {
    expect(index).toMatch(/provenance <id\|search>\s+Where a memory came from/)
  })

  it('exports the run function the dispatcher calls', () => {
    const cmd = readFileSync(join(SRC, 'commands/provenance.ts'), 'utf8')
    expect(cmd).toContain('export async function run(')
  })

  it('keeps --json and --record as different things', () => {
    // --json is the repo-wide machine-output flag. --record asks for the
    // JSON-LD document, which is not the same request.
    const cmd = readFileSync(join(SRC, 'commands/provenance.ts'), 'utf8')
    expect(cmd).toContain("args.includes('--record')")
    expect(cmd).not.toContain("args.includes('--json') || args.includes('--record')")
  })
})

describe('plur packs export ships provenance by default (#980, #970 case 2)', () => {
  const packs = readFileSync(join(SRC, 'commands/packs.ts'), 'utf8')

  it('starts from on, not off', () => {
    expect(packs).toContain('let provenance = true')
  })

  it('offers a way out', () => {
    expect(packs).toContain("args[i] === '--no-provenance'")
  })

  it('still accepts the old flag, so existing scripts keep working', () => {
    expect(packs).toContain("args[i] === '--provenance'")
  })

  it('passes it to the export', () => {
    expect(packs).toMatch(/exportPack\([\s\S]*?provenance,/)
  })

  it('documents the way out in the usage text', () => {
    expect(packs).toContain('--no-provenance')
    expect(packs).toMatch(/Provenance is included by default/)
  })

  it('reports the files it wrote', () => {
    expect(packs).toContain('provenance_files')
  })
})

describe('plur packs preview shows where the contents came from (#970 case 3)', () => {
  const packs = readFileSync(join(SRC, 'commands/packs.ts'), 'utf8')

  it('never puts a trust marker on an unsigned record', () => {
    // Nothing in a pack is signed. A tick would convert a claim into a belief
    // without anybody deciding to, which is worse than showing nothing.
    //
    // The check is for POSITIVE assurance only. "not verified" is the honest
    // wording we want and must not trip this; an earlier version of this test
    // searched for "verified" and failed on the very sentence it was meant to
    // protect.
    const positive = /(?<!not )(?<!never )\b(verified|trusted|authentic|genuine)\b/i
    for (const line of packs.split('\n').filter(l => l.includes('outputText'))) {
      expect(line, `this line asserts trust the code cannot back: ${line.trim()}`).not.toMatch(positive)
    }
    expect(packs).not.toContain('\u2713')
  })

  it('says out loud that the pack is only claiming this', () => {
    expect(packs).toContain('claimed by the pack, not verified')
  })

  it('keeps the full document behind a flag, so a routine preview stays short', () => {
    expect(packs).toContain("args.includes('--provenance')")
    expect(packs).toContain('pack_record')
  })
})
