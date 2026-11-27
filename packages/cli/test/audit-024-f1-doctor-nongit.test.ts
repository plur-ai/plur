/**
 * Security audit 2026-11 (finding 1 of run 2): `plur doctor` launches a
 * project `.mcp.json` server only on approval held in the user's own state.
 * A `.claude/settings.local.json` inside the folder counts only when git
 * positively reports it untracked in a real work tree. A folder that is not a
 * git checkout (an archive, a copied tree), one whose `.git` is not a valid
 * repository, or a machine where git cannot answer, gives no such evidence:
 * the folder's own file is repository content there and never approves.
 *
 * Real spawned CLI; HOME and PLUR_PATH inside a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync, execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))

let base: string
let home: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-audit024-f1-')))
  home = join(base, 'home')
  mkdirSync(join(home, '.plur'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), '{}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

function doctorJsonIn(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): any {
  let stdout = ''
  let stderr = ''
  try {
    stdout = execSync(`"${process.execPath}" ${CLI} doctor --json`, {
      encoding: 'utf-8', timeout: 50000, cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', PLUR_DOCTOR_TIMEOUT: '5000', ...extraEnv },
    })
  } catch (err: any) { stdout = err.stdout?.toString() ?? ''; stderr = err.stderr?.toString() ?? String(err) }
  if (!stdout.trim()) throw new Error(`doctor printed no report:\n${stderr}`)
  return JSON.parse(stdout)
}

/** A folder holding a plur `.mcp.json` entry that drops a marker when run, plus its own settings.local.json. */
function folderWithApproval(name: string, approval: object): { dir: string; marker: string } {
  const dir = join(base, name)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const marker = join(base, `MARK_${name}`)
  const server = join(base, `${name}-server.sh`)
  writeFileSync(server, `#!/bin/sh\nPATH=/usr/bin:/bin\ntouch "${marker}"\nsleep 0.5\nexit 0\n`, { mode: 0o755 })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: server, args: [] } } }))
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(approval))
  return { dir, marker }
}

describe('doctor: a non-git folder cannot approve its own .mcp.json server', () => {
  for (const approval of [{ enableAllProjectMcpServers: true }, { enabledMcpjsonServers: ['plur'] }]) {
    it(`not a git checkout, settings.local.json ${JSON.stringify(approval)}: the project server is not run`, () => {
      const { dir, marker } = folderWithApproval('archive', approval)
      const report = doctorJsonIn(dir)
      expect(report.handshake.command ?? '').not.toContain('archive-server.sh')
      expect(existsSync(marker)).toBe(false)
      // the same from a nested subfolder (the .mcp.json is found walking up)
      const deeper = join(dir, 'sub', 'deeper')
      mkdirSync(deeper, { recursive: true })
      expect(doctorJsonIn(deeper).handshake.command ?? '').not.toContain('archive-server.sh')
      expect(existsSync(marker)).toBe(false)
    }, 120_000)
  }

  it('a .git that is not a valid repository gives no evidence either', () => {
    const { dir, marker } = folderWithApproval('fakegit', { enableAllProjectMcpServers: true })
    mkdirSync(join(dir, '.git'))
    expect(doctorJsonIn(dir).handshake.command ?? '').not.toContain('fakegit-server.sh')
    expect(existsSync(marker)).toBe(false)
  }, 60_000)

  it('git not available: the folder file is not approval', () => {
    if (process.platform === 'win32') return
    const { dir, marker } = folderWithApproval('nogit', { enableAllProjectMcpServers: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    // A PATH with node only: `git` cannot be run, so whether the file is tracked cannot be told.
    const bin = join(base, 'bin-node-only')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    // The unapproved fallback probe runs `npx`; a stand-in that stays up keeps doctor from racing a process that exits at once.
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexec /bin/sleep 1\n', { mode: 0o755 })
    expect(doctorJsonIn(dir, { PATH: bin }).handshake.command ?? '').not.toContain('nogit-server.sh')
    expect(existsSync(marker)).toBe(false)
  }, 60_000)

  it('control: in a real git work tree an untracked settings.local.json still approves', () => {
    const { dir } = folderWithApproval('gituntracked', { enableAllProjectMcpServers: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    expect(doctorJsonIn(dir).handshake.command ?? '').toContain('gituntracked-server.sh')
  }, 60_000)

  it("control: approval in the user's ~/.claude.json still approves a non-git folder", () => {
    const { dir } = folderWithApproval('userapproved', {})
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [dir]: { enabledMcpjsonServers: ['plur'] } } }))
    expect(doctorJsonIn(dir).handshake.command ?? '').toContain('userapproved-server.sh')
  }, 60_000)
})
