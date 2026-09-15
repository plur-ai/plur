import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENCODE_PLUGIN_VERSION } from '../src/version.js'

describe('opencode plugin version parity', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string }

  it('src/version.ts matches package.json', () => {
    expect(OPENCODE_PLUGIN_VERSION).toBe(pkg.version)
  })

  it('index.ts imports the constant rather than repeating it', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src).toContain("from './version.js'")
    expect(src).not.toMatch(/version: '\d+\.\d+\.\d+'/)
  })
})
