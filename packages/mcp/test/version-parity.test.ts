import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { VERSION as versionTs } from '../src/version.js'

/**
 * The load-bearing version constant must agree with package.json (evaluator
 * audit finding 5): index.ts's VERSION drives the pinned MCP entry that
 * `plur-mcp init` PERSISTS into user configs — a missed bump there pins every
 * new install to the previous release with the suite still green. There is
 * ONE constant (src/version.ts); index.ts imports it, and this test pins both
 * the value and the import so a second literal cannot creep back in. Same
 * guard pattern as dsh's manifest test and the CLI's version-parity test.
 */
describe('mcp version parity', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }

  it('src/version.ts matches package.json', () => {
    expect(versionTs).toBe(pkg.version)
  })

  it('index.ts (drives the persisted config pin) imports VERSION instead of repeating it', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src).toContain("import { VERSION } from './version.js'")
    expect(src).not.toMatch(/const VERSION = '/)
  })

  it('versions are release-shaped — this string is interpolated into config commands', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+([.-][0-9A-Za-z.]+)?$/)
  })
})
