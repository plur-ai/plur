import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * `plur audit --source engrams` (E2, 2026-09 audit follow-up) — the
 * read-only, heuristic negation-inversion scan over the LOCAL store's own
 * engrams, distinct from the other `--source` values (which cross-reference
 * an external memory FILE against engrams). See
 * `packages/core/src/inversion-scan.ts` for the detector itself.
 */
describe('plur audit --source engrams (E2)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-audit-engrams-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('flags a truncated-tail engram statement', () => {
    run(`learn "Deploying straight to production is"`)
    const out = JSON.parse(run('audit --source engrams'))
    expect(out.source).toBe('engrams')
    expect(out.heuristic).toBe(true)
    expect(out.suspects).toHaveLength(1)
    expect(out.suspects[0].shapes).toContain('truncated-tail')
  })

  it('does not flag a correctly-negated statement', () => {
    run(`learn "never commit the API key to the repo"`)
    const out = JSON.parse(run('audit --source engrams'))
    expect(out.suspects).toHaveLength(0)
    expect(out.scanned).toBe(1)
  })

  it('never mutates the store — read-only', () => {
    run(`learn "Deploying straight to production is"`)
    const before = JSON.parse(run('list'))
    run('audit --source engrams')
    const after = JSON.parse(run('list'))
    expect(after).toEqual(before)
  })

  it('is a distinct source from the default (claude-code) auto-memory pipeline', () => {
    // No auto-memory files exist for this throwaway HOME, but the engrams
    // source must still run its own scan rather than falling into the
    // MemoryEntry/classify() pipeline.
    run(`learn "Deploying straight to production is"`)
    const out = JSON.parse(run('audit --source engrams'))
    expect(out).not.toHaveProperty('counts')
    expect(out).toHaveProperty('suspects')
  })
})
