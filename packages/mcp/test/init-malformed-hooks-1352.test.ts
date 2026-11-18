/**
 * #1352: a hand-edited ~/.claude/settings.json must not crash `plur-mcp init`.
 *
 * A hook without a `command` string (a `type: "prompt"` / `"agent"` hook) was
 * already tolerated by #1279 (see init-hooks.test.ts). The same TypeError was
 * still reachable through the structure around the hooks: an event that is not
 * a list, an entry that is not an object, an entry whose `hooks` is not a
 * list, or a hook that is not an object. init threw midway, after writing the
 * MCP config and before CLAUDE.md. Now the hooks step is skipped with the
 * offending path named, the file is left byte-for-byte as it was, and init
 * finishes, as it already does for a settings file that is not a JSON object.
 *
 * Real spawned `plur-mcp init` with HOME, USERPROFILE, TMPDIR and PLUR_PATH in
 * a temp directory; the real ~/.claude and ~/.plur are never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { hooksShapeProblem } from '../src/index.js'

const MCP = join(__dirname, '..', 'dist', 'index.js')

let home: string
let work: string
const settingsPath = () => join(home, '.claude', 'settings.json')

function init(): { status: number | null; out: string } {
  const r = spawnSync('node', [MCP, 'init'], {
    encoding: 'utf-8', cwd: work, timeout: 120_000, input: '',
    env: {
      ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'),
      XDG_CONFIG_HOME: join(home, '.config'), PLUR_PATH: join(home, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1', PLUR_TELEMETRY: '', PLUR_BACKEND: '',
    },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-init-1352-')))
  mkdirSync(join(home, 'tmp'))
  mkdirSync(join(home, '.claude'))
  work = join(home, 'work')
  mkdirSync(work)
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const MALFORMED: Array<[string, unknown, string]> = [
  ['an event that is an object', { Stop: { hooks: [] } }, 'hooks.Stop'],
  ['an event that is a string', { Stop: 'say done' }, 'hooks.Stop'],
  ['an entry that is null', { Stop: [null] }, 'hooks.Stop[0]'],
  ['an entry whose hooks is an object', { Stop: [{ hooks: { type: 'command', command: 'say done' } }] }, 'hooks.Stop[0].hooks'],
  ['an entry whose hooks is a string', { Stop: [{ hooks: 'say done' }] }, 'hooks.Stop[0].hooks'],
  ['a hook that is null', { Stop: [{ hooks: [null] }] }, 'hooks.Stop[0].hooks[0]'],
  // Did not crash before (a string has no `command`), but is no more a hook
  // than null is: refused by the same rule rather than special-cased.
  ['a hook that is a string', { Stop: [{ hooks: ['say done'] }] }, 'hooks.Stop[0].hooks[0]'],
]

/** Hooks step skipped with `where` named, file byte-for-byte unchanged, init completes. */
function expectSkipped(name: string): void {
  const [, hooks, where] = MALFORMED.find(([n]) => n === name)!
  const raw = JSON.stringify({ theme: 'dark', hooks }, null, 2) + '\n'
  writeFileSync(settingsPath(), raw)
  const { status, out } = init()
  expect(out).not.toMatch(/TypeError/)
  expect(status, out).toBe(0)
  expect(out).toMatch(/Hooks:\s+skipped/)
  expect(out).toContain(where)
  expect(out).toMatch(/CLAUDE\.md:/) // init went past the hooks step
  expect(readFileSync(settingsPath(), 'utf8')).toBe(raw)
}

// Spelled out one by one (not generated in a loop) so spec/guarantees can cite them by name.
describe('plur-mcp init with a malformed hooks section (#1352)', { timeout: 300_000 }, () => {
  it('an event that is an object: hooks skipped and named, file unchanged, init completes', () => expectSkipped('an event that is an object'))
  it('an event that is a string: hooks skipped and named, file unchanged, init completes', () => expectSkipped('an event that is a string'))
  it('an entry that is null: hooks skipped and named, file unchanged, init completes', () => expectSkipped('an entry that is null'))
  it('an entry whose hooks is an object: hooks skipped and named, file unchanged, init completes', () => expectSkipped('an entry whose hooks is an object'))
  it('an entry whose hooks is a string: hooks skipped and named, file unchanged, init completes', () => expectSkipped('an entry whose hooks is a string'))
  it('a hook that is null: hooks skipped and named, file unchanged, init completes', () => expectSkipped('a hook that is null'))
  it('a hook that is a string: hooks skipped and named, file unchanged, init completes', () => expectSkipped('a hook that is a string'))

  it('a top-level hooks value that is not an object: skipped, and the message says what is expected there', () => {
    const raw = JSON.stringify({ hooks: [] }, null, 2) + '\n'
    writeFileSync(settingsPath(), raw)
    const { status, out } = init()
    expect(status, out).toBe(0)
    expect(out).toMatch(/Hooks:\s+skipped.*`hooks` is not an object; Claude Code expects an object mapping each event/)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(raw)
  })

  // Not refused: `(entry.hooks ?? [])` already tolerated it before #1352. Guards against
  // the refusal rule growing to cover null, which the old code accepted.
  it('an entry whose hooks is null: hooks installed, the entry kept, init completes', () => {
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: null }] } }, null, 2) + '\n')
    const { status, out } = init()
    expect(out).not.toMatch(/TypeError/)
    expect(status, out).toBe(0)
    expect(out).not.toMatch(/Hooks:\s+skipped/)
    const after = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    expect(after.hooks.Stop[0]).toEqual({ matcher: '*', hooks: null })
    expect(Object.keys(after.hooks).length).toBeGreaterThan(1)
  })
})

describe('hooksShapeProblem (#1352)', () => {
  it('names the first offending path', () => {
    for (const [, hooks, where] of MALFORMED) expect(hooksShapeProblem(hooks)).toContain(where)
    expect(hooksShapeProblem([])).toContain('hooks')
    expect(hooksShapeProblem('say done')).toContain('hooks')
  })

  it('accepts every shape init already handled, including command-less hooks (#1279)', () => {
    expect(hooksShapeProblem(undefined)).toBeNull()
    expect(hooksShapeProblem(null)).toBeNull()
    expect(hooksShapeProblem({})).toBeNull()
    expect(hooksShapeProblem({ Stop: null })).toBeNull()
    expect(hooksShapeProblem({ Stop: [] })).toBeNull()
    expect(hooksShapeProblem({ Stop: [{ matcher: '*' }] })).toBeNull()
    // `(entry.hooks ?? [])` tolerated null before #1352; absent and null are one rule at every level.
    expect(hooksShapeProblem({ Stop: [{ hooks: null }] })).toBeNull()
    expect(hooksShapeProblem({
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'be nice' }, { type: 'command', command: 42 }] }],
      PostCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', agent: 'x' }] }],
    })).toBeNull()
  })
})
