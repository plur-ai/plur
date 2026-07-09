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
})
