#!/usr/bin/env node
/**
 * Windows Codex probe (#1603). Run by .github/workflows/windows-init.yml on
 * windows-latest; never run against a real home directory.
 *
 * npm installs Codex on Windows as `codex.cmd`, which Node cannot run
 * without cmd.exe. This puts a stub `codex.cmd` on PATH, in a folder whose
 * path contains a space, then:
 *   1. runs `plur init --codex` into a fresh temporary HOME and requires
 *      "registered via `codex mcp add`";
 *   2. requires the stub to have received `mcp add plur -- <command> <args>`
 *      with every argument intact, and the command to be an existing .exe
 *      (not a .cmd, which Codex would have to spawn through a shell);
 *   3. asks the stub `codex mcp list` through cmd.exe and requires plur;
 *   4. spawns the registered command with no shell, as Codex does, and
 *      requires it to start (no ENOENT/EINVAL);
 *   5. re-runs init and requires "already registered".
 *
 * Exits 1 when any check fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repo, 'packages', 'cli', 'dist', 'index.js')
if (!existsSync(CLI)) { console.error(`built CLI not found at ${CLI}`); process.exit(1) }

const failures = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

const home = mkdtempSync(join(tmpdir(), 'Test User-'))
const bin = join(home, 'codex bin')
mkdirSync(bin)
mkdirSync(join(home, 'project'))
const calls = join(bin, 'calls.log')
const registered = join(bin, 'registered.txt')
// `mcp add` records its arguments one per line (%~1 strips cmd's quotes);
// `mcp list` prints the name of anything registered.
writeFileSync(join(bin, 'codex.cmd'), [
  '@echo off',
  'echo %*>>"%~dp0calls.log"',
  'if "%~1 %~2"=="mcp list" goto list',
  'if "%~1 %~2"=="mcp add" goto add',
  'exit /b 0',
  ':list',
  'if exist "%~dp0registered.txt" echo plur  registered',
  'exit /b 0',
  ':add',
  'shift',
  'shift',
  ':addloop',
  'if "%~1"=="" exit /b 0',
  '>>"%~dp0registered.txt" echo(%~1',
  'shift',
  'goto addloop',
  '',
].join('\r\n'))

const env = {
  ...process.env,
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '',
  CODEX_HOME: join(home, '.codex'), PLUR_PATH: join(home, '.plur'),
  PATH: `${bin};${process.env.PATH}`,
}
const runInit = () => spawnSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-opencode', '--no-cursor', '--no-antigravity', '--codex', '--no-prompt'], {
  cwd: join(home, 'project'), env, encoding: 'utf8', timeout: 180000,
})

console.log(`HOME: ${home}`)
const first = runInit()
console.log(first.stdout, first.stderr)
check(/MCP server: registered via `codex mcp add`/.test(first.stdout ?? ''), 'init registers plur via codex.cmd')
console.log('codex.cmd calls:\n' + (existsSync(calls) ? readFileSync(calls, 'utf8') : '(none)'))

const added = existsSync(registered) ? readFileSync(registered, 'utf8').split(/\r?\n/).filter(Boolean) : []
console.log('mcp add arguments:', added)
check(added[0] === 'plur' && added[1] === '--', 'codex.cmd received `mcp add plur --`')
const [command, ...args] = added.slice(2)
check(typeof command === 'string' && /\.exe$/i.test(command) && existsSync(command), `registered command is an existing .exe: ${command}`)
check(args.length > 0 && args.every((a) => existsSync(a)), `registered args are existing paths: ${JSON.stringify(args)}`)

const list = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(bin, 'codex.cmd')}" mcp list"`], { env, encoding: 'utf8', windowsVerbatimArguments: true })
check(/(^|\s)plur(\s|$)/m.test(list.stdout ?? ''), '`codex mcp list` shows plur')

if (command && existsSync(command)) {
  const started = await new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.on('error', (err) => done(`error: ${err.message}`))
    child.on('spawn', () => { setTimeout(() => { child.kill(); done('started') }, 2000) })
  })
  check(started === 'started', `the registered command spawns with no shell (${started})`)
}

const second = runInit()
check(/MCP server: already registered/.test(second.stdout ?? ''), 're-running init reports already registered')

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\nall Codex checks passed')
