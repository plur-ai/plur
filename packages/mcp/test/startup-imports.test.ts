import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

/**
 * `plur-mcp --help`, `--version` and `init` must not load @plur-ai/core: the
 * entry point imports core lazily. This walks the static imports of the built
 * entry and every local chunk it pulls in and fails on a static core import.
 */
const DIST = join(__dirname, '..', 'dist')

function staticImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(/^(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)].map(m => m[1] ?? m[2])
}

describe('plur-mcp startup', () => {
  it('the entry bundle does not statically import @plur-ai/core', () => {
    const entry = join(DIST, 'index.js')
    expect(existsSync(entry), 'build packages/mcp first').toBe(true)
    const seen = new Set<string>()
    const offenders: string[] = []
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of staticImports(file)) {
        if (spec === '@plur-ai/core' || spec.startsWith('@plur-ai/core/')) offenders.push(file)
        else if (spec.startsWith('./') || spec.startsWith('../')) visit(join(dirname(file), spec))
      }
    }
    visit(entry)
    expect(seen.size).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })
})
