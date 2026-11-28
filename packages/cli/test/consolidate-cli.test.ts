/**
 * `plur consolidate` and the store-health block of `plur status` (overhaul W6).
 *
 * Spawns the built CLI against a temp store. No model is downloaded: the
 * embedding cache is filled up front with chosen vectors for the active
 * embedder (`bge-small`, 384 dimensions), so the plan reads every vector from
 * the cache. The "host model" is a small script given with `--llm-cmd`: the
 * prompt arrives on its stdin and it answers MERGE for every cluster.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { Plur, engramSearchText, _appendEmbeddingCacheEntries } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const DIM = 384

function axis(i: number): number[] { const v = new Array(DIM).fill(0); v[i] = 1; return v }
function near(i: number, j: number, cos: number): number[] { const v = axis(i); v[i] = cos; v[j] = Math.sqrt(1 - cos * cos); return v }

describe('plur consolidate (CLI)', { timeout: 120_000 }, () => {
  let home: string
  let store: string
  let env: NodeJS.ProcessEnv
  let model: string

  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync('node', [CLI, ...args, '--json'], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: (() => { try { return JSON.parse(r.stdout) } catch { return null } })() }
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'plur-consolidate-cli-'))
    store = join(home, '.plur')
    mkdirSync(store, { recursive: true })
    env = { ...isolatedHomeEnv(home), PLUR_EMBEDDER: 'bge-small', PLUR_DISABLE_EMBEDDINGS: '', PLUR_LLM_CMD: '' }
    writeFileSync(join(store, 'config.yaml'), 'backend: yaml\nconsolidate:\n  apply_enabled: true\n')
    // Write the fixtures without loading a model, then cache their vectors.
    const plur = new Plur({ path: store, autoDiscover: false })
    const rows: Array<[string, number[]]> = [
      ['Use pnpm, not npm, in this repository', axis(0)],
      ['This repository uses pnpm instead of npm', near(0, 5, 0.95)],
      ['Release notes name every behaviour change', axis(1)],
    ]
    const entries: Record<string, { hash: string; embedding: number[] }> = {}
    for (const [s, v] of rows) {
      const e = await plur.learn(s, { scope: 'global' })
      entries[e.id] = { hash: createHash('sha256').update(engramSearchText(e)).digest('hex').slice(0, 16), embedding: v }
    }
    plur.close()
    _appendEmbeddingCacheEntries(join(store, '.embeddings-cache.json'), { name: 'bge-small', dim: DIM }, entries)
    model = join(home, 'model.mjs')
    writeFileSync(model, `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{
      const out=[];for(const m of p.matchAll(/^CLUSTER_(\\d+):\\n((?:   \\[.*\\n?)+)/gm)){
        const first=/"([^"]*)"/.exec(m[2])[1];out.push('CLUSTER_'+m[1]+':\\nDECISION: MERGE\\nSTATEMENT: '+first+' (merged)\\nREASON: same')}
      process.stdout.write(out.join('\\n\\n'))})`)
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('plans with a host model command, applies a one-item trial, and undoes it', () => {
    const planFile = join(home, 'plan.json')
    const before = readFileSync(join(store, 'engrams.yaml'), 'utf8')
    const p = run(['consolidate', '--plan', '--out', planFile, '--llm-cmd', `node ${model}`])
    expect(p.code, p.stderr).toBe(0)
    expect(p.json).toMatchObject({ clusters: 1, merge: 1, pending: 0, complete: true, model: '--llm-cmd' })
    expect(readFileSync(join(store, 'engrams.yaml'), 'utf8')).toBe(before)
    const plan = JSON.parse(readFileSync(planFile, 'utf8'))
    expect(plan.clusters[0].merged_statement).toBe('Use pnpm, not npm, in this repository (merged)')

    const noYes = run(['consolidate', '--apply', planFile, '--limit', '1'])
    expect(noYes.code).toBe(1)
    expect(noYes.stderr + noYes.stdout).toContain('--yes')

    const noTrial = run(['consolidate', '--apply', planFile, '--yes'])
    expect(noTrial.code).toBe(1)
    expect(noTrial.stderr + noTrial.stdout).toContain('one-item trial')

    const a = run(['consolidate', '--apply', planFile, '--limit', '1', '--yes'])
    expect(a.code, a.stderr).toBe(0)
    expect(a.json.applied).toHaveLength(1)
    const changeId = a.json.applied[0].change_id
    expect(readFileSync(join(store, 'engrams.yaml'), 'utf8')).not.toBe(before)

    const u = run(['consolidate', '--undo', changeId])
    expect(u.code, u.stderr).toBe(0)
    expect(u.json).toMatchObject({ success: true, undone: changeId })
  })

  it('refuses to apply while consolidate.apply_enabled is false', () => {
    writeFileSync(join(store, 'config.yaml'), 'backend: yaml\n')
    const planFile = join(home, 'plan.json')
    expect(run(['consolidate', '--plan', '--out', planFile, '--llm-cmd', `node ${model}`]).code).toBe(0)
    const a = run(['consolidate', '--apply', planFile, '--limit', '1', '--yes'])
    expect(a.code).toBe(1)
    expect(a.stderr + a.stdout).toContain('apply_enabled')
  })

  it('a failing model command leaves a resumable plan', () => {
    const planFile = join(home, 'plan.json')
    const p = run(['consolidate', '--plan', '--out', planFile, '--llm-cmd', 'exit 3'])
    expect(p.code, p.stderr).toBe(0)
    expect(p.json).toMatchObject({ clusters: 1, pending: 1, complete: false })
    const r = run(['consolidate', '--plan', '--out', planFile, '--llm-cmd', `node ${model}`])
    expect(r.json).toMatchObject({ resumed: true, plan_id: p.json.plan_id, merge: 1, complete: true })
  })

  it('plur status --json carries a store-health block', () => {
    const s = run(['status'])
    expect(s.code, s.stderr).toBe(0)
    expect(s.json.store_health).toMatchObject({
      rows: 3,
      active: 3,
      near_copy: { available: true, with_vector: 3, sample_size: 3 },
      pins: { count: 0, over_share: false },
    })
    // Two of the three sampled engrams have a 0.95 neighbour.
    expect(s.json.store_health.near_copy.share_090).toBeCloseTo(2 / 3, 3)
  })
})
