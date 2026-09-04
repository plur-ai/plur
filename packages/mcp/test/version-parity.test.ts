import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { VERSION as versionTs } from '../src/version.js'

/**
 * The load-bearing version constants must agree with package.json (evaluator
 * audit finding 5): index.ts's VERSION drives the pinned MCP entry that
 * `plur-mcp init` PERSISTS into user configs — a missed sed bump there pins
 * every new install to the previous release with the suite still green. Same
 * guard pattern as dsh's manifest test and the CLI's version-parity test.
 */
describe('mcp version parity', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }

  it('src/version.ts matches package.json', () => {
    expect(versionTs).toBe(pkg.version)
  })

  it('index.ts const VERSION (drives the persisted config pin) matches package.json', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const m = /const VERSION = '([^']+)'/.exec(src)
    expect(m?.[1]).toBe(pkg.version)
  })

  it('versions are release-shaped — this string is interpolated into config commands', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+([.-][0-9A-Za-z.]+)?$/)
  })
})
