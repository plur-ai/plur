#!/usr/bin/env node
/**
 * Windows Codex probe (#1603). Run by .github/workflows/windows-init.yml on
 * windows-latest; never run against a real home directory.
 *
 * Two places Codex lives on Windows, each a scenario with a fresh temporary
 * HOME whose path contains a space:
 *
 *   npm:  `codex.cmd` on PATH, next to npm's extensionless sh shim `codex`
 *         (which Windows cannot run and init must never pick);
 *   app:  no codex on PATH; the Codex app's bundled binary at
 *         ~/.codex/packages/app-server-daemon/releases/<ver>-<triple>/bin/codex.exe,
 *         with an older release beside it that must NOT be used.
 *
 * The app stub is a copy of node.exe named codex.exe, made to act as Codex by
 * a NODE_OPTIONS preload that only acts when the running binary is named
 * codex.exe. Both stubs record `mcp add` arguments one per line and answer
 * `mcp list` with plur once added.
 *
 * Each scenario requires: init reports "registered via `codex mcp add`" and
 * names the binary it used; the stub received `mcp add plur -- <command> <args>`
 * with every argument intact; the command is an existing .exe (node.exe, not
 * a .cmd) and the args existing files; the command spawns with no shell, as
 * Codex does; and a re-run of init says "already registered".
 *
 * Two more npm scenarios check the cmd.exe line on a real cmd: a HOME with
 * `!OS!` registers (delayed expansion is off), and a HOME with `%OS%` is
 * refused with the TOML table printed and the stub never run.
 *
 * Exits 1 when any check fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repo, 'packages', 'cli', 'dist', 'index.js')
if (!existsSync(CLI)) { console.error(`built CLI not found at ${CLI}`); process.exit(1) }

const failures = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

// A PATH without any real codex, so only the stubs can answer.
const basePath = (process.env.PATH ?? '').split(';').filter((d) => !['codex.cmd', 'codex.exe', 'codex.bat'].some((f) => existsSync(join(d, f)))).join(';')

// Preload for the app stub (a node.exe copy named codex.exe). No space in its path.
const preloadDir = mkdtempSync(join(tmpdir(), 'codexstub-'))
const preload = join(preloadDir, 'codex-stub.cjs')
writeFileSync(preload, `
const { basename, dirname, join } = require('path')
const fs = require('fs')
if (basename(process.execPath).toLowerCase() === 'codex.exe') {
  const here = dirname(process.execPath)
  // Node has already resolved argv[1] to a path (cwd + "mcp"): keep its last segment.
  const args = process.argv.slice(1)
  if (args.length) args[0] = basename(args[0])
  fs.appendFileSync(join(here, 'calls.log'), JSON.stringify(args) + '\\n')
  if (args[0] === 'mcp' && args[1] === 'list') {
    if (fs.existsSync(join(here, 'registered.txt'))) process.stdout.write('plur  registered\\n')
  } else if (args[0] === 'mcp' && args[1] === 'add') {
    fs.writeFileSync(join(here, 'registered.txt'), args.slice(2).join('\\n') + '\\n')
  }
  process.exit(0)
}
`)

function npmStub(bin) {
  // `mcp add` records its arguments one per line (%~1 strips cmd's quotes).
  // HERE is captured first: `shift` also shifts %0.
  writeFileSync(join(bin, 'codex.cmd'), [
    '@echo off',
    'set "HERE=%~dp0"',
    'echo %*>>"%HERE%calls.log"',
    'if "%~1 %~2"=="mcp list" goto list',
    'if "%~1 %~2"=="mcp add" goto add',
    'exit /b 0',
    ':list',
    'if exist "%HERE%registered.txt" echo plur  registered',
    'exit /b 0',
    ':add',
    'shift',
    'shift',
    ':addloop',
    'if "%~1"=="" exit /b 0',
    '>>"%HERE%registered.txt" echo(%~1',
    'shift',
    'goto addloop',
    '',
  ].join('\r\n'))
  // npm's extensionless sh shim, which Windows cannot execute.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 7\n')
  return bin
}

function appStub(home, release) {
  const dir = join(home, '.codex', 'packages', 'app-server-daemon', 'releases', release, 'bin')
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.execPath, join(dir, 'codex.exe'))
  return dir
}

async function scenario(name, setup, { prefix = 'Test User-', expectRefused = false } = {}) {
  console.log(`\n=== Scenario: ${name} ===`)
  const home = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(home, 'project'))
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '',
    CODEX_HOME: join(home, '.codex'), PLUR_PATH: join(home, '.plur'),
    PATH: basePath,
    // Unquoted, forward slashes: NODE_OPTIONS treats a backslash in quotes as an escape.
    NODE_OPTIONS: `--require ${preload.replace(/\\/g, '/')}`,
  }
  const { stubDir, extraPath, binary, notUsed } = setup(home)
  if (extraPath) env.PATH = `${extraPath};${basePath}`
  console.log(`HOME: ${home}`)

  const runInit = () => spawnSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-opencode', '--no-cursor', '--no-antigravity', '--codex', '--no-prompt'], {
    cwd: join(home, 'project'), env, encoding: 'utf8', timeout: 180000,
  })
  const first = runInit()
  console.log(first.stdout, first.stderr)
  if (expectRefused) {
    // A `%` in the codex.cmd path cannot be carried through cmd.exe safely, so
    // init refuses it, never runs the stub, and prints the TOML to add by hand.
    check(/MCP server: FAILED \(argument cannot be passed through cmd\.exe/.test(first.stdout ?? ''), `${name}: init refuses the path instead of changing it`)
    check((first.stdout ?? '').includes('[mcp_servers.plur]'), `${name}: init prints the TOML table`)
    check(!existsSync(join(stubDir, 'calls.log')), `${name}: codex.cmd was never run`)
    return
  }
  check(/MCP server: registered via `codex mcp add`/.test(first.stdout ?? ''), `${name}: init registers plur`)
  check((first.stdout ?? '').includes(binary), `${name}: init names the binary it used (${binary})`)
  const calls = join(stubDir, 'calls.log')
  console.log('stub calls:\n' + (existsSync(calls) ? readFileSync(calls, 'utf8') : '(none)'))
  if (notUsed) check(!existsSync(join(notUsed, 'calls.log')), `${name}: the older release was not used`)

  const reg = join(stubDir, 'registered.txt')
  const added = existsSync(reg) ? readFileSync(reg, 'utf8').split(/\r?\n/).filter(Boolean) : []
  console.log('mcp add arguments:', added)
  check(added[0] === 'plur' && added[1] === '--', `${name}: codex received \`mcp add plur --\``)
  const [command, ...args] = added.slice(2)
  check(typeof command === 'string' && /node\.exe$/i.test(command) && existsSync(command), `${name}: registered command is node.exe: ${command}`)
  check(args.length > 0 && args.every((a) => existsSync(a)), `${name}: registered args are existing files: ${JSON.stringify(args)}`)

  if (command && existsSync(command)) {
    const { NODE_OPTIONS, ...plain } = env
    const started = await new Promise((done) => {
      const child = spawn(command, args, { env: plain, stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('error', (err) => done(`error: ${err.message}`))
      child.on('spawn', () => { setTimeout(() => { child.kill(); done('started') }, 2000) })
    })
    check(started === 'started', `${name}: the registered command spawns with no shell (${started})`)
  }

  const second = runInit()
  check(/MCP server: already registered/.test(second.stdout ?? ''), `${name}: re-running init reports already registered`)
}

await scenario('npm codex.cmd on PATH', (home) => {
  const bin = join(home, 'npm bin')
  mkdirSync(bin)
  npmStub(bin)
  return { stubDir: bin, extraPath: bin, binary: join(bin, 'codex.cmd') }
})

await scenario('Codex app binary, nothing on PATH', (home) => {
  const old = appStub(home, '0.99.0-x86_64-pc-windows-msvc')
  const dir = appStub(home, '0.160.0-x86_64-pc-windows-msvc')
  return { stubDir: dir, extraPath: null, binary: join(dir, 'codex.exe'), notUsed: old }
})

// L1 (audit of #1604): cmd.exe runs with /v:off, so `!OS!` in a path stays literal.
await scenario('npm codex.cmd under a path with !OS!', (home) => {
  const bin = join(home, 'npm bin')
  mkdirSync(bin)
  npmStub(bin)
  return { stubDir: bin, extraPath: bin, binary: join(bin, 'codex.cmd') }
}, { prefix: 'Test !OS! User-' })

// L1: `%OS%` would be expanded inside the quotes, so it is refused.
await scenario('npm codex.cmd under a path with %OS%', (home) => {
  const bin = join(home, 'npm bin')
  mkdirSync(bin)
  npmStub(bin)
  return { stubDir: bin, extraPath: bin, binary: join(bin, 'codex.cmd') }
}, { prefix: 'Test %OS% User-', expectRefused: true })

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\nall Codex checks passed')
