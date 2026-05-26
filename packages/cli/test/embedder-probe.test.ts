import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur _embedder-probe (issue #197)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-probe-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('refuses to run when called directly (no PLUR_INTERNAL_PROBE env var)', () => {
    // Should exit 1 with a stderr explanation. We expect execSync to throw.
    let threw = false
    let stderr = ''
    try {
      execSync(`node ${CLI} _embedder-probe --path ${dir}`, {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, PLUR_INTERNAL_PROBE: '' },
      })
    } catch (err: any) {
      threw = true
      stderr = (err.stderr ?? '').toString()
    }
    expect(threw).toBe(true)
    expect(stderr).toMatch(/internal subcommand/i)
    expect(stderr).toMatch(/plur doctor/i)
  })

  it('runs and emits JSON status when invoked with PLUR_INTERNAL_PROBE=1', () => {
    // Force embeddings off so the probe completes quickly without loading
    // the BGE model — we're testing the contract (JSON shape + exit 0),
    // not the actual embedder.
    const output = execSync(`node ${CLI} _embedder-probe --path ${dir}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, PLUR_INTERNAL_PROBE: '1', PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    const lastJsonLine = output.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop()
    expect(lastJsonLine).toBeDefined()
    const parsed = JSON.parse(lastJsonLine!)
    expect(parsed).toHaveProperty('available')
    expect(parsed).toHaveProperty('loaded')
    expect(parsed).toHaveProperty('modelLoaded')
    expect(parsed).toHaveProperty('disabled')
    expect(parsed).toHaveProperty('disabledReason')
    // When PLUR_DISABLE_EMBEDDINGS=1, the embedder is disabled by design.
    expect(parsed.disabled).toBe(true)
  })
})
