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

  // Reviewer-caught bug: a top-level array is syntactically valid JSON, so
  // `JSON.parse` succeeds — but `cfg.plugin = ...` / `cfg.mcp.plur = ...` land
  // as non-index properties on an Array, which `JSON.stringify` silently
  // drops. Before the isPlainObject guard, that made `changed` compute
  // `false` (the serialized array never visibly differs) with `ok: true` —
  // a false success: PLUR was never written and nothing told the user.
  it('refuses a top-level-array config — reports PLUR as NOT installed, leaves the file untouched', () => {
    const p = join(dir, 'opencode.json')
    const original = '[1,2,3]'
    writeFileSync(p, original)
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(original)
  })

  // Same silent-loss shape one level down: a PRESENT `plugin` that isn't an
  // array used to be silently replaced with a fresh `[]` (`Array.isArray(cfg
  // .plugin) ? cfg.plugin : []`), discarding whatever the user had there and
  // then happily reporting success. Refuse instead.
  it('refuses a config whose plugin field is not an array, rather than silently discarding it', () => {
    const p = join(dir, 'opencode.json')
    const original = JSON.stringify({ plugin: 'oops-not-an-array' })
    writeFileSync(p, original)
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(original)
  })

  // Same class again for `mcp`: a PRESENT `mcp` that is itself an array
  // would swallow `mcp.plur = ...` the identical way the top-level array
  // case swallowed `plugin`/`mcp` — but here `plugin` (absent) still gets
  // added normally, so `changed` computes `true` and the file WOULD get
  // written with the `plur` entry silently missing from `mcp`. Refuse
  // instead of shipping that partial, half-silent write.
  it('refuses a config whose mcp field is not a plain object, rather than silently losing the plur entry inside it', () => {
    const p = join(dir, 'opencode.json')
    const original = JSON.stringify({ mcp: [] })
    writeFileSync(p, original)
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(original)
  })

  it('creates the parent directory when it does not exist yet', () => {
    const p = join(dir, 'nested', 'opencode.json')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.created).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).plugin).toContain('@plur-ai/opencode')
  })
})
