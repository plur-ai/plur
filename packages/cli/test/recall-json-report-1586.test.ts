/**
 * #1586 audit round (PR #1587), L6: `plur recall --json` and
 * `plur inject --json` carry the per-call report — `remote` and
 * `results_complete` — as added fields. `results` / `count` and the inject
 * fields keep their shape; the Python SDK and the Hermes bridge read only
 * those.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('recall / inject --json per-call report', { timeout: 60000 }, () => {
  let dir: string
  const guardHome = mkdtempSync(join(tmpdir(), 'plur-1587-cli-home-'))
  const guardStore = mkdtempSync(join(tmpdir(), 'plur-1587-cli-store-'))
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1587-cli-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  afterAll(() => {
    rmSync(guardHome, { recursive: true, force: true })
    rmSync(guardStore, { recursive: true, force: true })
  })

  const env = () => ({
    ...process.env, HOME: guardHome, USERPROFILE: guardHome, PLUR_PATH: guardStore,
    XDG_CONFIG_HOME: join(guardHome, '.config'),
    PLUR_DISABLE_EMBEDDINGS: '1', PLUR_REMOTE_RECALL: 'off',
  })

  function run(cmd: string): { status: number; json: any } {
    try {
      const out = execSync(`node ${CLI} ${cmd} --path ${dir} --json`, { encoding: 'utf-8', timeout: 30000, env: env() })
      return { status: 0, json: JSON.parse(out) }
    } catch (err: any) {
      return { status: err.status, json: JSON.parse(String(err.stdout || '{}')) }
    }
  }

  for (const mode of ['--fast', ''] as const) {
    it(`recall ${mode || '(hybrid)'}: results plus remote and results_complete`, () => {
      run('learn "report fact about anchors"')
      const { status, json } = run(`recall "anchors" ${mode}`)
      expect(status).toBe(0)
      expect(json.count).toBe(json.results.length)
      expect(json.results.length).toBeGreaterThan(0)
      expect(json.remote).toEqual({ state: 'not_dialed', hosts: [] })
      expect(json.results_complete).toBe(true)
    })

    it(`recall ${mode || '(hybrid)'}: an empty result still says whether it is complete`, () => {
      const { status, json } = run(`recall "nothing matches this" ${mode}`)
      expect(status).toBe(2)
      expect(json.results).toEqual([])
      expect(json.count).toBe(0)
      expect(json.remote?.state).toBe('not_dialed')
      expect(json.results_complete).toBe(true)
    })
  }

  it('inject: existing fields plus remote and results_complete', () => {
    run('learn "report fact about rudders"')
    const { status, json } = run('inject "rudders"')
    expect(status).toBe(0)
    expect(typeof json.count).toBe('number')
    expect(typeof json.directives).toBe('string')
    expect(json.remote?.state).toBe('not_dialed')
    expect(json.results_complete).toBe(true)
  })
})
