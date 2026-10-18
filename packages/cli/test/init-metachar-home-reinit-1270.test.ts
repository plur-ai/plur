/**
 * #1270 re-review: on a home whose path holds a quote or shell metacharacter
 * but no space (`C:\Users\O'Brien`, `a&b`, `x(1)`), init writes the shim
 * path unquoted. The matcher did not recognise it, so every re-run of
 * `plur init` appended another full hook set for every editor. Three runs
 * must leave the same number of hook commands as one run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const WIN32_PRELOAD = pathToFileURL(join(__dirname, 'helpers', 'win32-platform.mjs')).href

/** Every `command` in a hooks file, wherever it is nested. */
function commands(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) commands(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' && typeof v === 'string') out.push(v)
      else commands(v, out)
    }
  }
  return out
}

describe('plur init on a home with a quote or metacharacter keeps one hook set (#1270 re-review)', { timeout: 120000 }, () => {
  let home = ''
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }) })

  it.each([
    ["o'brien", false],
    ["o'brien", true],
    ['a&b', true],
    ['x(1)', true],
  ])('home %s (win32 stub: %s): three runs leave the counts of one run', (name, win32) => {
    home = join(mkdtempSync(join(tmpdir(), 'plur-mc-')), name)
    const project = join(home, 'project')
    mkdirSync(project, { recursive: true })
    // This hook-idempotence fixture must not depend on Codex being installed
    // on the developer's PATH. Existing MCP registrations are repaired in place;
    // an explicit fresh --codex setup without a host now correctly exits nonzero.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'),
      '[mcp_servers.plur]\ncommand = "npx"\nargs = ["-y", "@plur-ai/mcp@0.19.4"]\n')
    const files = {
      claude: join(home, '.claude', 'settings.json'),
      codex: join(home, '.codex', 'hooks.json'),
      cursor: join(project, '.cursor', 'hooks.json'),
      antigravity: join(home, '.gemini', 'config', 'hooks.json'),
    }
    const runInit = () => execFileSync(process.execPath, [...(win32 ? ['--import', WIN32_PRELOAD] : []), CLI,
      'init', '--global', '--no-desktop', '--no-opencode', '--codex', '--cursor', '--antigravity', '--no-prompt'], {
      encoding: 'utf-8', timeout: 60000, env: isolatedHomeEnv(home), cwd: project,
    })
    const counts = () => Object.fromEntries(Object.entries(files).map(([editor, file]) => [
      editor, existsSync(file) ? commands(JSON.parse(readFileSync(file, 'utf-8'))).length : 0,
    ]))

    runInit()
    const once = counts()
    // The shim path really is unquoted and holds the metacharacter.
    const written = commands(JSON.parse(readFileSync(files.codex, 'utf-8')))
    expect(written.some((c) => c.includes(`${name}/.plur/bin/plur-hook`))).toBe(true)
    expect(once.claude).toBeGreaterThan(0)
    expect(once.codex).toBeGreaterThan(0)
    expect(once.cursor).toBeGreaterThan(0)
    runInit()
    runInit()
    expect(counts()).toEqual(once)
  })
})
