import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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
})
