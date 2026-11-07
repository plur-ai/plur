/**
 * Security audit 2026-11-06: an engrams.yaml record (for example one pulled
 * from a shared sync remote) can hold a YAML alias lattice in
 * structured_data. js-yaml resolves aliases as shared references in linear
 * time, the record passes the schema, and saveEngrams re-serializes with
 * `noRefs: true`, which materializes every alias: a ~2 KB record became tens
 * of MB on the next write. The loader now bounds the alias-expanded size of a
 * store document and refuses one that exceeds it as unreadable.
 *
 * Dummy data only; HOME and PLUR_PATH point at temp dirs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadEngrams, EngramStoreUnreadableError, engramStoreEntries } from '../src/engrams.js'
import { Plur } from '../src/index.js'

function lattice(depth: number): string {
  const lines = ['      l0: &a0 x']
  for (let i = 1; i <= depth; i++) lines.push(`      l${i}: &a${i} [*a${i - 1}, *a${i - 1}]`)
  lines.push(`      top: *a${depth}`)
  return lines.join('\n')
}

function storeWith(record: string): string {
  return [
    'engrams:',
    '  - id: ENG-2026-11-06-001',
    '    statement: Dummy ordinary note',
    '    type: behavioral',
    '    scope: global',
    '    status: active',
    '  - id: ENG-2026-11-06-900',
    '    statement: Dummy teammate note',
    '    type: behavioral',
    '    scope: global',
    '    status: active',
    '    structured_data:',
    record,
    '',
  ].join('\n')
}

describe('engram store alias expansion bound (security audit 2026-11-06)', () => {
  let root: string
  let prevHome: string | undefined
  let prevPlurPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-alias-'))
    prevHome = process.env.HOME
    prevPlurPath = process.env.PLUR_PATH
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    process.env.PLUR_PATH = join(root, 'store')
  })
  afterEach(() => {
    process.env.HOME = prevHome
    if (prevPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = prevPlurPath
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a store whose record holds a depth-20 alias lattice', () => {
    const p = join(root, 'engrams.yaml')
    const content = storeWith(lattice(20))
    expect(content.length).toBeLessThan(4096)
    writeFileSync(p, content)
    const t0 = Date.now()
    expect(() => loadEngrams(p)).toThrow(EngramStoreUnreadableError)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(() => engramStoreEntries(p, content, Buffer.byteLength(content))).toThrow(/expand/)
  })

  it('a write against such a store does not amplify the file', async () => {
    const dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), 'index: false\n')
    const p = join(dir, 'engrams.yaml')
    writeFileSync(p, storeWith(lattice(20)))
    const before = statSync(p).size
    const plur = new Plur({ path: dir })
    await expect(plur.learn('Dummy new note', { type: 'behavioral' })).rejects.toThrow()
    expect(statSync(p).size).toBe(before)
    expect(readFileSync(p, 'utf8')).toContain('&a20')
  })

  it('still loads ordinary stores, including small shared aliases and large plain stores', () => {
    const p = join(root, 'engrams.yaml')
    writeFileSync(p, storeWith(lattice(3)))
    expect(loadEngrams(p).length).toBe(2)

    const many = ['engrams:']
    for (let i = 0; i < 3000; i++) {
      many.push(`  - id: ENG-2026-11-06-${String(i).padStart(4, '0')}`, `    statement: Dummy note ${i}`,
        '    type: behavioral', '    scope: global', '    status: active', '    tags: [a, b, c]')
    }
    writeFileSync(p, many.join('\n') + '\n')
    expect(loadEngrams(p).length).toBe(3000)
  })
})
