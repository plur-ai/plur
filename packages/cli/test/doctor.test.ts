import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur doctor', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-doctor-test-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function runDoctor(): { stdout: string; status: number } {
    try {
      const stdout = execSync(`node ${CLI} doctor --no-handshake --json`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        cwd: home,
      })
      return { stdout, status: 0 }
    } catch (err: any) {
      return { stdout: err.stdout?.toString() ?? '', status: err.status ?? 1 }
    }
  }

  function writeGlobalSettings(content: object): void {
    const dir = join(home, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(content, null, 2))
  }

  it('reports fail and exits non-zero on a fresh empty environment', () => {
    const { stdout, status } = runDoctor()
    const report = JSON.parse(stdout)

    expect(status).toBe(1)
    expect(report.overall).toBe('fail')
    expect(report.hooksInstalled).toBe(false)
    expect(report.mcpRegistered).toBe(false)
  })

  it('warns to re-embed only on PGLite + embedding-gemma (#581)', () => {
    // Explicit non-triggering values in the negative cases so the assertion is
    // robust against an ambient PLUR_BACKEND/PLUR_EMBEDDER in the test shell.
    // doctor emits JSON in a non-TTY pipe (execSync), so assert on the report
    // field, which the printText advisory is gated on 1:1. Explicit
    // non-triggering values in the negatives keep the assertion robust against
    // an ambient PLUR_BACKEND/PLUR_EMBEDDER in the test shell.
    const flag = (over: Record<string, string>): boolean => {
      let out = ''
      try {
        out = execSync(`node ${CLI} doctor --no-handshake --json`, {
          encoding: 'utf-8', timeout: 15000, cwd: home,
          // Skip the embedder model probe — this test only checks env-derived
          // backend/embedder detection, and 4 spawns × a cold model load blows
          // the vitest timeout.
          env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_DISABLE_EMBEDDINGS: '1', ...over },
        })
      } catch (err: any) { out = err.stdout?.toString() ?? '' } // doctor exits 1 on empty env
      const report = JSON.parse(out)
      // Advisory only: it must never flip the overall verdict on its own.
      expect(report.overall).toBe('fail') // empty env fails regardless of this flag
      return report.pgliteGemmaReembedNeeded
    }

    // Both opt-ins set → advisory fires; any other combination stays silent.
    expect(flag({ PLUR_BACKEND: 'pglite', PLUR_EMBEDDER: 'embedding-gemma' })).toBe(true)
    expect(flag({ PLUR_BACKEND: 'pglite', PLUR_EMBEDDER: 'bge-small' })).toBe(false)
    expect(flag({ PLUR_BACKEND: 'sqlite', PLUR_EMBEDDER: 'embedding-gemma' })).toBe(false)
    expect(flag({ PLUR_BACKEND: 'sqlite', PLUR_EMBEDDER: 'bge-small' })).toBe(false)
  }, 30000)

  it('reports ok when both hooks and plur MCP are present', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout, status } = runDoctor()
    const report = JSON.parse(stdout)

    expect(status).toBe(0)
    expect(report.overall).toBe('ok')
    expect(report.hooksInstalled).toBe(true)
    expect(report.mcpRegistered).toBe(true)
    expect(report.datacoreCollision).toBe(false)
  })

  it('flags datacore collision when both servers are registered', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
        datacore: { command: 'node', args: ['/path/to/datacore.js'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.datacoreCollision).toBe(true)
    // Should still be ok overall — collision is a warning, not a failure
    expect(report.mcpRegistered).toBe(true)
    expect(report.hooksInstalled).toBe(true)
  })

  it('detects hooks-only install (the broken pre-0.8.1 state)', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
    })

    const { stdout, status } = runDoctor()
    const report = JSON.parse(stdout)

    expect(status).toBe(1)
    expect(report.hooksInstalled).toBe(true)
    expect(report.mcpRegistered).toBe(false)
    expect(report.overall).toBe('fail')
  })

  it('lists all known config file locations in the report', () => {
    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    const labels = report.configs.map((c: { label: string }) => c.label)
    expect(labels).toContain('Claude Code (global)')
    expect(labels).toContain('Claude Desktop')
    expect(labels).toContain('Claude Code (.mcp.json)')
  })

  it('handshake is skipped when --no-handshake is passed', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.handshake.error).toContain('skipped')
    // ok overall because handshake is gated behind the skip flag
    expect(report.overall).toBe('ok')
  })

  // Coverage gap: EVERY other test here runs `doctor --no-handshake`, so
  // `overall` is computed with the live MCP handshake DISABLED and can never
  // reflect a server that fails to start. Exercise the handshake ENABLED against
  // a fake MCP shim that starts but never completes the JSON-RPC initialize — the
  // handshake must fail and drive overall to 'fail'. Green today: overall gates on
  // handshake.ok when not skipped (doctor.ts:569-570).
  it('probes the CONFIGURED server, not the shim it would have recommended (#764)', () => {
    // Discriminating on purpose. The previous test points the config at the
    // same shim `buildMcpServerEntry()` prefers, so both the old synthesised
    // probe and the new config-first one spawn the identical script and no
    // assertion can tell them apart — it passes either way and guards nothing.
    //
    // Here the two disagree: the shim is one script, the config names another.
    // Only a probe that reads the config launches `configured`.
    const binDir = join(home, '.plur', 'bin')
    mkdirSync(binDir, { recursive: true })
    const shim = join(binDir, 'plur-mcp')
    writeFileSync(shim, '#!/bin/sh\nsleep 0.5\nexit 0\n', { mode: 0o755 })
    chmodSync(shim, 0o755)

    const configured = join(home, 'configured-server.sh')
    writeFileSync(configured, '#!/bin/sh\nsleep 0.5\nexit 0\n', { mode: 0o755 })
    chmodSync(configured, 0o755)

    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: { plur: { command: configured, args: [] } },
    })

    let stdout = ''
    try {
      stdout = execSync(`node ${CLI} doctor --json`, {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_DISABLE_EMBEDDINGS: '1' },
        cwd: home,
      })
    } catch (err: any) {
      stdout = err.stdout?.toString() ?? ''
    }
    const report = JSON.parse(stdout)

    // The whole point: what got launched.
    expect(report.handshake.command, 'must launch the configured server').toContain(configured)
    expect(report.handshake.command, 'must NOT fall back to the recommended shim').not.toContain(shim)
    expect(report.handshake.probed, 'the report must name the source').toBeTruthy()
  }, 40000)

  it('fails overall when the live handshake is enabled and the server never completes initialize', () => {
    // doctor probes the entry the CONFIG declares (#764), so pointing
    // mcpServers.plur at this fake script is what makes the handshake spawn it.
    // Before #764 the probe was synthesised — it preferred the ~/.plur/bin
    // shim, then npx — which meant this test passed for the wrong reason: it
    // was exercising a launch path the config did not name.
    const binDir = join(home, '.plur', 'bin')
    mkdirSync(binDir, { recursive: true })
    const shim = join(binDir, 'plur-mcp')
    // Starts, waits long enough for doctor to write its init request (no EPIPE),
    // then exits without ever responding → handshake resolves ok:false fast.
    writeFileSync(shim, '#!/bin/sh\nsleep 0.5\nexit 0\n', { mode: 0o755 })
    chmodSync(shim, 0o755)

    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: shim, args: [] },
      },
    })

    let stdout = ''
    let status = 0
    try {
      stdout = execSync(`node ${CLI} doctor --json`, {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_DISABLE_EMBEDDINGS: '1' },
        cwd: home,
      })
    } catch (err: any) {
      stdout = err.stdout?.toString() ?? ''
      status = err.status ?? 1
    }
    const report = JSON.parse(stdout)

    // hooks + MCP are both wired, so the handshake is the ONLY reason to fail.
    expect(report.hooksInstalled).toBe(true)
    expect(report.mcpRegistered).toBe(true)
    expect(report.handshake.ok).toBe(false)
    expect(report.handshake.error).toBeTruthy()
    expect(report.handshake.error).not.toContain('skipped') // it actually ran
    // #764: the report must name what it launched, and it must be the
    // configured command — not a synthesised npx fallback that would have
    // reported healthy while the configured server was dead.
    expect(report.handshake.command).toContain(shim)
    expect(report.handshake.probed).toBeTruthy()
    expect(report.overall).toBe('fail')
    expect(status).toBe(1)
  }, 40000)

  // ── Stale npx hook detection (#178) ─────────────────────────────────────

  it('detects stale npx hooks and recommends migration (#178)', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.staleNpxHooks).toBe(true)
    expect(report.hooksInstalled).toBe(true)
  })

  it('reports hookShim.valid=false when shim does not exist (#178)', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `${join(home, '.plur', 'bin', 'plur-hook')} hook-inject` }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.hookShim).toBeDefined()
    expect(report.hookShim.valid).toBe(false)
  })

  it('reports staleNpxHooks=false with new-style shim hooks (#178)', () => {
    // Create a valid shim pointing to the real CLI dist
    const cliDist = join(__dirname, '..', 'dist', 'index.js')
    const binDir = join(home, '.plur', 'bin')
    mkdirSync(binDir, { recursive: true })
    const shimPath = join(binDir, 'plur-hook')
    writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${cliDist}" "$@"\n`, { mode: 0o755 })
    try { chmodSync(shimPath, 0o755) } catch {}

    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `${shimPath} hook-inject` }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.staleNpxHooks).toBe(false)
    expect(report.hooksInstalled).toBe(true)
    expect(report.hookShim.valid).toBe(true)
  })

  // ─── #234 — stale npx-based MCP entry detection ──────────────────────────

  it('detects stale npx-based MCP server entry and recommends migration (#234)', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `${join(home, '.plur', 'bin', 'plur-hook')} hook-inject` }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.staleNpxMcp).toBe(true)
    expect(report.mcpRegistered).toBe(true)
  })

  it('reports staleNpxMcp=false when MCP entry uses local shim (#234)', () => {
    const binDir = join(home, '.plur', 'bin')
    mkdirSync(binDir, { recursive: true })
    const mcpShim = join(binDir, 'plur-mcp')
    // Point at a real JS file so validateMcpShim's existsSync passes
    const fakeMcpDist = join(home, 'fake-mcp', 'index.js')
    mkdirSync(join(home, 'fake-mcp'), { recursive: true })
    writeFileSync(fakeMcpDist, '// fake mcp')
    writeFileSync(mcpShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeMcpDist}" "$@"\n`, { mode: 0o755 })
    try { chmodSync(mcpShim, 0o755) } catch {}

    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: `${join(binDir, 'plur-hook')} hook-inject` }] },
        ],
      },
      mcpServers: {
        plur: { command: mcpShim, args: [] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.staleNpxMcp).toBe(false)
    expect(report.mcpRegistered).toBe(true)
    expect(report.mcpShim.valid).toBe(true)
  })

  it('reports mcpShim.valid=false when shim missing (#234)', () => {
    writeGlobalSettings({
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.mcpShim).toBeDefined()
    expect(report.mcpShim.valid).toBe(false)
    expect(report.mcpShim.error).toMatch(/shim not found|plur init/)
  })

  // ── Cursor-specific health, not covered by Claude Code config elsewhere ──
  // Audit fix (Codex adversarial review, 2026-07-08): `overall` used to be
  // computed purely from `configs.some(...)` across ALL config files, so a
  // fully-working Claude Code setup made `overall: 'ok'` even when this
  // project's own `.cursor/` wiring was missing or incomplete.

  it('fails overall when a .cursor/ project has incomplete Cursor config, even with Claude Code fully wired', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })
    // .cursor/ exists (this IS a Cursor project) but neither config file
    // inside it has been written yet — plur init --cursor was never run here.
    mkdirSync(join(home, '.cursor'), { recursive: true })

    const { stdout, status } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.hooksInstalled).toBe(true)
    expect(report.mcpRegistered).toBe(true)
    expect(report.cursorProjectDetected).toBe(true)
    expect(report.cursorWired).toBe(false)
    expect(report.overall).toBe('fail')
    expect(status).toBe(1)
  })

  it('reports overall ok when a .cursor/ project has its own config fully wired', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [], env: { PLUR_TOOL_PROFILE: 'cursor' } } } }),
    )
    writeFileSync(
      join(home, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: 'plur-hook hook-cursor-session-start' }] },
      }),
    )

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.cursorProjectDetected).toBe(true)
    expect(report.cursorWired).toBe(true)
    expect(report.overall).toBe('ok')
  })

  // Audit fix (evaluator review, 2026-07-08): cursorWired used to only
  // check that a `plur` entry existed, not that its env actually carried
  // the cursor tool profile — an entry missing/wrong here silently gets
  // the full 39-tool surface instead of the ~11-tool one.
  it('reports cursorWired=false when .cursor/mcp.json has a plur entry missing PLUR_TOOL_PROFILE=cursor', () => {
    writeGlobalSettings({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] }] },
      mcpServers: { plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] } },
    })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }), // no env at all
    )
    writeFileSync(
      join(home, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'plur-hook hook-cursor-session-start' }] } }),
    )

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.cursorWired).toBe(false)
    expect(report.overall).toBe('fail')
  })

  // Audit fix (evaluator review, 2026-07-08): `.cursor/mcp.json` is meant to
  // be committed so teammates/background agents inherit it, but the local
  // shim path `plur init --cursor` bakes in is machine-specific — healthy
  // on the machine that ran init, potentially nonexistent anywhere else.
  // cursorWired must catch that instead of reporting healthy on a config
  // that will ENOENT the moment Cursor actually tries to spawn it.
  it('reports cursorWired=false when the absolute shim command does not exist on this machine', () => {
    writeGlobalSettings({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] }] },
      mcpServers: { plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] } },
    })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          plur: {
            command: '/Users/someone-elses-machine/.plur/bin/plur-mcp',
            args: [],
            env: { PLUR_TOOL_PROFILE: 'cursor' },
          },
        },
      }),
    )
    writeFileSync(
      join(home, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'plur-hook hook-cursor-session-start' }] } }),
    )

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.cursorWired).toBe(false)
    expect(report.overall).toBe('fail')
  })

  // Audit fix (evaluator review, iteration 3, 2026-07-09): existsSync alone
  // reports true for a file stripped of its execute bit (interrupted
  // install, botched reinstall, AV quarantine placeholder) — the command
  // would still fail to spawn. cursorWired must catch this too, not just
  // "path missing entirely".
  it('reports cursorWired=false when the shim command exists but is not executable', () => {
    writeGlobalSettings({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] }] },
      mcpServers: { plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] } },
    })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    const binDir = join(home, '.plur', 'bin')
    mkdirSync(binDir, { recursive: true })
    const shimPath = join(binDir, 'plur-mcp')
    writeFileSync(shimPath, '#!/bin/sh\necho not actually executable\n')
    chmodSync(shimPath, 0o644) // no execute bit
    writeFileSync(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: shimPath, args: [], env: { PLUR_TOOL_PROFILE: 'cursor' } } } }),
    )
    writeFileSync(
      join(home, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'plur-hook hook-cursor-session-start' }] } }),
    )

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.cursorWired).toBe(false)
    expect(report.overall).toBe('fail')
  })

  it('does not require Cursor wiring when no .cursor/ directory exists', () => {
    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.cursorProjectDetected).toBe(false)
    expect(report.overall).toBe('ok')
  })

  // ── Stale content_hash detection (#911) ──────────────────────────────────
  // Advisory only: a stale hash does not fail overall, but doctor must report
  // the count so users know to run `plur reindex-hashes --apply`.

  it('reports staleContentHashes=0 when the store has no engrams', () => {
    const { stdout } = runDoctor()
    const report = JSON.parse(stdout)

    expect(report.staleContentHashes).toBe(0)
  })

  it('reports staleContentHashes > 0 and does not fail overall when engrams have stale hashes (#911)', () => {
    // Write an engrams.yaml directly into the tmp home dir, which doctor
    // loads via PLUR_PATH. The content_hash is deliberately wrong — a hash
    // of "" (the pre-#896 SHA-256 of the empty string after ASCII-only
    // normalizeStatement stripped all non-Latin characters), while the
    // statement is plain ASCII and would compute a different hash.
    const plurDir = join(home, '.plur')
    mkdirSync(plurDir, { recursive: true })
    const staleHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // SHA-256("")
    // Minimum valid engram: id, status, type, scope, statement — all fields
    // without defaults that the Zod schema requires. activation uses its
    // schema default. content_hash is optional but present here and stale.
    writeFileSync(join(plurDir, 'engrams.yaml'), [
      'engrams:',
      '  - id: ENG-2026-0101-001',
      '    status: active',
      '    type: behavioral',
      '    scope: global',
      '    statement: "this is a perfectly valid ASCII statement"',
      `    content_hash: "${staleHash}"`,
    ].join('\n'))

    writeGlobalSettings({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject' }] },
        ],
      },
      mcpServers: {
        plur: { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'] },
      },
    })

    const stdout = (() => {
      try {
        return execSync(`node ${CLI} doctor --no-handshake --json`, {
          encoding: 'utf-8', timeout: 15000,
          env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: plurDir, PLUR_DOCTOR_TIMEOUT: '2' },
          cwd: home,
        })
      } catch (err: any) { return err.stdout?.toString() ?? '' }
    })()
    const report = JSON.parse(stdout)

    expect(report.staleContentHashes).toBeGreaterThan(0)
    // Advisory only — must not drive overall to fail on its own.
    expect(report.overall).toBe('ok')
  })

  // ── PGLite orphan detection — config.yaml route (#1061) ─────────────────

  it('pgliteOrphanDetected=false when config.yaml selects pglite (#1061)', () => {
    // Red case (before the fix): doctor only checked PLUR_BACKEND, so a
    // config.yaml-selected pglite store was wrongly reported as orphaned.
    mkdirSync(join(home, '.plur', 'store.pglite'), { recursive: true })
    writeFileSync(join(home, '.plur', 'config.yaml'), 'backend: pglite\n')

    let stdout = ''
    try {
      stdout = execSync(`node ${CLI} doctor --no-handshake --json`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PLUR_PATH: join(home, '.plur'),
          PLUR_DISABLE_EMBEDDINGS: '1',
          // Explicitly unset PLUR_BACKEND — the fix must work via config alone.
          PLUR_BACKEND: '',
        },
        cwd: home,
      })
    } catch (err: any) { stdout = err.stdout?.toString() ?? '' }

    const report = JSON.parse(stdout)
    expect(report.pgliteOrphanDetected).toBe(false)
    // Advisory must never drive overall to fail.
    expect(report.overall).toBe('fail') // empty env → hooks/MCP missing
  })

  it('pgliteOrphanDetected=true when store.pglite exists and pglite not selected (#1061)', () => {
    // Contrasting case: store.pglite exists but no backend selection → orphan.
    mkdirSync(join(home, '.plur', 'store.pglite'), { recursive: true })

    let stdout = ''
    try {
      stdout = execSync(`node ${CLI} doctor --no-handshake --json`, {
        encoding: 'utf-8',
        timeout: 15000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PLUR_PATH: join(home, '.plur'),
          PLUR_DISABLE_EMBEDDINGS: '1',
          PLUR_BACKEND: '',
        },
        cwd: home,
      })
    } catch (err: any) { stdout = err.stdout?.toString() ?? '' }

    const report = JSON.parse(stdout)
    expect(report.pgliteOrphanDetected).toBe(true)
    expect(report.overall).toBe('fail') // advisory must not drive overall
  })
})
