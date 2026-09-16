import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, lstatSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeOpencodeConfig, readOpencodeConfig } from '../src/opencode-config.js'

// Skip when running as root: chmod-based permission denial doesn't apply to
// root, so the EACCES this suite relies on to prove non-truncation never
// fires (some CI containers run as root). Same guard as
// packages/core/test/pr3-config-robustness.test.ts.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
const itNotRoot = asRoot ? it.skip : it

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

  it('treats an explicit null plugin/mcp as unset, not malformed', () => {
    const p = join(dir, 'opencode.json')
    writeFileSync(p, JSON.stringify({ plugin: null, mcp: null }))
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.ok).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.plugin).toEqual(['@plur-ai/opencode'])
    expect(cfg.mcp.plur.type).toBe('local')
  })

  it('creates the parent directory when it does not exist yet', () => {
    const p = join(dir, 'nested', 'opencode.json')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.created).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8')).plugin).toContain('@plur-ai/opencode')
  })

  // B2 (0.20.0 audit): mcp.plur used to be assigned flat with no check on
  // what was already there. The damaging case: a user who pointed PLUR at a
  // non-default store via environment.PLUR_PATH — overwriting it silently
  // rerouted their plur_learn calls to ~/.plur with nothing telling them.
  describe('preserves an existing mcp.plur entry (B2)', () => {
    it('leaves a custom local entry with environment.PLUR_PATH completely untouched', () => {
      const p = join(dir, 'opencode.json')
      const customEntry = {
        type: 'local',
        command: ['some-other-launcher'],
        enabled: true,
        environment: { PLUR_PATH: '/Volumes/vault/plur' },
      }
      writeFileSync(p, JSON.stringify({ mcp: { plur: customEntry } }))
      const r = writeOpencodeConfig(p, '0.20.0')
      expect(r.ok).toBe(true)
      expect(r.mcpPlurPreserved).toBe(true)
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      // Untouched byte-for-byte, in particular the PLUR_PATH override.
      expect(cfg.mcp.plur).toEqual(customEntry)
      // The plugin layer is independent of mcp.plur and still gets added.
      expect(cfg.plugin).toContain('@plur-ai/opencode')
    })

    it('leaves an enterprise remote entry (url + bearer headers) completely untouched', () => {
      const p = join(dir, 'opencode.json')
      const remoteEntry = {
        type: 'remote',
        url: 'https://plur.internal.acme.com/mcp',
        headers: { Authorization: 'Bearer super-secret-token' },
        enabled: true,
      }
      writeFileSync(p, JSON.stringify({ mcp: { plur: remoteEntry } }))
      const r = writeOpencodeConfig(p, '0.20.0')
      expect(r.ok).toBe(true)
      expect(r.mcpPlurPreserved).toBe(true)
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      expect(cfg.mcp.plur).toEqual(remoteEntry)
      // doctor's read-only reflection agrees: mcp.plur is declared, and it
      // is not PLUR's own local entry (doctor never inspects the shape
      // further than "present") — it must not itself flag this as broken.
      expect(readOpencodeConfig(p).mcpPlurDeclared).toBe(true)
      expect(readOpencodeConfig(p).ok).toBe(true)
    })

    it('still writes mcp.plur when none existed before (mcpPlurPreserved: false)', () => {
      const p = join(dir, 'opencode.json')
      const r = writeOpencodeConfig(p, '0.20.0')
      expect(r.mcpPlurPreserved).toBe(false)
      expect(JSON.parse(readFileSync(p, 'utf8')).mcp.plur.type).toBe('local')
    })

    it('treats an explicit mcp.plur: null the same as absent — writes PLUR\'s entry', () => {
      const p = join(dir, 'opencode.json')
      writeFileSync(p, JSON.stringify({ mcp: { plur: null } }))
      const r = writeOpencodeConfig(p, '0.20.0')
      expect(r.mcpPlurPreserved).toBe(false)
      expect(JSON.parse(readFileSync(p, 'utf8')).mcp.plur.type).toBe('local')
    })
  })

  // B3 (0.20.0 audit): writeFileSync opens with O_TRUNC, destroying the
  // existing config before a single byte of the new content lands. A crash,
  // OOM, full disk, or suspend in that window loses a config that can carry
  // 40+ MCP server entries. writeOpencodeConfig now routes through
  // @plur-ai/core's atomicWrite (tmp file -> fsync -> rename) instead.
  describe('atomic, symlink-safe writes (B3)', () => {
    itNotRoot('never truncates the destination when the write fails partway', () => {
      const p = join(dir, 'opencode.json')
      const original = JSON.stringify({ model: 'keep-me', mcp: { other: { type: 'local' } } })
      writeFileSync(p, original)
      // Make the directory read-only so atomicWrite's tmp-file CREATE fails
      // before anything touches the real destination — a stand-in for a
      // write that fails partway (disk full, permissions, etc).
      chmodSync(dir, 0o500)
      try {
        expect(() => writeOpencodeConfig(p, '0.20.0')).toThrow()
      } finally {
        chmodSync(dir, 0o700)
      }
      // A plain O_TRUNC write (the old writeFileSync behavior) would have
      // already zeroed the destination before the failure could even occur;
      // atomicWrite writes to a tmp file first, so a failed write never
      // touches the real file.
      expect(readFileSync(p, 'utf8')).toBe(original)
    })

    it('writes through a symlinked config file rather than replacing the symlink', () => {
      const real = join(dir, 'real-opencode.json')
      writeFileSync(real, JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' }))
      const link = join(dir, 'opencode.json')
      symlinkSync(real, link)

      const r = writeOpencodeConfig(link, '0.20.0')
      expect(r.ok).toBe(true)
      expect(r.created).toBe(false)

      // The path PLUR was told to write to is STILL a symlink...
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      // ...pointing at the same real file, which now carries PLUR's config
      // alongside what was already there.
      const cfg = JSON.parse(readFileSync(real, 'utf8'))
      expect(cfg.model).toBe('anthropic/claude-sonnet-4-5')
      expect(cfg.plugin).toContain('@plur-ai/opencode')
      expect(cfg.mcp.plur.type).toBe('local')
      // Reading through the symlink sees the identical content either way.
      expect(readFileSync(link, 'utf8')).toBe(readFileSync(real, 'utf8'))
    })
  })
})
