/**
 * #1832 — `plur-mcp init` follows a global upgrade like `plur init`:
 *
 *   - it registers the installed MCP server (`~/.plur/bin/plur-mcp`, which
 *     `plur init` writes) when it exists, so a global upgrade reaches the
 *     config at the same path without a re-pin;
 *   - otherwise `npx -y @plur-ai/mcp@<this version>` — never `@latest`
 *     (#1069) — and an older pin it wrote earlier moves to this version;
 *   - a newer pin, a fork and a custom command stay;
 *   - its npx hook fallback is pinned too (a bare `npx @plur-ai/cli` is the
 *     #1069 shape).
 *
 * Real spawned `plur-mcp init` against a temp HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { VERSION } from '../src/version.js'

const MCP = join(__dirname, '..', 'dist', 'index.js')

let home: string
let work: string

const userConfig = () => join(home, '.claude.json')
const plurEntry = () => JSON.parse(readFileSync(userConfig(), 'utf8')).mcpServers.plur

function init(): string {
  const r = spawnSync('node', [MCP, 'init'], {
    encoding: 'utf-8', cwd: work, timeout: 120_000, input: '',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'),
      XDG_CONFIG_HOME: join(home, '.config'), PLUR_PATH: join(home, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1', PLUR_TELEMETRY: '', PLUR_BACKEND: '',
    },
  })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout ?? ''
}

function seed(plur: Record<string, unknown>): void {
  writeFileSync(userConfig(), JSON.stringify({ mcpServers: { plur } }), { mode: 0o600 })
}

function installShim(): string {
  mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  const shim = join(home, '.plur', 'bin', 'plur-mcp')
  writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return shim
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-1832-')))
  mkdirSync(join(home, 'tmp'))
  work = join(home, 'work')
  mkdirSync(work, { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('plur-mcp init follows a global upgrade (#1832)', { timeout: 300_000 }, () => {
  it('no installed server: a fresh entry is the pinned npx, and the hooks fallback is pinned', () => {
    init()
    expect(plurEntry()).toEqual({ command: 'npx', args: ['-y', `@plur-ai/mcp@${VERSION}`] })
    const hooks = readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
    expect(hooks).toContain(`npx -y @plur-ai/cli@${VERSION} hook-`)
    expect(hooks).not.toMatch(/npx @plur-ai\/cli hook-/)
  })

  it('the installed server (shim) is registered when it exists', () => {
    const shim = installShim()
    init()
    expect(plurEntry()).toEqual({ command: shim, args: [] })
  })

  it('an older pin is re-pinned to this version, env kept', () => {
    seed({ command: 'npx', args: ['-y', '@plur-ai/mcp@0.0.1'], env: { PLUR_PATH: '/custom' } })
    const out = init()
    expect(plurEntry()).toEqual({ command: 'npx', args: ['-y', `@plur-ai/mcp@${VERSION}`], env: { PLUR_PATH: '/custom' } })
    expect(out).toContain(`updated the npx pin 0.0.1 → ${VERSION}`)
  })

  it('an older pin becomes the installed server when there is one', () => {
    const shim = installShim()
    seed({ command: 'npx', args: ['-y', '@plur-ai/mcp@0.0.1'] })
    init()
    expect(plurEntry()).toEqual({ command: shim, args: [] })
  })

  it('a newer pin, a fork and a custom command stay', () => {
    for (const plur of [
      { command: 'npx', args: ['-y', '@plur-ai/mcp@999.0.0'] },
      { command: 'npx', args: ['-y', '@plur-ai/mcp-experimental@0.0.1'] },
      { command: '/opt/my-plur', args: [] },
    ]) {
      seed(plur)
      init()
      expect(plurEntry()).toEqual(plur)
    }
  })

  it('@latest is still healed (#1069)', () => {
    seed({ command: 'npx', args: ['-y', '@plur-ai/mcp@latest'] })
    init()
    expect(plurEntry()).toEqual({ command: 'npx', args: ['-y', `@plur-ai/mcp@${VERSION}`] })
  })
})
