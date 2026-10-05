/**
 * `plur folders list|set|rm` and `plur trust`/`untrust` through the folder
 * map (#1347).
 *
 * Every spawn sets HOME, USERPROFILE, TMPDIR and PLUR_PATH to a temp dir, so
 * the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { issueFolderNonce, findPlurMarker, safeSessionKey as coreSafeSessionKey } from '@plur-ai/core'
import { isPlurConfigured } from '../src/lib/plur-configured.js'
import { nonceRequired } from '../src/commands/folders.js'
import { spawnSync, spawn } from 'child_process'
import yaml from 'js-yaml'
import { safeSessionKey } from '../src/lib/session-key.js'

const CLI = builtCliPath(join(__dirname, '..'))
const hasPythonPty = process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf-8' }).status === 0

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

  // #1378: every nonce is bound to the one answer it authorises.
  const nonceFor = (folder: string, answer: Parameters<typeof issueFolderNonce>[3]) =>
    issueFolderNonce(plurHome, 'session-t', folder, answer)

  it('set / list / rm round-trip (non-interactive, so each write carries a nonce)', () => {
    expect(run(['folders', 'list']).out).toEqual({ folders: [], count: 0 })
    const s = run(['folders', 'set', target, '--off', '--nonce', nonceFor(target, { mode: 'off' })])
    expect(s.status).toBe(0)
    expect(s.out.entry).toEqual({ path: target, plur: 'off' })
    expect(run(['folders', 'list']).out.folders).toEqual([{ path: target, plur: 'off' }])
    expect(run(['folders', 'rm', target, '--nonce', nonceFor(target, { remove: true })]).out).toEqual({ success: true, removed: true })
    expect(run(['folders', 'list']).out.count).toBe(0)
  }, 60_000)

  it('outside a terminal, set and rm without --nonce are refused', () => {
    const set = run(['folders', 'set', target, '--on', '--trusted'])
    expect(set.status).toBe(1)
    expect(set.out.code).toBe('nonce-required')
    const rm = run(['folders', 'rm', target])
    expect(rm.status).toBe(1)
    expect(rm.out.code).toBe('nonce-required')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
    // Since #1378 plur trust has the same gate (tested below).
  }, 60_000)

  // A real pseudo-terminal (Python's pty module; script(1) needs a terminal
  // of its own on macOS): an interactive user needs no nonce.
  it.skipIf(!hasPythonPty)(
    'in an interactive terminal, set without --nonce is accepted',
    () => {
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
      const r = spawnSync('python3', [
        '-c', 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))',
        'node', CLI, 'folders', 'set', target, '--ask', '--json',
      ], { env, cwd: dir, encoding: 'utf-8', timeout: 60_000, input: '' })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).toContain('plur: ask')
    },
    60_000,
  )

  // Audit follow-up (adversarial L1, data-loss F6): writes are serialised.
  function runAsync(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise(res => {
      const child = spawn('node', [CLI, ...args, '--json'], {
        env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome },
        cwd: dir,
      })
      let stdout = ''
      child.stdout.on('data', c => { stdout += c })
      child.on('close', code => res({ code, stdout }))
    })
  }

  it('12 parallel folders set: every success is recorded', async () => {
    const dirs = Array.from({ length: 12 }, (_, i) => { const d = join(dir, `par-${i}`); mkdirSync(d); return d })
    const nonces = dirs.map(d => nonceFor(d, { mode: 'off' }))
    const results = await Promise.all(dirs.map((d, i) => runAsync(['folders', 'set', d, '--off', '--nonce', nonces[i]])))
    const ok = results.filter(r => r.code === 0).length
    const saved = (yaml.load(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')) as { folders: unknown[] }).folders.length
    expect(ok).toBe(12)
    expect(saved).toBe(ok)
  }, 120_000)

  it('8 parallel plur trust: every grant lands in both files', async () => {
    const dirs = Array.from({ length: 8 }, (_, i) => { const d = join(dir, `tpar-${i}`); mkdirSync(d); return d })
    const results = await Promise.all(dirs.map(d => runAsync(['trust', d, '--nonce', nonceFor(d, { trusted: true })])))
    expect(results.every(r => r.code === 0)).toBe(true)
    expect(run(['trust', '--list']).out.count).toBe(8)
    const legacy = yaml.load(readFileSync(join(plurHome, 'trust.yaml'), 'utf8')) as { trusted: string[] }
    expect(legacy.trusted.sort()).toEqual([...dirs].sort())
  }, 120_000)

  it.skipIf(!hasPythonPty)('the empty list (text mode, in a terminal) does not promise an ask that no hook makes yet', () => {
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
    const r = spawnSync('python3', [
      '-c', 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))',
      'node', CLI, 'folders', 'list',
    ], { env, cwd: dir, encoding: 'utf-8', timeout: 60_000, input: '' })
    expect(r.stdout).toContain('No folder decisions recorded.')
    expect(r.stdout).not.toMatch(/ask once per session/)
  }, 60_000)

  it('refuses a missing or stale nonce, and a nonce for a different folder', () => {
    const missing = run(['folders', 'set', target, '--on', '--nonce', 'deadbeef'])
    expect(missing.status).toBe(1)
    expect(missing.out.code).toBe('nonce-unknown')

    const other = join(dir, 'other')
    mkdirSync(other)
    const n = issueFolderNonce(plurHome, 'session-a', target, { mode: 'on' })
    const wrong = run(['folders', 'set', other, '--on', '--nonce', n])
    expect(wrong.status).toBe(1)
    expect(wrong.out.code).toBe('nonce-folder')

    expect(run(['folders', 'set', target, '--on', '--nonce', n]).status).toBe(0)
    const reused = run(['folders', 'set', target, '--on', '--nonce', n])
    expect(reused.status).toBe(1)
    expect(reused.out.code).toBe('nonce-unknown')
    expect(run(['folders', 'list']).out.folders).toEqual([{ path: target, plur: 'on' }])
  }, 60_000)

  it('refuses a team scope with no configured store; accepts a project scope', () => {
    const r = run(['folders', 'set', target, '--scope', 'group:example/eng', '--nonce', nonceFor(target, { scope: 'group:example/eng' })])
    expect(r.status).toBe(1)
    expect(r.out.code).toBe('scope-unconfigured')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
    const p = run(['folders', 'set', target, '--scope', 'project:app', '--nonce', nonceFor(target, { scope: 'project:app' })])
    expect(p.status).toBe(0)
    expect(p.out.entry.scope).toBe('project:app')
  }, 60_000)

  it('rejects conflicting or missing options', () => {
    expect(run(['folders', 'set', target, '--on', '--off']).status).toBe(1)
    expect(run(['folders', 'set', target]).status).toBe(1)
    expect(run(['folders', 'bogus']).status).toBe(1)
  }, 60_000)

  it('plur trust / untrust work through the map; a legacy trust.yaml is imported and kept in step', () => {
    mkdirSync(plurHome, { recursive: true })
    const legacyDir = join(dir, 'legacy')
    mkdirSync(legacyDir)
    const trustYaml = `version: 1\ntrusted:\n  - ${legacyDir}\n`
    writeFileSync(join(plurHome, 'trust.yaml'), trustYaml)

    expect(run(['trust', '--list']).out).toEqual({ trusted: [legacyDir], count: 1 })
    const t = run(['trust', target, '--nonce', nonceFor(target, { trusted: true })])
    expect(t.out.success).toBe(true)
    expect(t.out.trusted).toBe(target)
    expect(run(['trust', '--list']).out.trusted).toEqual([legacyDir, target].sort())
    expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).toContain('trusted: true')

    // Subdirectory of a trusted folder: still covered, and untrust says so.
    const sub = join(target, 'sub')
    mkdirSync(sub)
    const u0 = run(['untrust', sub, '--nonce', nonceFor(sub, { trusted: false })])
    expect(u0.out).toEqual({ success: true, removed: false, still_trusted: true, covering_ancestor: target })

    expect(run(['untrust', target, '--nonce', nonceFor(target, { trusted: false })]).out).toEqual({ success: true, removed: true })
    expect(run(['untrust', target, '--nonce', nonceFor(target, { trusted: false })]).out).toMatchObject({ removed: false, still_trusted: false })
    // Dual-write: the grant and revocation of target passed through trust.yaml; the legacy entry is untouched.
    expect(yaml.load(readFileSync(join(plurHome, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [legacyDir] })
  }, 60_000)

  it('trust refuses (exit 1) rather than overwriting a malformed folders.yaml', () => {
    mkdirSync(plurHome, { recursive: true })
    writeFileSync(join(plurHome, 'folders.yaml'), 'folders: [[[')
    const r = run(['trust', target, '--nonce', issueFolderNonce(plurHome, 'session-t', target, { trusted: true })])
    expect(r.status).toBe(1)
    expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).toBe('folders: [[[')
  }, 60_000)

  // #1378: the nonce is bound to the answer it was issued for.
  it('--trusted with a nonce issued for "yes, without its settings" fails and leaves folders.yaml byte-identical', () => {
    mkdirSync(plurHome, { recursive: true })
    const mapText = `version: 1\nfolders:\n  - path: ${target}\n    plur: ask\n`
    writeFileSync(join(plurHome, 'folders.yaml'), mapText)
    const before = readFileSync(join(plurHome, 'folders.yaml'))
    const withoutSettings = issueFolderNonce(plurHome, 'session-b', target, { mode: 'on' })
    for (const flagsFor of [['--trusted'], ['--on', '--trusted'], ['--off'], ['--scope', 'project:app']]) {
      const r = run(['folders', 'set', target, ...flagsFor, '--nonce', withoutSettings])
      expect(r.status, flagsFor.join(' ')).toBe(1)
      expect(r.out.code).toBe('nonce-answer')
    }
    expect(run(['folders', 'rm', target, '--nonce', withoutSettings]).out.code).toBe('nonce-answer')
    expect(run(['trust', target, '--nonce', withoutSettings]).out.code).toBe('nonce-answer')
    expect(readFileSync(join(plurHome, 'folders.yaml')).equals(before)).toBe(true)
    // The answer it was issued for still works.
    expect(run(['folders', 'set', target, '--on', '--nonce', withoutSettings]).status).toBe(0)
  }, 60_000)

  it('outside a terminal, plur trust needs a nonce bound to the grant; plur untrust needs none', () => {
    const t0 = run(['trust', target])
    expect(t0.status).toBe(1)
    expect(t0.out.code).toBe('nonce-required')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
    const wrongGrant = run(['trust', target, '--nonce', issueFolderNonce(plurHome, 'session-u', target, { mode: 'on' })])
    expect(wrongGrant.status).toBe(1)
    expect(wrongGrant.out.code).toBe('nonce-answer')

    const t = run(['trust', target, '--nonce', issueFolderNonce(plurHome, 'session-u', target, { trusted: true })])
    expect(t.status).toBe(0)
    expect(t.out).toEqual({ success: true, trusted: target })
    expect(run(['trust', '--list']).out.trusted).toEqual([target])
    expect(yaml.load(readFileSync(join(plurHome, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [target] })

    // #1477 review: a revocation only removes trust, so a script revokes with
    // no nonce and no terminal, in folders.yaml and in trust.yaml (dual-write).
    const u = run(['untrust', target])
    expect(u.status, u.stderr).toBe(0)
    expect(u.out).toEqual({ success: true, removed: true })
    expect(readFileSync(join(plurHome, 'folders.yaml'), 'utf8')).not.toContain('trusted: true')
    expect(yaml.load(readFileSync(join(plurHome, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [] })
    // Listing stays open: it writes nothing.
    expect(run(['trust', '--list']).out).toEqual({ trusted: [], count: 0 })

    // A --nonce given to untrust is accepted and ignored: it neither blocks the
    // revocation nor is consumed, so a grant nonce stays valid for its grant.
    const grant = issueFolderNonce(plurHome, 'session-u', target, { trusted: true })
    const t2 = run(['trust', target, '--nonce', issueFolderNonce(plurHome, 'session-u', target, { trusted: true })])
    expect(t2.status).toBe(0)
    const u2 = run(['untrust', target, '--nonce', grant])
    expect(u2.status, u2.stderr).toBe(0)
    expect(u2.out).toEqual({ success: true, removed: true })
    expect(run(['untrust', target, '--nonce', 'not-a-nonce']).status).toBe(0)
    expect(run(['trust', target, '--nonce', grant]).status).toBe(0)
  }, 60_000)

  // #1477 review: the nonce is checked against the folder the write records.
  // `~` expands to the home for the write, so it must for the check too.
  it('a quoted ~/<dir> is checked as the folder written: a nonce for another folder cannot reach $HOME/<dir>', () => {
    const other = join(dir, 'other')
    mkdirSync(other)
    const victim = join(dir, 'victim') // HOME is dir, so ~/victim is this
    mkdirSync(victim)
    // A cwd holding a literal "~" directory whose victim entry links to `other`.
    const cwd = join(dir, 'cwd')
    mkdirSync(join(cwd, '~'), { recursive: true })
    symlinkSync(other, join(cwd, '~', 'victim'))
    const runIn = (args: string[]) => {
      const r = runCli('node', [CLI, ...args, '--json'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome },
        cwd,
      })
      let out: any = null
      try { out = JSON.parse((r.stdout ?? '').trim()) } catch { /* not json */ }
      return { status: r.status, out }
    }
    const forOther = issueFolderNonce(plurHome, 'session-h', other, { trusted: true })
    const bad = runIn(['folders', 'set', '~/victim', '--trusted', '--nonce', forOther])
    expect(bad.status).toBe(1)
    expect(bad.out.code).toBe('nonce-folder')
    expect(existsSync(join(plurHome, 'folders.yaml'))).toBe(false)
    const badRm = runIn(['folders', 'rm', '~/victim', '--nonce', issueFolderNonce(plurHome, 'session-h', other, { remove: true })])
    expect(badRm.status).toBe(1)
    expect(badRm.out.code).toBe('nonce-folder')

    // A nonce issued for the home folder is accepted for its quoted ~ spelling.
    const forHome = issueFolderNonce(plurHome, 'session-h', victim, { mode: 'on' })
    const ok = runIn(['folders', 'set', '~/victim', '--on', '--nonce', forHome])
    expect(ok.status).toBe(0)
    expect(ok.out.entry).toEqual({ path: victim, plur: 'on' })
    const okRm = runIn(['folders', 'rm', '~/victim', '--nonce', issueFolderNonce(plurHome, 'session-h', victim, { remove: true })])
    expect(okRm.out).toEqual({ success: true, removed: true })
  }, 60_000)

  it.skipIf(!hasPythonPty)('in an interactive terminal, plur trust and untrust need no nonce', () => {
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome }
    const pty = (args: string[]) => spawnSync('python3', [
      '-c', 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))',
      'node', CLI, ...args,
    ], { env, cwd: dir, encoding: 'utf-8', timeout: 60_000, input: '' })
    const t = pty(['trust', target])
    expect(t.status, t.stdout + t.stderr).toBe(0)
    expect(t.stdout).toContain(`Trusted: ${target}`)
    const u = pty(['untrust', target])
    expect(u.status, u.stdout + u.stderr).toBe(0)
    expect(u.stdout).toContain(`Untrusted: ${target}`)
  }, 60_000)
})

describe('nonceRequired (#1347)', () => {
  it('only a TTY on both stdin and stdout skips the nonce', () => {
    expect(nonceRequired(true, true)).toBe(false)
    expect(nonceRequired(true, false)).toBe(true)
    expect(nonceRequired(false, true)).toBe(true)
    expect(nonceRequired(undefined, undefined)).toBe(true)
  })
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
      // A marker above a repository does not reach into it (#1588).
      const ws = mk(join(home, 'ws'))
      writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { plur: {} } }))
      const repo = mk(join(ws, 'repo'))
      mkdirSync(join(repo, '.git'))
      mk(join(repo, 'src'))
      const inRepo = mk(join(ws, 'own'))
      mkdirSync(join(inRepo, '.git'))
      writeFileSync(join(inRepo, '.plur.yaml'), 'domain: own\n')
      mk(join(inRepo, 'lib'))
      expect(isPlurConfigured(join(repo, 'src'), home)).toBe(false)
      expect(isPlurConfigured(join(inRepo, 'lib'), home)).toBe(true)
      void plain
      for (const c of cases) {
        expect(findPlurMarker(c, home) !== null, c).toBe(isPlurConfigured(c, home))
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
