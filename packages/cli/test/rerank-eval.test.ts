/**
 * plur rerank-eval — CLI surface of the per-store eval gate (#451).
 *
 * The full eval path (probe synthesis, verdicts, caching, advisory) is
 * covered in core (reranker-eval.test.ts) and MCP (reranker-eval-gate.test.ts)
 * with stub adapters. The CLI subprocess can't seed adapter stubs, so these
 * tests pin the offline-safe surface: argument validation and the
 * no-reranker-configured error, which must fail fast without touching any
 * model download.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur rerank-eval (CLI surface, #451)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-revl-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): { status: number; stderr: string } {
    try {
      execSync(`node ${CLI} rerank-eval ${args} --path ${dir}`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, PLUR_RERANKER: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stderr: '' }
    } catch (err: any) {
      return { status: err.status ?? 1, stderr: String(err.stderr ?? '') }
    }
  }

  it('exits 1 with guidance when no reranker is configured', () => {
    const { status, stderr } = run('')
    expect(status).toBe(1)
    expect(stderr).toContain('PLUR_RERANKER')
  })

  it('rejects unknown reranker names, listing the usable ones', () => {
    const { status, stderr } = run('--reranker nonsense-model')
    expect(status).toBe(1)
    expect(stderr).toContain('Unknown reranker')
    expect(stderr).toContain('ms-marco-minilm-l6')
    expect(stderr).toContain('bge-reranker-v2-m3')
    expect(stderr).not.toMatch(/Known:.*\boff\b/) // "off" is not an evaluable tier
  })

  it('rejects --reranker off explicitly', () => {
    const { status, stderr } = run('--reranker off')
    expect(status).toBe(1)
    expect(stderr).toContain('Unknown reranker')
  })

  it('rejects a non-positive --sample', () => {
    const { status, stderr } = run('--reranker ms-marco-minilm-l6 --sample 0')
    expect(status).toBe(1)
    expect(stderr).toContain('--sample')
  })

  it('rejects unknown arguments with usage help', () => {
    const { status, stderr } = run('--bogus')
    expect(status).toBe(1)
    expect(stderr).toContain('Usage: plur rerank-eval')
  })
})
