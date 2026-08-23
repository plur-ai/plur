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

describe('plur packs export --provenance (#980)', () => {
  const packs = readFileSync(join(SRC, 'commands/packs.ts'), 'utf8')

  it('accepts the flag', () => {
    expect(packs).toContain("args[i] === '--provenance'")
  })

  it('passes it to the export', () => {
    expect(packs).toMatch(/exportPack\([\s\S]*?provenance,/)
  })

  it('documents it in the usage text', () => {
    expect(packs).toContain('--provenance')
    expect(packs).toMatch(/Include a record of where each engram came from/)
  })

  it('reports the files it wrote', () => {
    expect(packs).toContain('provenance_files')
  })
})
