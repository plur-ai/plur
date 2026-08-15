/**
 * --quiet behaviour per command (#730).
 *
 * Policy under test (defined in src/output.ts):
 *   - suppressed:  progress, confirmations of requested mutations, banners,
 *                  hints, summary footers
 *   - preserved:   primary output (the thing the user asked for), warnings
 *                  that the outcome differs from the request, stderr errors,
 *                  exit codes, --json output
 *
 * Text mode cannot be exercised through a spawned CLI (a piped stdout makes
 * shouldOutputJson auto-select JSON), so commands run in-process with
 * explicit `json: false` and spied stdout/stderr — the same pattern as
 * status.test.ts and sync-index-error.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('--quiet per command (#730)', () => {
  let dir: string
  let out: string[]
  let err: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-quiet-test-'))
    out = []
    err = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      err.push(String(chunk))
      return true
    }) as never)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const stdout = () => out.join('')
  const stderr = () => err.join('')

  // ── learn — confirmation suppressed, demotion warning preserved ──────────

  it('learn --quiet suppresses the confirmation lines', async () => {
    const { run } = await import('../src/commands/learn.js')
    await run(['a quiet learn statement'], { path: dir, json: false, quiet: true })
    expect(stdout()).toBe('')
  })

  it('learn without --quiet prints the confirmation', async () => {
    const { run } = await import('../src/commands/learn.js')
    await run(['a loud learn statement'], { path: dir, json: false })
    expect(stdout()).toContain('Learned: "a loud learn statement"')
    expect(stdout()).toContain('ID: ENG-')
  })

  it('learn --quiet still prints the scope-demotion warning (outcome differs from request)', async () => {
    const { run } = await import('../src/commands/learn.js')
    // A public IP in a shared scope triggers core's sensitive-content demotion.
    await run(
      ['deploy target is 139.59.155.82', '--scope', 'group:plur/core'],
      { path: dir, json: false, quiet: true },
    )
    expect(stdout()).toContain('Warning: Sensitive content')
    expect(stdout()).not.toContain('Learned:')
  })

  // ── recall — results are primary output, never suppressed ────────────────

  it('recall --quiet still prints the results', async () => {
    const { run: learn } = await import('../src/commands/learn.js')
    const { run: recall } = await import('../src/commands/recall.js')
    await learn(['always use TypeScript for new projects'], { path: dir, json: false, quiet: true })
    await recall(['TypeScript'], { path: dir, json: false, quiet: true, fast: true })
    expect(stdout()).toContain('always use TypeScript for new projects')
    expect(stdout()).toContain('[ENG-')
  })

  // ── status — banner suppressed, fields preserved ─────────────────────────

  it('status --quiet drops the banner but keeps the fields', async () => {
    const { run } = await import('../src/commands/status.js')
    await run([], { path: dir, json: false, quiet: true })
    expect(stdout()).not.toContain('Plur Status')
    expect(stdout()).toContain('Engrams:')
    expect(stdout()).toContain('Storage root:')
  })

  // ── list — table preserved, Total footer suppressed ──────────────────────

  it('list --quiet keeps the rows and drops the Total footer', async () => {
    const { run: learn } = await import('../src/commands/learn.js')
    const { run: list } = await import('../src/commands/list.js')
    await learn(['a listed statement'], { path: dir, json: false, quiet: true })
    await list([], { path: dir, json: false, quiet: true })
    expect(stdout()).toContain('a listed statement')
    expect(stdout()).not.toContain('Total:')
  })

  // ── errors — stderr and exit codes are never silenced ────────────────────

  it('feedback --quiet still reports an invalid signal on stderr with exit 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    try {
      const { run } = await import('../src/commands/feedback.js')
      await expect(run(['ENG-1', 'bogus'], { path: dir, json: false, quiet: true }))
        .rejects.toThrow('exit:1')
      expect(stderr()).toContain('Invalid signal')
      expect(stdout()).toBe('')
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('init-remote --quiet still reports a parse error on stderr with exit 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    try {
      const { run } = await import('../src/commands/init-remote.js')
      await expect(run(['--url'], { json: false, quiet: true })).rejects.toThrow('exit:1')
      expect(stderr()).toContain('--url requires a value')
      expect(stdout()).toBe('')
    } finally {
      exitSpy.mockRestore()
    }
  })
})

// ── doctor — report preserved, banner suppressed ───────────────────────────
// printText is exercised directly: run() would spawn the embedder probe
// against the test runner's argv (see the export note in doctor.ts).
describe('doctor --quiet (#730)', () => {
  let out: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    out = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
  })

  afterEach(() => stdoutSpy.mockRestore())

  async function report(): Promise<Parameters<typeof import('../src/commands/doctor.js')['printText']>[0]> {
    return {
      configs: [{
        label: 'Claude Code (global)',
        path: '/tmp/settings.json',
        exists: true,
        hasPlurMcp: true,
        hasDatacoreMcp: false,
        hasPlurHooks: false,
      }],
      hooksInstalled: false,
      mcpRegistered: true,
      datacoreCollision: false,
      staleNpxHooks: false,
      staleNpxMcp: false,
      hookShim: { valid: false, shimPath: '/tmp/shim', error: 'shim not found — run `plur init` to create it' },
      mcpShim: { valid: true, shimPath: '/tmp/mcp-shim' },
      handshake: { ok: false, error: 'skipped (--no-handshake)' },
      cursorHandshake: null,
      embedder: { available: true, loaded: true, lastError: null, modelLoaded: true, disabled: false, disabledReason: null },
      cursorProjectDetected: false,
      cursorWired: false,
      pgliteGemmaReembedNeeded: false,
      staleContentHashes: 0,
      overall: 'fail',
    }
  }

  it('suppresses only the banner; every finding still prints', async () => {
    const { printText } = await import('../src/commands/doctor.js')
    printText(await report(), { quiet: true })
    const text = out.join('')
    expect(text).not.toContain('plur doctor — Claude Code / Claude Desktop / Cursor diagnostic')
    expect(text).toContain('✗ Hooks installed')
    expect(text).toContain('✓ plur MCP server registered')
    expect(text).toContain('✗ Hook shim: shim not found')
    expect(text).toContain('✗ Issues detected.')
  })

  it('prints the banner without --quiet', async () => {
    const { printText } = await import('../src/commands/doctor.js')
    printText(await report(), { quiet: false })
    expect(out.join('')).toContain('plur doctor — Claude Code / Claude Desktop / Cursor diagnostic')
  })
})
