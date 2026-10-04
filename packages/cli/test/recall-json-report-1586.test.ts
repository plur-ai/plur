/**
 * #1586 audit round (PR #1587), L6: `plur recall --json` and
 * `plur inject --json` carry the per-call report — `remote` and
 * `results_complete` — as added fields. `results` / `count` and the inject
 * fields keep their shape; the Python SDK and the Hermes bridge read only
 * those.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

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

describe('D4 — a missing embedding model is reported by cause', { timeout: 60000 }, () => {
  let dir: string
  const home = mkdtempSync(join(tmpdir(), 'plur-1587-cli-d4-home-'))
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-1587-cli-d4-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  it('recall --json: mode, reason and next step; the stderr note names the model, not the team store', () => {
    const base = {
      ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: join(home, 'plur'),
      XDG_CONFIG_HOME: join(home, '.config'), PLUR_REMOTE_RECALL: 'off',
    }
    execSync(`node ${CLI} learn "report fact about anchors" --path ${dir} --json`, {
      encoding: 'utf-8', timeout: 30000, env: { ...base, PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    // Embeddings on, the model cache somewhere nothing can be downloaded to,
    // and offline: the model is missing and nothing is fetched.
    writeFileSync(join(home, 'blocker'), 'a file, so no cache folder can be created under it')
    const env = { ...base, PLUR_DISABLE_EMBEDDINGS: '', PLUR_MODEL_CACHE_DIR: join(home, 'blocker', 'models'), HF_HUB_OFFLINE: '1' }
    const r = spawnSync('node', [CLI, 'recall', 'anchors', '--path', dir, '--json'], { encoding: 'utf-8', timeout: 30000, env })
    const json = JSON.parse(r.stdout)
    expect(json.results.length).toBeGreaterThan(0)
    expect(json.results_complete).toBe(false)
    expect(json.mode).toBe('hybrid-degraded')
    expect(json.degraded_reason).toBe('embedding_model_missing')
    expect(String(json.embedder_error)).toMatch(/plur doctor/)
    expect(r.stderr).toMatch(/plur doctor/)
    expect(r.stderr).not.toMatch(/team store/)
  })
})

describe('plur init on a fresh install without the embedding model', { timeout: 60000 }, () => {
  it('prints the one-line hint to run plur doctor', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-1587-init-'))
    try {
      writeFileSync(join(home, 'blocker'), 'x')
      let out = ''
      try {
        out = execSync(`node ${CLI} init --global --no-prompt --no-cursor --no-desktop --no-codex --no-antigravity`, {
          encoding: 'utf-8', timeout: 45000, cwd: home,
          env: { ...isolatedHomeEnv(home), PLUR_PATH: join(home, '.plur'), PLUR_DISABLE_EMBEDDINGS: '', PLUR_MODEL_CACHE_DIR: join(home, 'blocker', 'models'), HF_HUB_OFFLINE: '1' },
        })
      } catch (err) {
        out = String((err as { stdout?: unknown }).stdout ?? '')
      }
      expect(out).toMatch(/embedding model.*plur doctor|plur doctor.*embedding model/i)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
