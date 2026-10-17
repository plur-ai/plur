import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpencodeConfig, opencodeMcpLaunch } from '../src/opencode-config.js'

let fakeHome: string
let cfg: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'plur-oc-1637-'))
  cfg = join(fakeHome, 'opencode.json')
  vi.stubEnv('HOME', fakeHome)
  vi.stubEnv('USERPROFILE', fakeHome)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(fakeHome, { recursive: true, force: true })
})

function installShim(home: string): void {
  mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
  writeFileSync(join(home, '.plur', 'bin', 'plur-mcp'), '#!/bin/sh\nexec node "$@"\n')
  // No plur-mcp.meta.json — findMcpJsEntry returns null, only the shim exists
}

it.skipIf(process.platform === 'win32')('macOS/Linux with only the shim installed: OpenCode launches the shim, not npx', () => {
  installShim(fakeHome)
  expect(opencodeMcpLaunch('0.22.0')).toEqual({ command: [join(fakeHome, '.plur/bin/plur-mcp')], local: true })
})

it.skipIf(process.platform === 'win32')('a PLUR-written npx entry is repaired to the shim, environment kept', () => {
  installShim(fakeHome)
  writeFileSync(cfg, JSON.stringify({
    mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp@0.19.4'], environment: { HTTPS_PROXY: 'http://proxy.example.com:8080' }, enabled: true } },
  }))
  const r = writeOpencodeConfig(cfg, '0.22.0')
  expect(r).toMatchObject({ mcpPlurUpgraded: true, mcpPlurLocal: true })
  expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp.plur).toEqual({
    type: 'local',
    command: [join(fakeHome, '.plur/bin/plur-mcp')],
    environment: { HTTPS_PROXY: 'http://proxy.example.com:8080' },
    enabled: true,
  })
})

it('nothing installed: npx fallback, mcpPlurLocal false', () => {
  const r = writeOpencodeConfig(cfg, '0.22.0')
  expect(r.created).toBe(true)
  expect(r.mcpPlurLocal).toBe(false)
})

it("a user's own npx entry (unpinned or other package) is left alone", () => {
  writeFileSync(cfg, JSON.stringify({
    mcp: { plur: { type: 'local', command: ['npx', '-y', '@plur-ai/mcp'], enabled: true } },
  }))
  const r = writeOpencodeConfig(cfg, '0.22.0')
  expect(r.mcpPlurPreserved).toBe(true)
  expect(JSON.parse(readFileSync(cfg, 'utf8')).mcp.plur.command).toEqual(['npx', '-y', '@plur-ai/mcp'])
})

it.skipIf(process.platform === 'win32')('re-running init over the shim entry it wrote still reports mcpPlurLocal', () => {
  installShim(fakeHome)
  expect(writeOpencodeConfig(cfg, '0.22.0')).toMatchObject({ created: true, mcpPlurLocal: true })
  const again = writeOpencodeConfig(cfg, '0.22.0')
  expect(again).toMatchObject({ changed: false, mcpPlurPreserved: true, mcpPlurLocal: true })
})

it("a user's own entry that happens to be preserved is not reported as local", () => {
  writeFileSync(cfg, JSON.stringify({
    mcp: { plur: { type: 'local', command: ['/opt/acme/bin/plur-mcp'], enabled: true } },
  }))
  expect(writeOpencodeConfig(cfg, '0.22.0')).toMatchObject({ mcpPlurPreserved: true, mcpPlurLocal: false })
})
