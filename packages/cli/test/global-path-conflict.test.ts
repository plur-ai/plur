import { describe, it, expect } from 'vitest'
import { parseGlobalFlags } from '../src/plur.js'

// security audit 2026-11-06: a `--path=/x` in a flag's value slot must not override the global --path.
describe('global --path cannot be overridden by a later token', () => {
  it('refuses a second, different --path in a flag value slot', () => {
    const r = parseGlobalFlags(['ingest', '--json', '--path', '/tmp/real-store',
      'some content', '--source', '--path=/tmp/other-store'])
    expect(r.error).toMatch(/--path was given twice/)
    expect(r.flags.path).toBe('/tmp/real-store')
  })

  it('a --path after -- stays data', () => {
    const r = parseGlobalFlags(['--path', '/tmp/a', 'ingest', '--', '--path=/tmp/b'])
    expect(r.error).toBeUndefined()
    expect(r.flags.path).toBe('/tmp/a')
    expect(r.args).toEqual(['ingest', '--', '--path=/tmp/b'])
  })
})
