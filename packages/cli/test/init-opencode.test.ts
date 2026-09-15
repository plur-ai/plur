import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeOpencodeConfig } from '../src/opencode-config.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-oc-')) })

describe('writeOpencodeConfig', () => {
  it('creates a config with both the plugin and the mcp entry', () => {
    const p = join(dir, 'opencode.json')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.created).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.plugin).toContain('@plur-ai/opencode')
    expect(cfg.mcp.plur.type).toBe('local')
    expect(cfg.mcp.plur.command).toEqual(['npx', '-y', '@plur-ai/mcp@0.20.0'])
  })

  it('preserves unrelated keys in an existing config', () => {
    const p = join(dir, 'opencode.json')
    writeFileSync(p, JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', plugin: ['other'] }))
    writeOpencodeConfig(p, '0.20.0')
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.model).toBe('anthropic/claude-sonnet-4-5')
    expect(cfg.plugin).toEqual(['other', '@plur-ai/opencode'])
  })

  it('is idempotent — a second run changes nothing', () => {
    const p = join(dir, 'opencode.json')
    writeOpencodeConfig(p, '0.20.0')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.changed).toBe(false)
    expect(JSON.parse(readFileSync(p, 'utf8')).plugin).toEqual(['@plur-ai/opencode'])
  })

  it('fails safe on a JSONC file with comments — reports, does not corrupt or discard it', () => {
    const p = join(dir, 'opencode.jsonc')
    const original = '{\n  // keep this comment\n  "model": "anthropic/claude-sonnet-4-5"\n}\n'
    writeFileSync(p, original)
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    // The file on disk is untouched byte-for-byte — no silent {} clobber.
    expect(readFileSync(p, 'utf8')).toBe(original)
  })
})
