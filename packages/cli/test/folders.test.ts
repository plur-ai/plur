/**
 * `plur folders list|set|rm` and `plur trust`/`untrust` through the folder
 * map (#1347).
 *
 * Every spawn sets HOME, USERPROFILE, TMPDIR and PLUR_PATH to a temp dir, so
 * the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { issueFolderNonce, findPlurMarker, safeSessionKey as coreSafeSessionKey } from '@plur-ai/core'
import { isPlurConfigured } from '../src/lib/plur-configured.js'
import { safeSessionKey } from '../src/lib/session-key.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur folders (#1347)', () => {
  let dir: string
  let plurHome: string
  let target: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-folders-cli-')))
    mkdirSync(join(dir, 'tmp'))
    plurHome = join(dir, '.plur')
    target = join(dir, 'proj')
    mkdirSync(target)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function run(args: string[]): { status: number | null; out: any; stderr: string } {
    const r = runCli('node', [CLI, ...args, '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome },
      cwd: dir,
    })
    let out: any = null
    try { out = JSON.parse((r.stdout ?? '').trim()) } catch { /* not json */ }
    return { status: r.status, out, stderr: r.stderr ?? '' }
  }

  it('set / list / rm round-trip', () => {
    expect(run(['folders', 'list']).out).toEqual({ folders: [], count: 0 })
    const s = run(['folders', 'set', target, '--off'])
    expect(s.status).toBe(0)
    expect(s.out.entry).toEqual({ path: target, plur: 'off' })
    expect(run(['folders', 'list']).out.folders).toEqual([{ path: target, plur: 'off' }])
    expect(run(['folders', 'rm', target]).out).toEqual({ success: true, removed: true })
    expect(run(['folders', 'list']).out.count).toBe(0)
  }, 60_000)

  it('refuses a missing or stale nonce, and a nonce for a different folder', () => {
    const missing = run(['folders', 'set', target, '--on', '--nonce', 'deadbeef'])
    expect(missing.status).toBe(1)
    expect(missing.out.code).toBe('nonce-unknown')

    const other = join(dir, 'other')
    mkdirSync(other)
    const n = issueFolderNonce(plurHome, 'session-a', target)
    const wrong = run(['folders', 'set', other, '--on', '--nonce', n])
    expect(wrong.status).toBe(1)
    expect(wrong.out.code).toBe('nonce-folder')

    expect(run(['folders', 'set', target, '--on', '--nonce', n]).status).toBe(0)
    const reused = run(['folders', 'set', target, '--off', '--nonce', n])
    expect(reused.status).toBe(1)
    expect(reused.out.code).toBe('nonce-unknown')
    expect(run(['folders', 'list']).out.folders).toEqual([{ path: target, plur: 'on' }])
  }, 60_000)

  it('refuses a shared scope with no configured store', () => {
    const r = run(['folders', 'set', target, '--scope', 'group:example/eng'])
    expect(r.status).toBe(1)
    expect(r.out.code).toBe('scope-unconfigured')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
  }, 60_000)

  it('rejects conflicting or missing options', () => {
    expect(run(['folders', 'set', target, '--on', '--off']).status).toBe(1)
    expect(run(['folders', 'set', target]).status).toBe(1)
    expect(run(['folders', 'bogus']).status).toBe(1)
  }, 60_000)

  it('plur trust / untrust work through the map; a legacy trust.yaml is imported and left alone', () => {
    mkdirSync(plurHome, { recursive: true })
    const legacyDir = join(dir, 'legacy')
    mkdirSync(legacyDir)
    const trustYaml = `version: 1\ntrusted:\n  - ${legacyDir}\n`
    writeFileSync(join(plurHome, 'trust.yaml'), trustYaml)

    expect(run(['trust', '--list']).out).toEqual({ trusted: [legacyDir], count: 1 })
    const t = run(['trust', target])
    expect(t.out.success).toBe(true)
    expect(t.out.trusted).toBe(target)
    expect(run(['trust', '--list']).out.trusted).toEqual([legacyDir, target].sort())
    expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).toContain('trusted: true')

    // Subdirectory of a trusted folder: still covered, and untrust says so.
    const sub = join(target, 'sub')
    mkdirSync(sub)
    const u0 = run(['untrust', sub])
    expect(u0.out).toEqual({ success: true, removed: false, still_trusted: true, covering_ancestor: target })

    expect(run(['untrust', target]).out).toEqual({ success: true, removed: true })
    expect(run(['untrust', target]).out).toMatchObject({ removed: false, still_trusted: false })
    expect(readFileSync(join(plurHome, 'trust.yaml'), 'utf8')).toBe(trustYaml)
  }, 60_000)

  it('trust refuses (exit 1) rather than overwriting a malformed folders.yaml', () => {
    mkdirSync(plurHome, { recursive: true })
    writeFileSync(join(plurHome, 'folders.yaml'), 'folders: [[[')
    const r = run(['trust', target])
    expect(r.status).toBe(1)
    expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).toBe('folders: [[[')
  }, 60_000)
})

describe('core copies agree with the CLI originals (#1347)', () => {
  it('safeSessionKey', () => {
    for (const id of ['abc-123_X', '../../PWNED', '', 'a:b|c\u0000d', '550e8400-e29b-41d4-a716-446655440000']) {
      expect(coreSafeSessionKey(id)).toBe(safeSessionKey(id))
    }
  })

  it('findPlurMarker is non-null exactly when isPlurConfigured is true', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-marker-parity-')))
    try {
      const home = join(base, 'home')
      const cases: string[] = []
      const mk = (p: string) => { mkdirSync(p, { recursive: true }); cases.push(p); return p }
      mk(home)
      const plain = mk(join(home, 'plain', 'deep'))
      const yamlDir = mk(join(home, 'y'))
      writeFileSync(join(yamlDir, '.plur.yaml'), 'scope: project:y\n')
      mk(join(yamlDir, 'nested'))
      const mcp = mk(join(home, 'm'))
      writeFileSync(join(mcp, '.mcp.json'), JSON.stringify({ mcpServers: { plur: {} } }))
      const other = mk(join(home, 'o'))
      writeFileSync(join(other, '.mcp.json'), JSON.stringify({ mcpServers: { other: {} } }))
      const cl = mk(join(home, 'c', '.claude'))
      writeFileSync(join(cl, 'settings.local.json'), JSON.stringify({ mcpServers: { plur: {} } }))
      mk(join(home, 'c', 'x'))
      // Home's own settings only count when the walk starts at home.
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { plur: {} } }))
      void plain
      for (const c of cases) {
        expect(findPlurMarker(c, home) !== null, c).toBe(isPlurConfigured(c, home))
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
