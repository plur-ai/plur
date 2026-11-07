// security audit 2026-11-06: observations are redacted and owner-only. Real spawned CLI, temp HOME, dummy tokens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
// Dummy GitHub-shaped token: prefix plus 36 base62 characters.
const DUMMY = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
const posix = process.platform !== 'win32'

let dir: string
let repo: string
let obsDir: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-observe-secrets-')))
  mkdirSync(join(dir, 'tmp'))
  mkdirSync(join(dir, '.plur'))
  repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(dir, '.plur', 'folders.yaml'), `version: 1\nfolders:\n  - path: ${repo}\n    plur: on\n`)
  obsDir = join(dir, '.plur', 'observations')
  env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_HOOK_HYBRID: 'off' }
  delete env.CLAUDE_SESSION_ID
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function observe(payload: Record<string, unknown>, args: string[] = []): void {
  const r = runCli('node', [CLI, 'hook-observe', ...args], {
    encoding: 'utf-8', env, cwd: repo, input: JSON.stringify({ cwd: repo, ...payload }),
  })
  expect(r.status, r.stderr ?? '').toBe(0)
}

const today = () => join(obsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`)

describe('hook-observe keeps no credential and no wide file', () => {
  it('redacts a token in a Bash command, keeps the rest, and the stored line is clean', () => {
    observe({ tool_name: 'Bash', tool_input: { command: `export GH_TOKEN=${DUMMY} && gh pr list`, description: 'list prs' } })
    const text = readFileSync(today(), 'utf8')
    expect(text).not.toContain(DUMMY)
    expect(text).not.toContain(DUMMY.slice(4, 20))
    expect(text).toContain('[REDACTED')
    expect(text).toContain('gh pr list')
    expect(text).toContain('list prs')
  }, 30_000)

  it('a token past the 200-character trim is redacted, never cut in half', () => {
    const content = 'x'.repeat(170) + ` TOKEN=${DUMMY}\n`
    observe({ tool_name: 'Write', tool_input: { file_path: join(repo, '.env'), content } })
    const text = readFileSync(today(), 'utf8')
    expect(text).not.toContain(DUMMY.slice(0, 10))
  }, 30_000)

  it('redacts failure text', () => {
    observe({ tool_name: 'Bash', error: `curl: auth failed for token ${DUMMY}` }, ['--failure'])
    const text = readFileSync(today(), 'utf8')
    expect(text).not.toContain(DUMMY)
    expect(text).toContain('auth failed')
  }, 30_000)

  it.skipIf(!posix)('the folder is 0700 and the file 0600', () => {
    observe({ tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(statSync(obsDir).mode & 0o777).toBe(0o700)
    expect(statSync(today()).mode & 0o777).toBe(0o600)
  }, 30_000)
})
