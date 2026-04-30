import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const PACKAGES_ROOT = join(__dirname, '..', '..')
// User-facing entrypoints only. core/dist intentionally uses __require to load
// ONNX native bindings via @xenova/transformers — that shim is fine as long as
// cli/mcp/claw keep @plur-ai/core external and don't inline it into their bundles.
const PACKAGES = ['cli', 'mcp', 'claw']

function walkJs(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walkJs(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

describe('no dynamic require shim in built artifacts', () => {
  for (const pkg of PACKAGES) {
    const dist = join(PACKAGES_ROOT, pkg, 'dist')
    it(`${pkg}/dist contains no __require shim (bricked cli@0.9.2 root cause)`, () => {
      const files = walkJs(dist)
      if (files.length === 0) return
      const offenders: string[] = []
      for (const f of files) {
        const src = readFileSync(f, 'utf-8')
        if (src.includes('Dynamic require of') || /\b__require\s*\(/.test(src)) {
          offenders.push(f)
        }
      }
      expect(offenders, `bundled __require shim in: ${offenders.join(', ')}`).toEqual([])
    })
  }
})
