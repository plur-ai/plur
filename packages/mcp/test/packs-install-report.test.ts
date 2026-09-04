/**
 * What `plur_packs_install` tells the agent (ENGRAM-STANDARD-v1 §5.6.5).
 *
 * Invariant: an install that changed the pack on the way in says so, per
 * field, on the surface the agent reads — and a pack that ships an engram
 * declaring `visibility: private` is refused here exactly as it is in core,
 * with no tool argument that reaches past the refusal (§5.6.1 step 2).
 *
 * Core computed both the neutralization counts and the integrity verdict and
 * this tool dropped them, so an agent could not tell the user that a pack had
 * tried to pin itself into every session, nor that the pack shipped no
 * integrity value at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

let dir: string
let plur: Plur

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-mcp-packs-'))
  plur = new Plur({ path: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tool = (name: string) => getToolDefinitions('full').find(t => t.name === name)!

function writePack(name: string, engrams: Array<Record<string, unknown>>): string {
  const packDir = join(dir, name)
  mkdirSync(packDir)
  writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0.0"\n---\n\n# ${name}\n`)
  const lines = ['engrams:']
  for (const e of engrams) {
    let first = true
    for (const [k, v] of Object.entries(e)) {
      lines.push(`${first ? '  - ' : '    '}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
      first = false
    }
    lines.push('    activation:', '      retrieval_strength: 0.7', '      storage_strength: 1.0', '      frequency: 0', '      last_accessed: "2026-01-01"')
  }
  writeFileSync(join(packDir, 'engrams.yaml'), lines.join('\n') + '\n')
  return packDir
}
const engram = (id: string, extra: Record<string, unknown> = {}) => ({
  id, statement: `rule ${id}`, type: 'behavioral', scope: 'global', status: 'active', version: 2, visibility: 'public', ...extra,
})

describe('plur_packs_install reports what §5.6.5 requires', () => {
  it('carries the neutralization counts per field and the integrity verdict', async () => {
    const packDir = writePack('hostile', [
      engram('ENG-2026-0101-001', { pinned: true }),
      engram('ENG-2026-0101-002', { pinned: true, commitment: 'locked' }),
      engram('ENG-2026-0101-003'),
    ])
    const result = await tool('plur_packs_install').handler({ source: packDir }, plur) as Record<string, unknown>
    expect(result.success).toBe(true)
    expect(result.installed).toBe(3)
    expect(result.neutralized).toEqual({ pinned_stripped: 2, locked_downgraded: 1 })
    // "The pack shipped none" is a third verdict, distinct from "matched".
    expect((result.integrity_check as { status: string }).status).toBe('absent')
  })

  it('reports zero for a pack that needed no neutralization', async () => {
    const packDir = writePack('clean', [engram('ENG-2026-0101-001')])
    const result = await tool('plur_packs_install').handler({ source: packDir }, plur) as Record<string, unknown>
    expect(result.neutralized).toEqual({ pinned_stripped: 0, locked_downgraded: 0 })
  })

  it('refuses a pack that declares a private engram, and installs nothing', async () => {
    const packDir = writePack('leak', [engram('ENG-2026-0101-001', { visibility: 'private' })])
    await expect(tool('plur_packs_install').handler({ source: packDir }, plur)).rejects.toThrow(/declare visibility: private/)
    const listed = await tool('plur_packs_list').handler({}, plur) as { packs: unknown[] }
    expect(listed.packs).toEqual([])
  })

  it('the preview warns about a declared private engram before install refuses it', async () => {
    const packDir = writePack('leak', [engram('ENG-2026-0101-001', { visibility: 'private' })])
    const preview = await tool('plur_packs_preview').handler({ source: packDir }, plur) as { warnings: string[]; security: { clean: boolean } }
    expect(preview.security.clean).toBe(false)
    expect(preview.warnings.join('\n')).toMatch(/declare visibility: private/)
  })
})
