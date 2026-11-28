/**
 * W8 plumbing: `plur inject --json` in unified mode carries the per-injection
 * relevance signals core computes, so the offline gate study can read them.
 * Legacy mode has no signals and the field stays absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY } from '../../core/test/helpers/injection-fixture.js'

const CLI = builtCliPath(join(__dirname, '..'))

function setup(config: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-inject-relevance-'))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFixtureStore(join(dir, '.plur'), buildLargeFixture(300).engrams, config)
  return {
    dir,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1' },
  }
}

function inject(s: { dir: string; env: NodeJS.ProcessEnv }): Record<string, unknown> {
  const r = runCli('node', [CLI, 'inject', LARGE_QUERY, '--json'], { encoding: 'utf-8', timeout: 60_000, env: s.env, cwd: s.dir })
  expect(r.status).toBe(0)
  return JSON.parse((r.stdout ?? '').trim())
}

describe('plur inject --json relevance (W8)', () => {
  let unified: { dir: string; env: NodeJS.ProcessEnv }
  let legacy: { dir: string; env: NodeJS.ProcessEnv }
  beforeAll(() => {
    unified = setup('injection:\n  mode: unified\n')
    legacy = setup('injection:\n  mode: legacy\n')
  }, 60_000)
  afterAll(() => {
    rmSync(unified.dir, { recursive: true, force: true })
    rmSync(legacy.dir, { recursive: true, force: true })
  })

  it('unified mode reports the relevance signals', () => {
    const out = inject(unified) as { relevance?: Record<string, unknown> }
    expect(out.relevance).toBeDefined()
    expect(out.relevance).toHaveProperty('top_fused')
    expect(out.relevance).toHaveProperty('top_keyword')
    expect(out.relevance).toHaveProperty('gated', false)
  }, 60_000)

  it('legacy mode leaves the field out', () => {
    expect(inject(legacy)).not.toHaveProperty('relevance')
  }, 60_000)
})
