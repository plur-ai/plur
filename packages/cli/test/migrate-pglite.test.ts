import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur migrate — PGLite orphan export skipped when config selects pglite (#1061)', () => {
  let storeDir: string

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'plur-migrate-1061-'))
    // Create the pglite directory (simulates a store that exists on disk)
    mkdirSync(join(storeDir, 'store.pglite'), { recursive: true })
    // Minimal engrams.yaml so migrate has something to operate on
    writeFileSync(join(storeDir, 'engrams.yaml'), '# plur engrams\nengrams: []\n')
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  it('skips pglite_embeddings export when config.yaml has backend: pglite', () => {
    // Red case (before the fix): migrate only checked PLUR_BACKEND env var, so a
    // config.yaml-selected pglite store was treated as orphaned and the export ran.
    writeFileSync(join(storeDir, 'config.yaml'), 'backend: pglite\n')

    const stdout = execSync(`node ${CLI} migrate --json`, {
      encoding: 'utf-8',
      timeout: 15000,
      env: {
        ...process.env,
        PLUR_PATH: storeDir,
        // Explicitly unset PLUR_BACKEND — the fix must work via config alone.
        PLUR_BACKEND: '',
      },
    })

    const report = JSON.parse(stdout)
    // pglite_embeddings must be absent — the export path must not run.
    expect(report).not.toHaveProperty('pglite_embeddings')
  })

  it('runs pglite_embeddings export when pglite dir exists and pglite is NOT selected', () => {
    // Contrasting case: no backend in config → the export path IS triggered.
    // (The export will fail on an empty dir, but the field still appears.)
    writeFileSync(join(storeDir, 'config.yaml'), '# no backend selection\n')

    let stdout = ''
    try {
      stdout = execSync(`node ${CLI} migrate --json`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: {
          ...process.env,
          PLUR_PATH: storeDir,
          PLUR_BACKEND: '',
        },
      })
    } catch (err: any) { stdout = err.stdout?.toString() ?? '' }

    const report = JSON.parse(stdout)
    expect(report).toHaveProperty('pglite_embeddings')
  })
})
