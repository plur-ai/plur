import { describe, it, expect } from 'vitest'
import { parseGlobalFlags } from '../src/plur.js'

// Security audit 2026-11-06: a `--path=/x` token in a command flag's value
// slot (`ingest <content> --source --path=/x`) overrode the global --path the
// caller (the Hermes bridge) had already given, so ingest wrote to /x.
describe('global --path cannot be overridden by a later token', () => {
  it('refuses a second, different --path in a flag value slot', () => {
    const r = parseGlobalFlags(['ingest', '--json', '--path', '/tmp/real-store',
      'some content', '--source', '--path=/tmp/other-store'])
    expect(r.error).toMatch(/--path was given twice/)
    expect(r.flags.path).toBe('/tmp/real-store')
  })

  it('refuses a second, different --path given as two tokens', () => {
    const r = parseGlobalFlags(['--path', '/tmp/a', 'timeline', '--path', '/tmp/b'])
    expect(r.error).toMatch(/--path was given twice/)
    expect(r.flags.path).toBe('/tmp/a')
  })

  it('accepts the same --path repeated', () => {
    const r = parseGlobalFlags(['--path', '/tmp/a', 'status', '--path=/tmp/a'])
    expect(r.error).toBeUndefined()
    expect(r.flags.path).toBe('/tmp/a')
  })

  it('still accepts a single --path anywhere before --', () => {
    const r = parseGlobalFlags(['recall', 'query', '--path', '/tmp/a'])
    expect(r.error).toBeUndefined()
    expect(r.flags.path).toBe('/tmp/a')
  })

  it('a --path after -- stays data', () => {
    const r = parseGlobalFlags(['--path', '/tmp/a', 'ingest', '--', '--path=/tmp/b'])
    expect(r.error).toBeUndefined()
    expect(r.flags.path).toBe('/tmp/a')
    expect(r.args).toEqual(['ingest', '--', '--path=/tmp/b'])
  })
})
