#!/usr/bin/env node
/**
 * Windows hook probe (decision H3, #1267). Run by .github/workflows/windows-init.yml
 * on windows-latest; never run against a real home directory.
 *
 * For each scenario, `plur init` runs into a fresh temporary HOME whose path
 * contains a space, with Claude Code, Cursor, Codex and Antigravity all set
 * up, and every hook init generated is executed EXACTLY as written:
 *   - Claude Code exec-form hooks (command + args) are spawned with no shell;
 *     Claude Code string hooks run through `bash -c` and
 *     `pwsh -NoProfile -Command` (the two shells Claude Code uses on Windows);
 *   - Cursor, Codex and Antigravity hook strings run through each of
 *     `bash -c`, `pwsh -NoProfile -Command` and `cmd /C`.
 * PLUR_HOOK_PROBE makes the CLI append the hook subcommand it received to a
 * file and exit without running the hook. A run passes only when that file
 * holds exactly the subcommand the hook names — proof the hook reached the
 * CLI through that shell, not merely that the shell exited 0 (PowerShell
 * prints a quoted string and exits 0).
 *
 * Scenarios:
 *   - no `claude` on PATH: version unknown, so Claude Code gets the unquoted
 *     short-path string;
 *   - a stand-in `claude` reporting 2.1.200: Claude Code gets the exec form
 *     (it needs >= 2.1.139).
 *
 * Re-init: after probing, `plur init` runs a second time with the same
 * arguments, and the hook count per editor must be unchanged. The shim's
 * 8.3 short path (`.../PLUR~1/bin/PLUR-H~1.CMD`) once went unrecognised,
 * and every re-run appended another set. `plur doctor` must then report
 * `hasPlurHooks` for each editor's hooks file, not only the aggregate
 * `hooksInstalled`.
 *
 * Exits 1 when any run fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repo, 'packages', 'cli', 'dist', 'index.js')
if (!existsSync(CLI)) { console.error(`built CLI not found at ${CLI}`); process.exit(1) }

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync) ?? 'bash'
const shells = {
  bash: (cmd) => [gitBash, ['-c', cmd], {}],
  pwsh: (cmd) => ['pwsh', ['-NoProfile', '-Command', cmd], {}],
  cmd: (cmd) => ['cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true }],
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
function collect(value, out = []) {
  if (Array.isArray(value)) for (const v of value) collect(v, out)
  else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') out.push({ command: value.command, args: value.args })
    for (const [k, v] of Object.entries(value)) if (k !== 'command' && k !== 'args') collect(v, out)
  }
  return out
}

let n = 0
const failures = []

function scenario(name, { fakeClaude, expectClaudeExec }) {
  console.log(`\n=== Scenario: ${name} ===`)
  const home = mkdtempSync(join(tmpdir(), 'Test User-'))
  if (!/\s/.test(home)) { console.error(`temp HOME has no space: ${home}`); process.exit(1) }
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '' }
  if (fakeClaude) {
    const bin = join(home, 'fakebin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude.cmd'), `@echo off\r\necho ${fakeClaude} (Claude Code)\r\n`)
    env.PATH = `${bin};${process.env.PATH}`
  }
  console.log(`HOME: ${home}`)

  const runInit = () => spawnSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-opencode', '--cursor', '--codex', '--antigravity', '--no-prompt'], {
    cwd: project, env, encoding: 'utf8', timeout: 120000,
  })
  const init = runInit()
  console.log(init.stdout)
  if (init.status !== 0) { console.error(init.stderr); failures.push(`${name}: init`); return }

  const hookFiles = {
    'Claude Code': join(home, '.claude', 'settings.json'),
    Cursor: join(project, '.cursor', 'hooks.json'),
    Codex: join(home, '.codex', 'hooks.json'),
    Antigravity: join(home, '.gemini', 'config', 'hooks.json'),
  }
  const hookCounts = () => Object.fromEntries(Object.entries(hookFiles).map(([editor, file]) => [
    editor, collect(editor === 'Antigravity' ? readJson(file) : readJson(file).hooks).length,
  ]))
  const countsBefore = hookCounts()

  function probe(label, expected, file, args, opts) {
    const out = join(home, `probe-${++n}.txt`)
    rmSync(out, { force: true })
    const r = spawnSync(file, args, { ...opts, env: { ...env, PLUR_HOOK_PROBE: out }, input: '{}', encoding: 'utf8', timeout: 60000, cwd: project })
    const got = existsSync(out) ? readFileSync(out, 'utf8') : ''
    const ok = got === `${expected}\n`
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (exit ${r.status}${ok ? '' : `, probe=${JSON.stringify(got)}, stdout=${JSON.stringify((r.stdout ?? '').slice(0, 200))}, stderr=${JSON.stringify((r.stderr ?? '').slice(0, 200))}`})`)
    if (!ok) failures.push(`${name}: ${label}`)
  }
  const subOf = (text) => /(?:^|\s)(hook-[a-z0-9-]+)/.exec(text)?.[1]

  const claude = collect(readJson(join(home, '.claude', 'settings.json')).hooks)
  const exec = claude.filter((h) => Array.isArray(h.args))
  console.log(`Claude Code: ${claude.length} hooks, ${exec.length} in exec form`)
  if (expectClaudeExec ? exec.length !== claude.length : exec.length !== 0) {
    console.log(`FAIL  Claude Code form: expected ${expectClaudeExec ? 'exec' : 'string'} form throughout`)
    failures.push(`${name}: Claude Code form`)
  }
  for (const h of claude) {
    if (Array.isArray(h.args)) {
      probe(`Claude Code (exec): ${[h.command, ...h.args].join(' ')}`, subOf(h.args.join(' ')), h.command, h.args, {})
    } else {
      for (const shell of ['bash', 'pwsh']) {
        const [file, args, opts] = shells[shell](h.command)
        probe(`Claude Code via ${shell}: ${h.command}`, subOf(h.command), file, args, opts)
      }
    }
  }

  const strings = {
    Cursor: collect(readJson(join(project, '.cursor', 'hooks.json')).hooks).map((h) => h.command),
    Codex: collect(readJson(join(home, '.codex', 'hooks.json')).hooks).map((h) => h.command),
    Antigravity: collect(readJson(join(home, '.gemini', 'config', 'hooks.json'))).map((h) => h.command),
  }
  for (const [editor, cmds] of Object.entries(strings)) {
    console.log(`${editor}: ${cmds.length} hooks`)
    for (const cmd of cmds) {
      for (const [shell, build] of Object.entries(shells)) {
        const [file, args, opts] = build(cmd)
        probe(`${editor} via ${shell}: ${cmd}`, subOf(cmd), file, args, opts)
      }
    }
  }

  const reinit = runInit()
  if (reinit.status !== 0) {
    console.error(reinit.stderr)
    failures.push(`${name}: second init`)
  } else {
    const countsAfter = hookCounts()
    for (const editor of Object.keys(hookFiles)) {
      const ok = countsAfter[editor] === countsBefore[editor]
      console.log(`${ok ? 'PASS' : 'FAIL'}  re-init ${editor}: ${countsBefore[editor]} -> ${countsAfter[editor]} hooks`)
      if (!ok) failures.push(`${name}: re-init changed the ${editor} hook count (${countsBefore[editor]} -> ${countsAfter[editor]})`)
    }
  }

  const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--no-handshake', '--json'], { cwd: project, env, encoding: 'utf8', timeout: 120000 })
  try {
    const report = JSON.parse(doctor.stdout)
    console.log(`plur doctor: hooksInstalled=${report.hooksInstalled} windowsHookFallback=${JSON.stringify(report.windowsHookFallback)}`)
    if (!report.hooksInstalled) failures.push(`${name}: doctor hooksInstalled false`)
    const perFile = ['Claude Code (global)', 'Cursor (.cursor/hooks.json)', 'Codex (~/.codex/hooks.json)', 'Antigravity (~/.gemini/config/hooks.json)']
    for (const label of perFile) {
      const c = (report.configs ?? []).find((x) => x.label === label)
      const ok = c?.exists === true && c.hasPlurHooks === true
      console.log(`${ok ? 'PASS' : 'FAIL'}  doctor ${label}: exists=${c?.exists} hasPlurHooks=${c?.hasPlurHooks}`)
      if (!ok) failures.push(`${name}: doctor ${label} hasPlurHooks not true`)
    }
  } catch {
    console.log(`plur doctor output was not JSON: ${doctor.stdout.slice(0, 500)}`)
    failures.push(`${name}: doctor`)
  }
}

scenario('no claude on PATH (version unknown)', { fakeClaude: null, expectClaudeExec: false })
scenario('claude 2.1.200 on PATH', { fakeClaude: '2.1.200', expectClaudeExec: true })

console.log(`\n${n} runs, ${failures.length} failed`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
