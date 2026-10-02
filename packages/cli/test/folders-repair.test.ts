/**
 * `plur folders repair`, and a broken folders.yaml pinpointed in
 * `plur folders list`, `plur doctor` and the hooks (#1526).
 *
 * Every spawn sets HOME, USERPROFILE, TMPDIR and PLUR_PATH to a temp dir, so
 * the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { hookFolderPolicy } from '../src/lib/folder-gate.js'

const CLI = builtCliPath(join(__dirname, '..'))
const hasPythonPty = process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf-8' }).status === 0
const SECRET = 'sk-live-SECRET-0123456789'

describe('plur folders repair (#1526)', () => {
  let dir: string
  let plurHome: string
  let file: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-folders-repair-')))
    mkdirSync(join(dir, 'tmp'))
    plurHome = join(dir, '.plur')
    mkdirSync(plurHome)
    file = join(plurHome, 'folders.yaml')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const env = () => ({ ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: plurHome })
  const backups = () => readdirSync(plurHome).filter(n => n.startsWith('folders.yaml.plur-backup-'))

  function run(args: string[], json = true): { status: number | null; out: any; stdout: string; stderr: string } {
    const r = runCli('node', [CLI, ...args, ...(json ? ['--json'] : [])], { encoding: 'utf-8', env: env(), cwd: dir })
    let out: any = null
    try { out = JSON.parse((r.stdout ?? '').trim()) } catch { /* not json */ }
    return { status: r.status, out, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  function pty(args: string[], input: string) {
    return spawnSync('python3', [
      '-c', 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))',
      'node', CLI, ...args,
    ], { env: env(), cwd: dir, encoding: 'utf-8', timeout: 60_000, input })
  }

  const BROKEN = '# my map\nversion: 1\nfolder:\n  - path: /a\n     plur: Off\n'
  const FIXED = '# my map\nversion: 1\nfolders:\n  - path: /a\n    plur: off\n'

  it('non-interactive without --yes is a dry run: shows the diff, changes nothing, exits nonzero', () => {
    writeFileSync(file, BROKEN)
    const r = run(['folders', 'repair'])
    expect(r.status).not.toBe(0)
    expect(r.out.status).toBe('dry-run')
    expect(r.out.diff).toContain('-folder:')
    expect(r.out.diff).toContain('+folders:')
    expect(r.out.problems[0].line).toBe(3)
    expect(readFileSync(file, 'utf8')).toBe(BROKEN)
    expect(backups()).toEqual([])
  })

  it('--yes: backup, atomic write, re-checked, exit 0', () => {
    writeFileSync(file, BROKEN)
    const r = run(['folders', 'repair', '--yes'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.out.status).toBe('repaired')
    expect(r.out.backup).toMatch(/folders\.yaml\.plur-backup-\d{8}T\d{6}Z$/)
    expect(readFileSync(r.out.backup, 'utf8')).toBe(BROKEN)
    expect(readFileSync(file, 'utf8')).toBe(FIXED)
    expect(r.out.ok_after).toBe(true)
    expect(run(['folders', 'list']).out).toEqual({ folders: [{ path: '/a', plur: 'off' }], count: 1 })
  })

  it('unfixable: pinpoints, says so, changes nothing, exits nonzero', () => {
    const bad = `version: 1\nfolders:\n  - path: /a/${SECRET}\n    plur: of\n`
    writeFileSync(file, bad)
    const r = run(['folders', 'repair', '--yes'])
    expect(r.status).not.toBe(0)
    expect(r.out.status).toBe('unfixable')
    expect(r.out.problems[0].line).toBe(4)
    expect(r.out.problems[0].message).toMatch(/^line 4: `plur:`/)
    expect(r.stdout).not.toContain(SECRET)
    expect(readFileSync(file, 'utf8')).toBe(bad)
    expect(backups()).toEqual([])
  })

  it('a healthy or missing map: nothing to repair, exit 0', () => {
    expect(run(['folders', 'repair']).status).toBe(0)
    writeFileSync(file, 'version: 1\nfolders: []\n')
    const r = run(['folders', 'repair'])
    expect(r.status).toBe(0)
    expect(r.out.status).toBe('ok')
  })

  it('folders list on a broken map: pinpoints and offers repair instead of "no decisions"', () => {
    writeFileSync(file, `version: 1\nfolders:\n  - path: /a/${SECRET}\n     plur: off\n`)
    const r = run(['folders', 'list'])
    expect(r.status).not.toBe(0)
    expect(r.out.success).toBe(false)
    expect(r.out.line).toBe(4)
    expect(r.out.column).toBe(6)
    expect(r.out.error).toContain('line 4: indentation')
    expect(r.out.error).toContain('plur folders repair')
    expect(r.stdout).not.toContain(SECRET)
  })

  it('a write on a broken map names the repair command', () => {
    writeFileSync(file, '# nothing yet\n')
    const target = join(dir, 'proj')
    mkdirSync(target)
    const r = run(['folders', 'set', target, '--off', '--nonce', 'deadbeef'])
    expect(r.status).toBe(1)
    expect(r.out.error).toContain('plur folders repair')
    expect(readFileSync(file, 'utf8')).toBe('# nothing yet\n')
  })

  it('doctor names the line and the problem, offers repair, and fails overall', () => {
    writeFileSync(file, `version: 1\nfolder:\n  - path: /a/${SECRET}\n`)
    const r = runCli('node', [CLI, 'doctor', '--no-handshake', '--json'], {
      encoding: 'utf-8', timeout: 30_000, cwd: dir,
      env: { ...env(), PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    const report = JSON.parse(r.stdout)
    expect(report.overall).toBe('fail')
    expect(report.folderMap.file).toBe(file)
    expect(report.folderMap.line).toBe(2)
    expect(report.folderMap.problem).toContain('unknown key `folder:` — did you mean `folders:`?')
    expect(report.folderMap.fixable).toBe(true)
    expect(report.folderMap.repair).toBe('plur folders repair')
    expect(r.stdout).not.toContain(SECRET)
  }, 60_000)

  it('the hooks agree with the MCP gate: an empty map beside a project marker is ask (malformed-map), not on', () => {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    writeFileSync(file, '# nothing yet\n')
    const p = hookFolderPolicy(repo, { path: plurHome })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
  })

  it.skipIf(!hasPythonPty)('interactive: shows the diff and asks; "n" changes nothing', () => {
    writeFileSync(file, BROKEN)
    const r = pty(['folders', 'repair'], 'n\n')
    expect(r.stdout).toContain('+folders:')
    expect(r.stdout).toMatch(/Apply this change\?/)
    expect(r.status).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(BROKEN)
    expect(backups()).toEqual([])
  }, 60_000)

  it.skipIf(!hasPythonPty)('interactive: "y" applies it, with a backup', () => {
    writeFileSync(file, BROKEN)
    const r = pty(['folders', 'repair'], 'y\n')
    expect(r.status, r.stdout).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(FIXED)
    expect(backups().length).toBe(1)
    expect(r.stdout).toMatch(/backup/i)
  }, 60_000)
})
