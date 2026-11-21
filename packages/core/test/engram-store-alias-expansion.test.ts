// security audit 2026-11-06: a store whose YAML aliases expand past its own size is refused as unreadable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadEngrams, EngramStoreUnreadableError, engramStoreEntries } from '../src/engrams.js'

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
