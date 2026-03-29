import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('version', () => {
  const pkgVersion = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
  ).version

  it('matches package.json', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8')
    expect(src).toContain(`const VERSION = '${pkgVersion}'`)
  })
})
