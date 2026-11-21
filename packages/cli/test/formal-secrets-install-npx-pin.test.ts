/**
 * The npx fallback MCP entry pins this CLI's own version and never @latest.
 * A version that is not release-shaped cannot be pinned safely (it reaches a
 * /bin/sh -lc string), so the entry is refused rather than written as @latest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ version: '1.2.3' }))
vi.mock('../src/version.js', () => ({ get CLI_VERSION() { return state.version } }))

import { buildMcpServerEntry } from '../src/mcp-config.js'

const realPlatform = process.platform
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-npx-pin-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
  state.version = '1.2.3'
})

describe('npx fallback version pin', () => {
  it('pins a release-shaped version on every platform', () => {
    for (const p of ['linux', 'darwin', 'win32'] as const) {
      Object.defineProperty(process, 'platform', { value: p })
      const e = buildMcpServerEntry()
      expect([e.command, ...(e.args ?? [])].join(' ')).toContain('@plur-ai/mcp@1.2.3')
    }
  })

  it('never writes @latest: a version that is not release-shaped is refused', () => {
    for (const bad of ['', 'dev', '1.2', '1.2.3; rm -rf ~', 'latest']) {
      state.version = bad
      for (const p of ['linux', 'win32'] as const) {
        Object.defineProperty(process, 'platform', { value: p })
        let entry: unknown = null
        try { entry = buildMcpServerEntry() } catch { entry = 'refused' }
        expect(JSON.stringify(entry)).not.toContain('@latest')
        expect(entry).toBe('refused')
      }
    }
  })
})
