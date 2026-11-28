/**
 * #1897 (siblings of #1352): a hand-edited hooks section must not make
 * `plur init`, its Codex and Cursor legs, or `plur doctor` throw.
 *
 * #1854 made `plur-mcp init` skip the hooks step, name the offending path and
 * leave the file untouched when the `hooks` section breaks the shape the
 * harness reads. The CLI installers and doctor still assumed every event is a
 * list and every entry's `hooks` is a list. These tests drive the real built
 * CLI with each malformed shape from the issue and expect the #1854 behaviour:
 * no throw, the hooks step skipped with the path named, the file byte-for-byte
 * unchanged, and doctor reporting the problem instead of crashing.
 *
 * Every run has HOME, USERPROFILE, CODEX_HOME, XDG_CONFIG_HOME and PLUR_PATH
 * in a temp directory (isolatedHomeEnv); the real ~/.claude, ~/.codex,
 * ~/.cursor and ~/.plur are never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { printText } from '../src/commands/doctor.js'

const CLI = builtCliPath(join(__dirname, '..'))

/** What an uncaught shape error looks like on the way out. */
const CRASH = /TypeError|is not a function|is not iterable|Cannot read propert/

let home: string
let project: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1897-')))
  project = join(home, 'project')
  mkdirSync(project)
  mkdirSync(join(home, '.claude'))
})
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

function cli(args: string[]): { status: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', cwd: project, timeout: 60_000, input: '',
    env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' },
  })
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, stdout: r.stdout ?? '' }
}

const NO_OTHERS = ['--no-prompt', '--no-desktop', '--no-antigravity', '--no-opencode']

/** Write `{ <extra>, hooks }` to `path`; returns the exact bytes written. */
function plant(path: string, hooks: unknown, extra: Record<string, unknown> = { theme: 'dark' }): string {
  mkdirSync(join(path, '..'), { recursive: true })
  const raw = JSON.stringify({ ...extra, hooks }, null, 2) + '\n'
  writeFileSync(path, raw)
  return raw
}

// Claude Code and Codex share the nested shape: event -> list of entries ->
// entry.hooks list of hook objects. The #1352 cases, plus a top-level `hooks`
// that is not an object.
const NESTED: Array<[string, unknown, string]> = [
  ['hooks is a list', [], '`hooks` is not an object'],
  ['an event that is an object', { Stop: { hooks: [] } }, 'hooks.Stop'],
  ['an event that is a string', { Stop: 'say done' }, 'hooks.Stop'],
  ['an entry that is null', { Stop: [null] }, 'hooks.Stop[0]'],
  ['an entry whose hooks is an object', { Stop: [{ hooks: { type: 'command', command: 'say done' } }] }, 'hooks.Stop[0].hooks'],
  ['an entry whose hooks is a string', { Stop: [{ hooks: 'say done' }] }, 'hooks.Stop[0].hooks'],
  ['a hook that is null', { Stop: [{ hooks: [null] }] }, 'hooks.Stop[0].hooks[0]'],
]

// Cursor is one level shallower: event -> flat list of command objects.
const FLAT: Array<[string, unknown, string]> = [
  ['hooks is a string', 'say done', '`hooks` is not an object'],
  ['an event that is an object', { stop: { command: './x.sh' } }, 'hooks.stop'],
  ['an event that is a string', { stop: './x.sh' }, 'hooks.stop'],
  ['an entry that is null', { stop: [null] }, 'hooks.stop[0]'],
  ['an entry that is a string', { stop: ['./x.sh'] }, 'hooks.stop[0]'],
]

describe('plur init, Claude Code settings, with a malformed hooks section (#1897)', { timeout: 600_000 }, () => {
  it.each(NESTED)('user settings, %s: hooks skipped and named, file unchanged, init completes', (_n, hooks, where) => {
    const path = join(home, '.claude', 'settings.json')
    const raw = plant(path, hooks)
    const { status, out } = cli(['init', '--global', ...NO_OTHERS, '--no-cursor', '--no-codex'])
    expect(out).not.toMatch(CRASH)
    expect(status, out).toBe(0)
    expect(out).toMatch(/Enforcement hooks[^\n]*: skipped/)
    expect(out).toMatch(/Injection hooks[^\n]*: skipped/)
    expect(out).toContain(where)
    expect(out).toContain(path)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it.each(NESTED)('project settings (--project), %s: hooks skipped and named, file unchanged, init completes', (_n, hooks, where) => {
    const path = join(project, '.claude', 'settings.json')
    const raw = plant(path, hooks)
    const { status, out } = cli(['init', '--project', ...NO_OTHERS, '--no-cursor', '--no-codex'])
    expect(out).not.toMatch(CRASH)
    expect(status, out).toBe(0)
    expect(out).toContain(where)
    expect(out).toContain(path)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it.each(NESTED)('a repo settings file being migrated, %s: left alone with the path named, init completes', (_n, hooks, where) => {
    const path = join(project, '.claude', 'settings.json')
    const raw = plant(path, hooks)
    const { status, out } = cli(['init', ...NO_OTHERS, '--no-cursor', '--no-codex'])
    expect(out).not.toMatch(CRASH)
    expect(status, out).toBe(0)
    expect(out).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})

describe('plur init --codex with a malformed hooks.json (#1897)', { timeout: 600_000 }, () => {
  it.each(NESTED)('%s: Codex hooks skipped and named, file unchanged, init completes', (_n, hooks, where) => {
    const path = join(home, '.codex', 'hooks.json')
    const raw = plant(path, hooks, { description: 'my hooks' })
    const { out } = cli(['init', '--codex', ...NO_OTHERS, '--no-cursor'])
    expect(out).not.toMatch(CRASH)
    expect(out).toMatch(/Codex: hooks skipped/)
    expect(out).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})

describe('plur init --cursor with a malformed .cursor/hooks.json (#1897)', { timeout: 600_000 }, () => {
  it.each(FLAT)('%s: Cursor hooks skipped and named, file unchanged, init completes', (_n, hooks, where) => {
    const path = join(project, '.cursor', 'hooks.json')
    const raw = plant(path, hooks, { version: 1 })
    const { out } = cli(['init', '--cursor', ...NO_OTHERS, '--no-codex'])
    expect(out).not.toMatch(CRASH)
    expect(out).toMatch(/hooks:?\s+skipped/i)
    expect(out).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})

interface DoctorConfig { label: string; path: string; hooksProblem?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function doctor(): { out: string; configs: DoctorConfig[]; report: any } {
  const { out, stdout } = cli(['doctor', '--no-handshake', '--json'])
  expect(out).not.toMatch(CRASH)
  let report: { configs?: DoctorConfig[] }
  try { report = JSON.parse(stdout) } catch { throw new Error(`doctor printed no JSON report:\n${out}`) }
  return { out, configs: report.configs ?? [], report }
}

describe('plur doctor with a malformed hooks section (#1897)', { timeout: 600_000 }, () => {
  it.each(NESTED)('Claude Code user settings, %s: reported, not a crash', (_n, hooks, where) => {
    const path = join(home, '.claude', 'settings.json')
    const raw = plant(path, hooks)
    const { configs } = doctor()
    expect(configs.find(c => c.path === path)?.hooksProblem).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it.each(NESTED)('Codex hooks.json, %s: reported, not a crash', (_n, hooks, where) => {
    const path = join(home, '.codex', 'hooks.json')
    const raw = plant(path, hooks, { description: 'my hooks' })
    const { configs } = doctor()
    expect(configs.find(c => c.path === path)?.hooksProblem).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it.each(FLAT)('Cursor hooks.json, %s: reported, not a crash', (_n, hooks, where) => {
    const path = join(project, '.cursor', 'hooks.json')
    const raw = plant(path, hooks, { version: 1 })
    const { configs } = doctor()
    expect(configs.find(c => c.path === path)?.hooksProblem).toContain(where)
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  // Not malformed: a null event was always tolerated by init's `entries ?? []`.
  // Guards doctor's walkers, which iterated it directly.
  it('Claude Code user settings with a null event: not reported, not a crash', () => {
    const path = join(home, '.claude', 'settings.json')
    plant(path, { Stop: null })
    const { configs } = doctor()
    const c = configs.find(c => c.path === path)
    expect(c).toBeDefined()
    expect(c?.hooksProblem).toBeUndefined()
  })

  it('prints the problem in the text report', () => {
    const path = join(home, '.claude', 'settings.json')
    plant(path, { Stop: [null] })
    const { report } = doctor()
    let text = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { text += s; return true }) as never)
    printText(report)
    expect(text).toContain(path)
    expect(text).toContain('hooks.Stop[0] is not an object')
  })
})
