import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('version', () => {
  it('index.ts imports CLI_VERSION instead of repeating it', () => {
    // The value itself is pinned to package.json by version-parity.test.ts;
    // this guards that index.ts has no second literal to drift from it.
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8')
    expect(src).toContain("import { CLI_VERSION as VERSION } from './version.js'")
    expect(src).not.toMatch(/const VERSION = '/)
  })
})
