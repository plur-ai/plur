#!/usr/bin/env node
/**
 * Real Codex CLI on Windows (#1603). Run by .github/workflows/windows-init.yml
 * on windows-latest after `npm install -g @openai/codex`, which leaves the
 * same layout as a user's machine: `codex.cmd` plus npm's extensionless sh
 * shim `codex` in the npm global folder. Never run against a real home.
 *
 * In a fresh temporary HOME whose path contains a space:
 *   1. `plur init --codex` must report "registered via `codex mcp add` (<...codex.cmd>)";
 *   2. the real `codex mcp list` must list plur with node.exe and the MCP
 *      server's dist/index.js;
 *   3. that command must answer an MCP initialize request when started with
 *      no shell, as Codex starts it;
 *   4. `plur doctor --json` must report Codex detected and wired.
 *
 * Exits 1 when any check fails.
 */
import { mkdtempSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(repo, 'packages', 'cli', 'dist', 'index.js')
if (!existsSync(CLI)) { console.error(`built CLI not found at ${CLI}`); process.exit(1) }

const failures = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }
const cmd = (line, env) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60000 })

const home = mkdtempSync(join(tmpdir(), 'Test User-'))
mkdirSync(join(home, 'project'))
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '',
  CODEX_HOME: join(home, '.codex'), PLUR_PATH: join(home, '.plur'),
}
console.log(`HOME: ${home}`)

const where = cmd('where codex', env)
console.log('where codex:\n' + where.stdout)
check(/codex\.cmd\s*$/im.test(where.stdout ?? ''), 'npm installed codex.cmd on PATH')
console.log('codex --version: ' + (cmd('codex --version', env).stdout ?? '').trim())

// 1. init
const init = spawnSync(process.execPath, [CLI, 'init', '--global', '--no-desktop', '--no-opencode', '--no-cursor', '--no-antigravity', '--codex', '--no-prompt'], {
  cwd: join(home, 'project'), env, encoding: 'utf8', timeout: 180000,
})
console.log(init.stdout, init.stderr)
const used = /MCP server: registered via `codex mcp add` \(([^)]+)\)/.exec(init.stdout ?? '')
check(used !== null, 'init registered plur via `codex mcp add`')
check(Boolean(used && /codex\.cmd$/i.test(used[1])), `init names the binary it used: ${used?.[1]}`)

// 2. the real `codex mcp list`
function findPlur(value) {
  if (Array.isArray(value)) { for (const v of value) { const f = findPlur(v); if (f) return f } return null }
  if (value && typeof value === 'object') {
    if (value.name === 'plur') return value
    for (const v of Object.values(value)) { const f = findPlur(v); if (f) return f }
  }
  return null
}
function findLaunch(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.command === 'string' && Array.isArray(value.args)) return { command: value.command, args: value.args }
    for (const v of Object.values(value)) { const f = findLaunch(v); if (f) return f }
  }
  return null
}
const listJson = cmd('codex mcp list --json', env)
console.log('codex mcp list --json (exit ' + listJson.status + '):\n' + listJson.stdout + (listJson.stderr ?? ''))
let launch = null
try { launch = findLaunch(findPlur(JSON.parse(listJson.stdout))) } catch { /* not JSON — check the text form below */ }
if (!launch) {
  const listText = cmd('codex mcp list', env)
  console.log('codex mcp list (exit ' + listText.status + '):\n' + listText.stdout + (listText.stderr ?? ''))
  const line = (listText.stdout ?? '').split(/\r?\n/).find((l) => /^\s*plur\s/.test(l)) ?? ''
  check(/node\.exe/i.test(line) && /mcp[\\/]dist[\\/]index\.js/i.test(line), `codex mcp list shows plur with node.exe + mcp dist/index.js: ${line.trim()}`)
} else {
  check(/node\.exe$/i.test(launch.command) && launch.args.some((a) => /mcp[\\/]dist[\\/]index\.js$/i.test(a)),
    `codex mcp list shows plur with node.exe + mcp dist/index.js: ${launch.command} ${launch.args.join(' ')}`)
}

// 3. MCP handshake with the registered command, no shell
if (launch && existsSync(launch.command)) {
  const answer = await new Promise((done) => {
    const child = spawn(launch.command, launch.args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    const timer = setTimeout(() => { child.kill(); done('timeout after 90 s') }, 90000)
    child.on('error', (err) => { clearTimeout(timer); done(`error: ${err.message}`) })
    child.stdout.on('data', (d) => {
      buf += d
      for (const line of buf.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) { clearTimeout(timer); child.kill(); done(msg.result?.serverInfo ? `answered: ${JSON.stringify(msg.result.serverInfo)}` : `error reply: ${line}`) }
        } catch { /* partial line */ }
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'windows-ci', version: '0' } } }) + '\n')
  })
  check(answer.startsWith('answered'), `the registered command answers an MCP initialize (${answer})`)
} else {
  check(false, 'the registered command could not be read from `codex mcp list --json`, so the handshake was not run')
}

// 4. doctor
const doctor = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: join(home, 'project'), env, encoding: 'utf8', timeout: 300000 })
let report = null
try { report = JSON.parse(doctor.stdout) } catch { console.log(doctor.stdout, doctor.stderr) }
check(report?.codexDetected === true, 'plur doctor detects Codex')
check(report?.codexWired === true, 'plur doctor reports Codex wired')

if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1) }
console.log('\nall real-Codex checks passed')
