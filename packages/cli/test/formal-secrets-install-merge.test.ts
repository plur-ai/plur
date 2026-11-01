/**
 * Adding the plur MCP entry is idempotent, and `plur init --antigravity`
 * writes only into ~/.gemini/config, never into Antigravity's runtime state
 * folder ~/.gemini/antigravity-cli.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { mergePlurMcp, agyConfigDir, agyHooksConfigPath, agyMcpConfigPath } from '../src/mcp-config.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

let home: string
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-merge-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
})

describe('mergePlurMcp', () => {
  it('a second merge changes nothing and reports no change', () => {
    const config: Record<string, unknown> = { mcpServers: { github: { command: 'npx', args: ['gh'] } }, other: 1 }
    expect(mergePlurMcp(config)).toBe(true)
    const after1 = JSON.stringify(config)
    expect(mergePlurMcp(config)).toBe(false)
    expect(JSON.stringify(config)).toBe(after1)
  })

  it('an existing plur entry is left exactly as it is', () => {
    const mine = { command: '/opt/custom/plur', args: ['--x'], env: { A: '1' } }
    const config: Record<string, unknown> = { mcpServers: { plur: mine } }
    expect(mergePlurMcp(config, { env: { B: '2' } })).toBe(false)
    expect((config.mcpServers as Record<string, unknown>).plur).toEqual({ command: '/opt/custom/plur', args: ['--x'], env: { A: '1' } })
  })
})

describe('Antigravity paths', () => {
  const runtime = () => join(home, '.gemini', 'antigravity-cli')
  it('no Antigravity config path is under the runtime state folder', () => {
    for (const p of [agyConfigDir(), agyHooksConfigPath(), agyMcpConfigPath()]) {
      expect((p + sep).startsWith(runtime() + sep)).toBe(false)
      expect(p.startsWith(join(home, '.gemini', 'config'))).toBe(true)
    }
  })

  it('plur init --antigravity, run twice, writes nothing under antigravity-cli and leaves mcp_config.json unchanged the second time', () => {
    const CLI = builtCliPath(join(__dirname, '..'))
    const run = () => execSync(`node ${CLI} init --antigravity --no-prompt --no-cursor --no-desktop`, {
      encoding: 'utf-8', timeout: 30000, cwd: home,
      env: { ...isolatedHomeEnv(home), PLUR_PATH: join(home, '.plur') },
    })
    run()
    const mcpPath = join(home, '.gemini', 'config', 'mcp_config.json')
    const first = readFileSync(mcpPath, 'utf8')
    expect(JSON.parse(first).mcpServers.plur).toBeDefined()
    run()
    expect(readFileSync(mcpPath, 'utf8')).toBe(first)
    expect(existsSync(runtime())).toBe(false)
  }, 60000)
})
