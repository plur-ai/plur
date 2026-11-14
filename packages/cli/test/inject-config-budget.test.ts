/**
 * `injection_budget` in config.yaml reaches every injection path: `plur inject`
 * uses it when no --budget is given (it was a fixed 2,000), and event hooks use
 * it when it is larger than their 3,000 floor (it was a fixed 3,000).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY } from '../../core/test/helpers/injection-fixture.js'
import { eventInjectOptions } from '../src/commands/hook-inject.js'

const CLI = builtCliPath(join(__dirname, '..'))

function setup(config: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'plur-inject-budget-'))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFixtureStore(join(dir, '.plur'), buildLargeFixture(300).engrams, config)
  return { dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1' } }
}

function tokens(s: { dir: string; env: NodeJS.ProcessEnv }, extra: string[] = []): number {
  const r = runCli('node', [CLI, 'inject', LARGE_QUERY, '--json', ...extra], { encoding: 'utf-8', timeout: 60_000, env: s.env, cwd: s.dir })
  expect(r.status).toBe(0)
  return JSON.parse((r.stdout ?? '').trim()).tokens_used
}

describe('plur inject honours injection_budget', () => {
  let small: { dir: string; env: NodeJS.ProcessEnv }
  beforeAll(() => { small = setup('injection_budget: 300\n') }, 60_000)
  afterAll(() => { rmSync(small.dir, { recursive: true, force: true }) })

  it('stays within the configured budget when no --budget is given', () => {
    expect(tokens(small)).toBeLessThanOrEqual(300)
  })
  it('--budget still wins over the config', () => {
    expect(tokens(small, ['--budget', '1500'])).toBeGreaterThan(300)
  })
})

describe('event hooks honour a larger injection_budget', () => {
  it('keeps 3,000 when the config budget is unset or smaller', () => {
    expect(eventInjectOptions({ remoteOnly: false }).budget).toBe(3000)
    expect(eventInjectOptions({ remoteOnly: false, configBudget: 2000 }).budget).toBe(3000)
  })
  it('uses the config budget when it is larger', () => {
    expect(eventInjectOptions({ remoteOnly: false, configBudget: 10000 }).budget).toBe(10000)
  })
})
