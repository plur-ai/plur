/**
 * #1418 × #1477: the folder question gives every offered answer its own
 * nonce, issued for exactly that answer (`issueFolderNonce(root, sessionId,
 * folder, answer)`). A nonce printed for one answer must not authorise
 * another: in particular the "Yes, without its settings" nonce must not grant
 * `--trusted`. Each offered command works exactly once.
 *
 * Real spawned CLI, with HOME, USERPROFILE, TMPDIR, PLUR_PATH and cwd inside
 * a temp directory, so the real ~/.plur is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const PROMPT = 'how do fixture deploys reach the blue staging lane'

let dir: string
let repo: string
let env: NodeJS.ProcessEnv

function cli(args: string[], input?: unknown): { stdout: string; stderr: string; status: number } {
  const r = runCli('node', [CLI, ...args], {
    encoding: 'utf-8', env, cwd: repo,
    input: input === undefined ? '' : JSON.stringify(input),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

function ask(sid: string): string {
  const out = cli(['hook-inject'], { session_id: sid, cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }).stdout
  return out ? JSON.parse(out).hookSpecificOutput?.additionalContext ?? '' : ''
}

interface Offer { line: string; flags: string[]; nonce: string }

/** Every `plur folders set <repo> <flags> --nonce <n>` the question prints, with the line it is on. */
function offers(text: string): Offer[] {
  const out: Offer[] = []
  for (const line of text.split('\n')) {
    const re = /plur folders set (\S+) (.+?) --nonce ([0-9a-f]{32})/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      expect(m[1]).toBe(repo)
      out.push({ line, flags: m[2].split(' '), nonce: m[3] })
    }
  }
  return out
}

const set = (flags: string[], nonce: string) => cli(['folders', 'set', repo, ...flags, '--nonce', nonce])
const mapPath = () => join(dir, '.plur', 'folders.yaml')
const mapBytes = () => (existsSync(mapPath()) ? readFileSync(mapPath(), 'utf8') : null)

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ask-nonce-')))
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  mkdirSync(join(dir, '.plur'), { recursive: true })
  repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_HOOK_HYBRID: 'off' }
  delete env.CLAUDE_SESSION_ID
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('an untrusted .plur.yaml: one nonce per offered answer', () => {
  beforeEach(() => {
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:fixture\nremote_url: http://127.0.0.1:9\nremote_token: secret-fixture-token\n')
  })

  it('the "Yes, without its settings" nonce is refused with --trusted, and changes nothing', () => {
    const text = ask('untrusted-cross')
    const without = offers(text).find(o => o.line.startsWith('- Yes, without its settings'))
    expect(without, text).toBeDefined()
    expect(without!.flags).not.toContain('--trusted')
    const before = mapBytes()
    const r = set(['--trusted'], without!.nonce)
    expect(r.status).not.toBe(0)
    expect(r.stderr + r.stdout).toMatch(/nonce-answer|nonce/i)
    expect(mapBytes()).toBe(before)
    // Refused, not burned: it still works for the answer it was printed for.
    expect(set(without!.flags, without!.nonce).status).toBe(0)
  })

  it('every offered command carries its own nonce and works exactly once', () => {
    const text = ask('untrusted-each')
    const all = offers(text)
    expect(all.map(o => o.flags.join(' '))).toEqual(['--trusted', '--on', '--off'])
    expect(new Set(all.map(o => o.nonce)).size).toBe(all.length)
    for (const o of all) {
      const first = set(o.flags, o.nonce)
      expect(first.status, `${o.flags.join(' ')}: ${first.stderr}`).toBe(0)
      expect(set(o.flags, o.nonce).status, `${o.flags.join(' ')} reused`).not.toBe(0)
    }
  })
})

describe('an undecided folder: one nonce per offered answer', () => {
  beforeEach(() => {
    // One configured team scope, so "Yes" offers --scope and --on both.
    writeFileSync(join(dir, '.plur', 'config.yaml'),
      'embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:9"\n    token: "t"\n    scope: "group:acme/eng"\n')
  })

  it('every offered command carries its own nonce and works exactly once; none grants another answer', () => {
    const text = ask('undecided-each')
    const all = offers(text)
    expect(all.map(o => o.flags.join(' '))).toEqual(['--scope group:acme/eng', '--on', '--off'])
    expect(new Set(all.map(o => o.nonce)).size).toBe(all.length)
    // No offered nonce grants --trusted, which this question never offers.
    for (const o of all) expect(set(['--trusted'], o.nonce).status).not.toBe(0)
    for (const o of all) {
      const first = set(o.flags, o.nonce)
      expect(first.status, `${o.flags.join(' ')}: ${first.stderr}`).toBe(0)
      expect(set(o.flags, o.nonce).status, `${o.flags.join(' ')} reused`).not.toBe(0)
    }
  })
})
