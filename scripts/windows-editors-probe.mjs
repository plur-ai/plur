#!/usr/bin/env node
/**
 * Real-editor probe (#1605, layer 1). Run by .github/workflows/windows-editors.yml
 * on windows-latest after the PR's PLUR build (stamped with a CI-only version)
 * and the editor CLIs are installed globally. Also runs on macOS/Linux for
 * development. It never touches a real home directory: it creates a temporary
 * HOME with a space in its path and points HOME, USERPROFILE, APPDATA,
 * LOCALAPPDATA, TEMP, PLUR_PATH and CODEX_HOME into it.
 *
 * No logins, no tokens, no model calls.
 *
 *   node scripts/windows-editors-probe.mjs --scenario <fresh|from-0.19.4|from-0.21.2>
 *
 * Scenarios:
 *   fresh         the PR build's `plur init --no-prompt`, run twice;
 *   from-<ver>    the published <ver> is installed globally and its own init
 *                 runs first; then the PR build is installed over it (from
 *                 PLUR_TARBALLS) and its init runs twice. This is the path an
 *                 existing user takes when upgrading.
 * In every scenario the user's own hooks and MCP entries are put in each
 * editor's config before any init, and must survive.
 *
 * Editors:
 *   - with a CLI: Claude Code (`claude`), Codex (`codex`), opencode
 *     (`opencode`), Cursor's agent CLI (PLUR_CURSOR_AGENT, else `agent` /
 *     `cursor-agent` on PATH). Each runs once before init, the way a first run
 *     creates its state folder, which is what `plur init` detects.
 *   - without a CLI: Claude Desktop and Antigravity. Their detection folder is
 *     created by hand and only the config file they read is checked. The
 *     Microsoft Store build of Claude Desktop reads another path, which init
 *     does not write: reported as not covered.
 *   - Cursor: its project `.cursor/` folder is created whether or not its CLI
 *     installed, so a failed CLI install skips only Cursor's listing check.
 *
 * Checks, per editor:
 *   (a) listing: the editor's own `mcp list` exits 0 and shows plur healthy:
 *       Claude Code "Connected", Codex "enabled", opencode "connected",
 *       Cursor "ready" after `agent mcp enable plur` (how a user approves an
 *       MCP server there), and `agent mcp list-tools plur` lists its tools.
 *       Claude Desktop and Antigravity: the config file holds the entry.
 *   (b) handshake: the exact registered MCP command, spawned with no shell,
 *       answers `initialize` with serverInfo.version = PLUR_CI_VERSION (this
 *       build, not a registry fallback) and `tools/list`; nothing but JSON-RPC
 *       on stdout; no `npx` or `@plur-ai/...@` spec in the entry. Cursor's
 *       entry keeps PLUR_TOOL_PROFILE=cursor and stays under Cursor's limit.
 *   (c) hooks: the registered PLUR hooks are exactly the expected set, by
 *       event (and matcher for Claude Code): a missing, extra or duplicate
 *       registration fails. Each hook command reports PLUR_CI_VERSION when run
 *       with --version in place of its subcommand. Every hook then runs,
 *       exactly as written, from a neutral folder (the temp HOME) with the
 *       folder under test given only in the payload, with that editor's
 *       recorded payloads (shapes from the CLI test suites, cited at
 *       PAYLOADS), in four folders:
 *         decided   (folders.yaml: plur on)      the seeded memory, no question
 *         undecided (no entry)                   the question, no memory
 *         off       (folders.yaml: plur off)     every hook silent, nothing
 *                                                written to the store
 *         team      (folders.yaml: scope group:) the scope, no question
 *       Every hook exits 0 and prints nothing or JSON. Each guard's verdict is
 *       read from its JSON: silent where memory is off or undecided; where it
 *       is on, at most one deny, and only the nudge to start the memory
 *       session; the next call allows.
 *   (d) doctor: `plur doctor --json` reports the editor wired, overall ok.
 *   (e) opencode plugin: the PR's @plur-ai/opencode (PLUR_TARBALLS) is
 *       installed into opencode's config folder and opencode is pointed at it;
 *       opencode must load it from there, and the plugin itself must inject in
 *       the decided folder, ask in the undecided one and do nothing in the off
 *       one.
 *   (f) idempotence: a second init changes no hook file or MCP entry.
 *   (g) the user's own entries are all still there.
 *   (h) Codex, deliberately unwired, is named by doctor.
 *
 * PLUR_EDITORS_REQUIRED (comma list of claude,codex,opencode,cursor) names the
 * CLIs whose absence is a failure; any other missing CLI is reported as "not
 * covered (reason)". Results go to stdout and, in GitHub Actions, to the job
 * summary. Exits 1 when any check fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, appendFileSync, realpathSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'

const WIN = process.platform === 'win32'
const argScenario = process.argv.indexOf('--scenario')
const SCENARIO = argScenario > 0 ? process.argv[argScenario + 1] : 'fresh'
const FROM = /^from-(\d+\.\d+\.\d+)$/.exec(SCENARIO)?.[1] ?? null
if (SCENARIO !== 'fresh' && !FROM) { console.error(`unknown scenario ${SCENARIO}`); process.exit(2) }
const required = new Set((process.env.PLUR_EDITORS_REQUIRED ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const CI_VERSION = process.env.PLUR_CI_VERSION || null
const CI_OPENCODE_VERSION = process.env.PLUR_CI_OPENCODE_VERSION || null
const TARBALLS = process.env.PLUR_TARBALLS || null
// Matches both queries the hooks recall with: a user prompt about deploys, and
// Cursor's session start, which recalls for 'general session start'.
const CODEWORD = 'Codeword ZEPHYRQUILL: at a general session start, fixture deploys go through the blue staging lane'
const SEEN = 'ZEPHYRQUILL'
const PROMPT = 'how do fixture deploys reach the blue staging lane'
const TEAM_SCOPE = 'group:ci/eng'
const QUESTION = /no decision for this folder yet/
const NUDGE = /plur_session_start/
const CURSOR_TOOL_LIMIT = 40
const RUN = `${process.pid}-${Date.now().toString(36)}`

// ── result bookkeeping ───────────────────────────────────────────────────────
const failures = []
const rows = {} // editor → column → text
const notCovered = [] // [what, reason]
const notes = []
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); return ok }
const cell = (editor, col, ok, note = '') => {
  rows[editor] ??= {}
  if ((rows[editor][col] ?? '').startsWith('✗')) return // red stays red
  rows[editor][col] = `${ok ? '✓' : '✗'}${note ? ` ${note}` : ''}`
}

// ── temp HOME ────────────────────────────────────────────────────────────────
// The long spelling (realpathSync.native expands Windows 8.3 names such as
// RUNNER~1): hooks see a folder in its canonical form, and folders.yaml
// entries are compared exactly as written, as `plur folders set` writes them.
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'Test User-')))
if (!/\s/.test(home)) { console.error(`temp HOME has no space: ${home}`); process.exit(1) }
const folders = Object.fromEntries(['decided', 'undecided', 'off', 'team'].map((k) => {
  const p = join(home, k === 'decided' ? 'project' : k)
  mkdirSync(join(p, '.git'), { recursive: true })
  return [k, p]
}))
const project = folders.decided
// Every hook runs from here: no .git, no folder-map entry. The folder under
// test reaches a hook only through its payload (H1).
const NEUTRAL = home
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  PLUR_PATH: join(home, '.plur'),
  // Codex (a native binary) finds its home through the OS profile API on
  // Windows, not USERPROFILE, so it is pointed here the documented way.
  // plur init honours CODEX_HOME too.
  CODEX_HOME: join(home, '.codex'),
  // Hook session state lives in the temp folder: keep it inside this run.
  TMPDIR: join(home, 'tmp'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
  // Deterministic, offline recall: BM25 only, no embedding model download.
  PLUR_HOOK_HYBRID: 'off', PLUR_DISABLE_EMBEDDINGS: '1',
  // Nothing outside the temp HOME decides where an editor keeps its config.
  XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '',
  OPENCODE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: '', CLAUDE_SESSION_ID: '', PLUR_DEBUG: '',
}
for (const k of Object.keys(env)) if (env[k] === '') delete env[k]
for (const d of [env.TMPDIR, env.CODEX_HOME, env.APPDATA, env.LOCALAPPDATA]) mkdirSync(d, { recursive: true })
console.log(`Scenario: ${SCENARIO}\nHOME: ${home}`)

/** Run a command found on PATH (`.cmd` shims on Windows need a shell, so an argument with a space is quoted there). */
function run(bin, args, opts = {}) {
  const argv = WIN ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
  const binArg = WIN && /\s/.test(bin) ? `"${bin}"` : bin
  const r = spawnSync(binArg, argv, { cwd: project, env, encoding: 'utf8', timeout: 180000, shell: WIN, ...opts })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readJsonc = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? ''))
const writeJson = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n') }
const tryRead = (fn) => { try { return fn() } catch { return undefined } }
function onPath(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', env })
  return r.status === 0 ? (r.stdout ?? '').split(/\r?\n/)[0].trim() : null
}
const globalRoot = run('npm', ['root', '-g']).stdout.trim()

function installPrBuild(label) {
  if (!TARBALLS) { check(false, `${label}: PLUR_TARBALLS is not set`); return false }
  const tgz = readdirSync(TARBALLS).filter((f) => /^plur-ai-(core|mcp|cli)-.*\.tgz$/.test(f)).map((f) => join(TARBALLS, f))
  const r = run('npm', ['install', '-g', '--no-audit', '--no-fund', ...tgz], { timeout: 600000 })
  let ok = check(r.status === 0, `${label}: npm install -g the PR build (exit ${r.status}) ${r.stderr.slice(-300)}`)
  // The CLI and the MCP server must use this build's core, installed beside them.
  for (const p of ['cli', 'mcp']) ok = check(!existsSync(join(globalRoot, '@plur-ai', p, 'node_modules', '@plur-ai', 'core')), `${label}: @plur-ai/${p} has no core of its own`) && ok
  return ok
}

// ── which editors are here ───────────────────────────────────────────────────
const cli = {
  claude: onPath('claude'),
  codex: onPath('codex'),
  opencode: onPath('opencode'),
  // The workflow names the installed binary instead of putting its folder on
  // PATH: that folder carries its own node.exe, which would shadow the runner's.
  cursor: process.env.PLUR_CURSOR_AGENT || (onPath('agent') ? 'agent' : onPath('cursor-agent') ? 'cursor-agent' : null),
}
const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', cursor: 'Cursor', desktop: 'Claude Desktop', agy: 'Antigravity' }
const ORDER = ['claude', 'codex', 'opencode', 'cursor', 'desktop', 'agy']
// Cursor's config and hooks are checked with or without its CLI.
const editors = ['claude', 'codex', 'opencode'].filter((k) => cli[k]).concat(['cursor', 'desktop', 'agy'])
for (const key of ['claude', 'codex', 'opencode', 'cursor']) {
  if (cli[key]) continue
  const reason = process.env[`PLUR_EDITOR_${key.toUpperCase()}_REASON`] || 'its CLI is not on PATH on this runner'
  if (required.has(key)) check(false, `${NAMES[key]}: CLI required but not installed (${reason})`)
  else notCovered.push([key === 'cursor' ? 'Cursor listing (`agent mcp list`)' : NAMES[key], reason])
}

// First run of each editor CLI: creates its state folder, as on a user's machine.
if (cli.claude) run('claude', ['mcp', 'list'])
if (cli.codex) run('codex', ['mcp', 'list'])
if (cli.opencode) run('opencode', ['mcp', 'list'])
if (cli.cursor) run(cli.cursor, ['--version'])
mkdirSync(join(project, '.cursor'), { recursive: true })
// No CLI: create what the installed app would have.
const desktopConfig = join(WIN ? env.APPDATA : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'), 'Claude', 'claude_desktop_config.json')
writeJson(desktopConfig, {})
mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
if (WIN) notCovered.push(['Claude Desktop, Microsoft Store build', 'it reads %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\, which plur init does not write'])

// ── the user's own entries, before any init (g) ──────────────────────────────
const USER_CMD = 'echo user-own-hook'
const opencodeDir = join(home, '.config', 'opencode')
const opencodeConfig = () => ['opencode.json', 'opencode.jsonc'].map((f) => join(opencodeDir, f)).find(existsSync) ?? join(opencodeDir, 'opencode.json')
const claudeUserConfig = join(home, '.claude.json')
const USER = {
  'Claude Code settings.json hook': {
    put: () => writeJson(join(home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: USER_CMD }] }] } }),
    has: () => readJson(join(home, '.claude', 'settings.json')).hooks.PreToolUse.some((e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command === USER_CMD)),
  },
  'Claude Code ~/.claude.json MCP server': {
    put: () => { const j = tryRead(() => readJson(claudeUserConfig)) ?? {}; j.mcpServers = { ...(j.mcpServers ?? {}), 'user-own': { type: 'stdio', command: 'user-own-server', args: [] } }; writeJson(claudeUserConfig, j) },
    has: () => readJson(claudeUserConfig).mcpServers['user-own'].command === 'user-own-server',
  },
  'Codex config.toml MCP server': {
    put: () => appendFileSync(join(env.CODEX_HOME, 'config.toml'), '\n[mcp_servers.user-own]\ncommand = "user-own-server"\n'),
    has: () => /\[mcp_servers\.user-own\]\s*\ncommand = "user-own-server"/.test(readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8')),
  },
  'Codex hooks.json hook': {
    put: () => writeJson(join(env.CODEX_HOME, 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_CMD }] }] } }),
    has: () => readJson(join(env.CODEX_HOME, 'hooks.json')).hooks.Stop.some((e) => e.hooks.some((h) => h.command === USER_CMD)),
  },
  'Cursor .cursor/mcp.json server': {
    put: () => writeJson(join(project, '.cursor', 'mcp.json'), { mcpServers: { 'user-own': { command: 'user-own-server' } } }),
    has: () => readJson(join(project, '.cursor', 'mcp.json')).mcpServers['user-own'].command === 'user-own-server',
  },
  'Cursor .cursor/hooks.json hook': {
    put: () => writeJson(join(project, '.cursor', 'hooks.json'), { version: 1, hooks: { stop: [{ command: USER_CMD }] } }),
    has: () => readJson(join(project, '.cursor', 'hooks.json')).hooks.stop.some((h) => h.command === USER_CMD),
  },
  'opencode MCP server': {
    put: () => { const p = opencodeConfig(); const j = tryRead(() => readJsonc(p)) ?? { $schema: 'https://opencode.ai/config.json' }; j.mcp = { ...(j.mcp ?? {}), 'user-own': { type: 'local', command: ['user-own-server'], enabled: false } }; writeJson(p, j) },
    has: () => readJsonc(opencodeConfig()).mcp['user-own'].command[0] === 'user-own-server',
  },
  'Claude Desktop MCP server': {
    put: () => writeJson(desktopConfig, { mcpServers: { 'user-own': { command: 'user-own-server' } } }),
    has: () => readJson(desktopConfig).mcpServers['user-own'].command === 'user-own-server',
  },
  'Antigravity MCP server': {
    put: () => writeJson(join(home, '.gemini', 'config', 'mcp_config.json'), { mcpServers: { 'user-own': { command: 'user-own-server' } } }),
    has: () => readJson(join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers['user-own'].command === 'user-own-server',
  },
  'Antigravity hook set': {
    put: () => writeJson(join(home, '.gemini', 'config', 'hooks.json'), { 'user-own': { enabled: true, Stop: [{ type: 'command', command: USER_CMD }] } }),
    has: () => readJson(join(home, '.gemini', 'config', 'hooks.json'))['user-own'].Stop.some((h) => h.command === USER_CMD),
  },
}
for (const [, u] of Object.entries(USER)) u.put()

// ── init (and the published version's init first, when upgrading) ────────────
const plurInit = (label) => {
  const r = run('plur', ['init', '--no-prompt'])
  console.log(`\n=== ${label}: plur init --no-prompt (exit ${r.status}) ===\n${r.stdout}${r.stderr}`)
  return r
}
if (FROM) {
  console.log(`\n=== upgrade: published ${FROM} first ===`)
  const r = run('npm', ['install', '-g', '--no-audit', '--no-fund', `@plur-ai/cli@${FROM}`, `@plur-ai/mcp@${FROM}`], { timeout: 600000 })
  check(r.status === 0, `install the published @plur-ai/cli@${FROM} and @plur-ai/mcp@${FROM} (exit ${r.status})`)
  const v = run('plur', ['--version']).stdout.trim()
  check(v.includes(FROM), `the published plur is the one on PATH (${v})`)
  const old = plurInit(`published ${FROM}`)
  notes.push(`published ${FROM}'s own init exited ${old.status}`)
  if (!installPrBuild('upgrade')) process.exit(1)
}
const plurBin = onPath('plur')
if (!check(!!plurBin, `plur is installed globally (${plurBin ?? 'not on PATH'})`)) process.exit(1)
const plurVersion = run('plur', ['--version']).stdout.trim()
if (CI_VERSION) check(plurVersion.includes(CI_VERSION), `plur on PATH is this build: ${plurVersion} (expected ${CI_VERSION})`)

const init1 = plurInit('PR build')
check(init1.status === 0, `plur init --no-prompt exits 0 (exit ${init1.status})`)

// What a second init must leave unchanged (f).
const opencodePlur = () => { const j = tryRead(() => readJsonc(opencodeConfig())); return j && { plugin: j.plugin, mcp: j.mcp?.plur } }
const SNAP = {
  'Claude Code hooks': () => readJson(join(home, '.claude', 'settings.json')).hooks,
  'Claude Code MCP entry': () => readJson(claudeUserConfig).mcpServers?.plur,
  'Codex hooks': () => readJson(join(env.CODEX_HOME, 'hooks.json')),
  'Codex config.toml': () => readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8'),
  'Cursor hooks': () => readJson(join(project, '.cursor', 'hooks.json')),
  'Cursor MCP entry': () => readJson(join(project, '.cursor', 'mcp.json')),
  'Antigravity hooks': () => readJson(join(home, '.gemini', 'config', 'hooks.json')),
  'Antigravity MCP entry': () => readJson(join(home, '.gemini', 'config', 'mcp_config.json')),
  'Claude Desktop MCP entry': () => readJson(desktopConfig),
  'opencode plugin and MCP entry': opencodePlur,
}
const snapshot = () => Object.fromEntries(Object.entries(SNAP).map(([k, f]) => [k, JSON.stringify(tryRead(f) ?? null)]))
const before = snapshot()
const init2 = plurInit('PR build, second run')
check(init2.status === 0, `a second plur init exits 0 (exit ${init2.status})`)
const after = snapshot()
let idempotent = true
for (const k of Object.keys(SNAP)) idempotent = check(before[k] === after[k], `second init leaves ${k} unchanged`) && idempotent

// ── (a) listing ──────────────────────────────────────────────────────────────
console.log('\n=== (a) each editor lists plur, healthy ===')
const configs = {
  claude: () => readJson(claudeUserConfig).mcpServers?.plur,
  codex: () => {
    const r = run('codex', ['mcp', 'get', 'plur', '--json'])
    const t = JSON.parse(r.stdout).transport
    return { command: t.command, args: t.args ?? [], env: t.env ?? undefined }
  },
  opencode: () => {
    const e = readJsonc(opencodeConfig()).mcp?.plur
    return e && { command: e.command[0], args: e.command.slice(1), env: e.environment }
  },
  cursor: () => readJson(join(project, '.cursor', 'mcp.json')).mcpServers?.plur,
  desktop: () => readJson(desktopConfig).mcpServers?.plur,
  agy: () => readJson(join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers?.plur,
}
// The plur row must say healthy; anything else on it (needs approval,
// disabled, disconnected, failed, error) fails.
const listings = {
  claude: [['mcp', 'list'], (out) => /^plur:.*[✓✔√] Connected\s*$/m.test(out)],
  codex: [['mcp', 'list'], (out) => /^plur\s.*\benabled\b/m.test(out) && !/^plur\s.*\bdisabled\b/m.test(out)],
  opencode: [['mcp', 'list', '--print-logs'], (out) => /[✓✔√]\s*plur\s+connected\b/m.test(out)],
  cursor: [['mcp', 'list'], (out) => /^plur:\s*ready\s*$/m.test(out)],
}
for (const key of editors) {
  const name = NAMES[key]
  if (key === 'cursor' && cli.cursor) {
    // A Cursor user approves a new MCP server once; `mcp enable` is that step.
    const en = run(cli.cursor, ['mcp', 'enable', 'plur'])
    check(en.status === 0, `Cursor: \`agent mcp enable plur\` approves the entry (exit ${en.status}) ${strip(en.stdout + en.stderr).trim().slice(0, 200)}`)
  }
  if (listings[key] && cli[key]) {
    const [args, ok] = listings[key]
    const r = run(key === 'cursor' ? cli.cursor : key, args, { timeout: 300000 })
    const out = strip(r.stdout)
    console.log(`--- ${key} ${args.join(' ')} (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})\n${out.trim().slice(-2000)}\n${strip(r.stderr).trim().slice(-1500)}`)
    const short = key === 'cursor' ? 'agent' : key
    // Judged on stdout only: opencode's --print-logs goes to stderr.
    cell(key, 'listing', check(r.status === 0 && !r.error && ok(out), `${name}: \`${short} ${args.join(' ')}\` exits 0 and shows plur healthy`), `\`${short} mcp list\``)
    if (key === 'cursor') {
      const t = run(cli.cursor, ['mcp', 'list-tools', 'plur'], { timeout: 300000 })
      const n = Number(/Tools for plur \((\d+)\)/.exec(strip(t.stdout))?.[1] ?? 0)
      cell(key, 'listing', check(t.status === 0 && n > 0 && n <= CURSOR_TOOL_LIMIT, `Cursor launched plur itself: \`agent mcp list-tools plur\` lists ${n} tools (1..${CURSOR_TOOL_LIMIT}) ${n ? '' : strip(t.stdout + t.stderr).slice(0, 300)}`))
    }
  } else if (!listings[key]) {
    const entry = tryRead(configs[key])
    cell(key, 'listing', check(!!entry?.command, `${name}: its config file holds the plur entry`), 'config file')
  }
}

// ── (b) MCP handshake with the registered command ────────────────────────────
console.log('\n=== (b) the registered MCP command completes a handshake with this build ===')
function handshake(entry) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(entry.command, entry.args ?? [], { cwd: NEUTRAL, env: { ...env, ...(entry.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) { resolve({ ok: false, error: err.message }); return }
    let buf = ''
    let err = ''
    let init = null
    const done = (res) => { clearTimeout(timer); try { child.kill() } catch { /* gone */ } resolve(res) }
    const timer = setTimeout(() => done({ ok: false, error: `timeout; stderr: ${err.slice(-300)}` }), 120000)
    child.on('error', (e) => done({ ok: false, error: e.message }))
    child.on('exit', (code) => done({ ok: false, error: `exited ${code}; stderr: ${err.slice(-300)}` }))
    child.stderr.on('data', (d) => { err += d })
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        // A real MCP client reads stdout as JSON-RPC only: anything else breaks it.
        try { msg = JSON.parse(line) } catch { done({ ok: false, error: `non-JSON on stdout: ${line.slice(0, 200)}` }); return }
        if (msg.id === 1 && msg.result?.serverInfo) {
          init = msg.result.serverInfo
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
        } else if (msg.id === 2) {
          done({ ok: Array.isArray(msg.result?.tools) && msg.result.tools.length > 0, server: init, tools: msg.result?.tools?.length ?? 0 })
        } else if (msg.error) {
          done({ ok: false, error: JSON.stringify(msg.error) })
        }
      }
    })
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plur-ci-probe', version: '1.0.0' } },
    }) + '\n')
  })
}
for (const key of editors) {
  const name = NAMES[key]
  let entry = null
  try { entry = configs[key]() } catch (e) { console.log(`${name}: could not read the registered entry: ${e.message}`) }
  if (!entry?.command) { cell(key, 'handshake', check(false, `${name}: no registered plur MCP entry to launch`)); continue }
  const argv = [entry.command, ...(entry.args ?? [])]
  console.log(`${name}: ${JSON.stringify(argv)}`)
  check(!argv.some((a) => /(^|[\\/\s])npx(\.cmd)?$|^npx$|@plur-ai\/[a-z-]+@/.test(a)), `${name}: the MCP entry runs the installed build (no npx, no registry spec)`) || cell(key, 'handshake', false)
  if (key === 'cursor') check(entry.env?.PLUR_TOOL_PROFILE === 'cursor', `Cursor: its MCP entry keeps PLUR_TOOL_PROFILE=cursor (${JSON.stringify(entry.env ?? {})})`) || cell(key, 'handshake', false)
  const r = await handshake(entry)
  let ok = check(r.ok, `${name}: registered command answers initialize + tools/list (${r.ok ? `${r.server?.name} ${r.server?.version}, ${r.tools} tools` : r.error})`)
  if (ok && CI_VERSION) ok = check(r.server?.version === CI_VERSION, `${name}: the server is this build (serverInfo.version ${r.server?.version}, expected ${CI_VERSION})`)
  if (ok && key === 'cursor') ok = check(r.tools <= CURSOR_TOOL_LIMIT, `Cursor: ${r.tools} tools, within Cursor's ${CURSOR_TOOL_LIMIT}`)
  cell(key, 'handshake', ok, ok ? `${r.tools} tools, ${r.server?.version}` : '')
}

// ── (c) hooks ────────────────────────────────────────────────────────────────
console.log('\n=== (c) hooks: the expected set, this build, recorded payloads, four folders ===')
const seed = run('plur', ['learn', CODEWORD, '--json'])
check(seed.status === 0, `seed one memory (exit ${seed.status}) ${seed.stderr.slice(0, 200)}`)
// Test fixture, not a user's config: the folder decisions for this run.
const q = (p) => JSON.stringify(p)
writeFileSync(join(env.PLUR_PATH, 'folders.yaml'), [
  'version: 1', 'folders:',
  `  - path: ${q(folders.decided)}`, '    plur: on',
  `  - path: ${q(folders.off)}`, '    plur: off',
  `  - path: ${q(folders.team)}`, `    scope: ${TEAM_SCOPE}`,
  '',
].join('\n'))

const hookFiles = {
  claude: join(home, '.claude', 'settings.json'),
  codex: join(env.CODEX_HOME, 'hooks.json'),
  cursor: join(project, '.cursor', 'hooks.json'),
  agy: join(home, '.gemini', 'config', 'hooks.json'),
}
/** "hook-inject --event skill" from a hook's command string or exec args; null when it is not a PLUR hook. */
function keyOf(h) {
  const words = Array.isArray(h.args) ? h.args : h.command.split(/\s+/)
  const i = words.findIndex((w) => /^hook-[a-z0-9-]+$/.test(w))
  return i < 0 ? null : words.slice(i).join(' ')
}
/** Every hook in an editor's hooks file as { event, matcher, command, args }. */
function registered(key) {
  const out = []
  const push = (event, matcher, h) => out.push({ event, matcher: matcher ?? null, command: h.command, args: h.args })
  if (key === 'claude' || key === 'codex') {
    for (const [event, entries] of Object.entries(readJson(hookFiles[key]).hooks ?? {})) for (const e of entries) for (const h of e.hooks ?? []) push(event, key === 'claude' ? e.matcher : null, h)
  } else if (key === 'cursor') {
    for (const [event, hs] of Object.entries(readJson(hookFiles[key]).hooks ?? {})) for (const h of hs) push(event, null, h)
  } else {
    for (const set of Object.values(readJson(hookFiles[key]))) {
      if (!set || typeof set !== 'object') continue
      for (const [event, entries] of Object.entries(set)) {
        if (!Array.isArray(entries)) continue
        for (const e of entries) { if (Array.isArray(e.hooks)) for (const h of e.hooks) push(event, null, h); else if (e.command) push(event, null, e) }
      }
    }
  }
  return out
}
/**
 * The PLUR hooks each editor must have, by event (and matcher for Claude
 * Code, where the matcher decides whether a hook fires at all).
 */
const EXPECTED = {
  claude: [
    ['SessionStart', null, 'hook-session-remind'], ['SessionStart', 'resume', 'hook-session-resume'], ['SessionStart', 'compact', 'hook-inject --rehydrate'],
    ['SessionEnd', null, 'hook-session-end'],
    ['PreToolUse', '*', 'hook-session-guard'], ['PreToolUse', 'EnterPlanMode', 'hook-inject --event plan_mode'], ['PreToolUse', 'Skill', 'hook-inject --event skill'],
    ['PreToolUse', 'Agent', 'hook-inject --event agent'], ['PreToolUse', 'Bash|Edit|Write|Agent', 'hook-observe'],
    ['PostToolUse', 'mcp__.*__plur_session_start', 'hook-session-mark'], ['PostToolUse', 'Bash|Edit|Write|Agent', 'hook-observe --post'],
    ['UserPromptSubmit', null, 'hook-inject'], ['SubagentStart', '.*', 'hook-inject --event subagent'],
    ['Stop', '*', 'hook-learn-check'], ['Stop', '*', 'hook-auto-rate claude'],
  ],
  codex: [
    ['SessionStart', null, 'hook-codex-session-start'], ['UserPromptSubmit', null, 'hook-codex-inject'], ['PreToolUse', null, 'hook-codex-guard'],
    ['PostToolUse', null, 'hook-codex-post-tool'], ['Stop', null, 'hook-auto-rate codex'], ['SessionEnd', null, 'hook-codex-session-end'],
  ],
  cursor: [
    ['sessionStart', null, 'hook-cursor-session-start'], ['preToolUse', null, 'hook-cursor-guard'], ['postToolUse', null, 'hook-cursor-post-tool'],
    ['stop', null, 'hook-cursor-stop'], ['afterAgentResponse', null, 'hook-auto-rate cursor'],
  ],
  agy: [['PreInvocation', null, 'hook-agy-pre-invocation'], ['PreToolUse', null, 'hook-agy-guard'], ['Stop', null, 'hook-auto-rate agy']],
}
const sig = (e, m, k) => `${e} [${m ?? '-'}] ${k}`

/**
 * Recorded payloads per editor, in the order an editor session fires them.
 * Shapes are the ones the CLI suites drive each hook with:
 *   Claude Code — test/hook-folder-map.test.ts, test/hook-folder-golden.test.ts
 *     (session-remind, session-resume, inject, session-guard, observe,
 *     learn-check, session-end); test/hook-inject-output.test.ts (--rehydrate,
 *     --event plan_mode|skill|agent|subagent); test/hook-auto-rate.test.ts
 *     (auto-rate claude); test/formal-r2-cli-session-dir.test.ts (session-mark).
 *   Codex — test/hook-folder-map.test.ts (session-start, inject, guard,
 *     post-tool, session-end); test/hook-auto-rate.test.ts (auto-rate codex).
 *   Cursor — test/hook-cursor-workspace-roots.test.ts (the recorded shape: no
 *     cwd, workspace_roots only); tool and stop fields from
 *     test/hook-folder-map.test.ts and test/hook-auto-rate.test.ts.
 *   Antigravity — test/hook-folder-map.test.ts, test/hook-folder-golden.test.ts
 *     (pre-invocation with a transcript, guard); test/hook-auto-rate.test.ts.
 * Guards run twice: the first call may nudge, the second must allow.
 */
function transcript(text) {
  const p = join(home, 'tmp', `agy-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(p, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` }) + '\n')
  return p
}
const PAYLOADS = {
  claude: (sid, cwd) => {
    const cc = { session_id: sid, cwd }
    return [
      ['hook-session-remind', { ...cc, hook_event_name: 'SessionStart' }],
      ['hook-inject', { ...cc, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }],
      ['hook-session-guard', { ...cc, tool_name: 'Bash' }],
      ['hook-session-guard', { ...cc, tool_name: 'Bash' }],
      ['hook-inject --event plan_mode', { ...cc, hook_event_name: 'PreToolUse', tool_name: 'EnterPlanMode', prompt: PROMPT }],
      ['hook-inject --event skill', { ...cc, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'fixture-deploys' } }],
      ['hook-inject --event agent', { ...cc, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fixture-deploys', prompt: PROMPT } }],
      ['hook-observe', { ...cc, tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['hook-session-mark', { session_id: sid }],
      ['hook-observe --post', { ...cc, tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['hook-inject --event subagent', { ...cc, hook_event_name: 'SubagentStart', agent_type: 'fixture-deploys', tool_input: { description: PROMPT } }],
      ['hook-learn-check', cc],
      ['hook-auto-rate claude', { ...cc, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' }],
      // Later in the session: a compaction, then `claude --resume` (each hook's matcher).
      ['hook-inject --rehydrate', { ...cc, hook_event_name: 'SessionStart', source: 'compact' }],
      ['hook-session-resume', { ...cc, hook_event_name: 'SessionStart', source: 'resume' }],
      ['hook-session-end', { ...cc, reason: 'other' }],
    ]
  },
  codex: (sid, cwd) => {
    const cx = { session_id: sid, cwd }
    return [
      ['hook-codex-session-start', { ...cx, hook_event_name: 'SessionStart', source: 'startup' }],
      ['hook-codex-inject', { ...cx, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }],
      ['hook-codex-guard', { ...cx, tool_name: 'shell' }],
      ['hook-codex-guard', { ...cx, tool_name: 'shell' }],
      ['hook-codex-post-tool', { ...cx, tool_name: 'shell' }],
      ['hook-auto-rate codex', { ...cx, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' }],
      ['hook-codex-session-end', { ...cx, hook_event_name: 'SessionEnd' }],
    ]
  },
  cursor: (sid, cwd) => {
    const p = (event, extra = {}) => ({ conversation_id: sid, hook_event_name: event, workspace_roots: [cwd], transcript_path: null, ...extra })
    return [
      ['hook-cursor-session-start', p('sessionStart')],
      ['hook-cursor-guard', p('preToolUse', { tool_name: 'Shell' })],
      ['hook-cursor-guard', p('preToolUse', { tool_name: 'Shell' })],
      ['hook-cursor-post-tool', p('postToolUse', { tool_name: 'Shell' })],
      ['hook-cursor-stop', p('stop', { status: 'completed' })],
      ['hook-auto-rate cursor', p('afterAgentResponse', { generation_id: 'g', text: 'Done.' })],
    ]
  },
  agy: (sid, cwd) => {
    const t = transcript(PROMPT)
    return [
      ['hook-agy-pre-invocation', { conversationId: sid, invocationNum: 0, workspacePaths: [cwd], transcriptPath: t }],
      ['hook-agy-guard', { conversationId: sid, workspacePaths: [cwd], toolCall: { name: 'run_command' } }],
      ['hook-agy-guard', { conversationId: sid, workspacePaths: [cwd], toolCall: { name: 'run_command' } }],
      ['hook-auto-rate agy', { conversationId: sid, transcriptPath: t, workspacePaths: [cwd], executionNum: 1, terminationReason: 'model_stop' }],
    ]
  },
}
// The hook each folder state is judged on. Codex reports the folder's scope
// at session start (its prompt hook carries only the recalled memories).
const MAIN = {
  claude: { decided: 'hook-inject', undecided: 'hook-inject', off: 'hook-inject', team: 'hook-inject' },
  codex: { decided: 'hook-codex-inject', undecided: 'hook-codex-inject', off: 'hook-codex-inject', team: 'hook-codex-session-start' },
  cursor: { decided: 'hook-cursor-session-start', undecided: 'hook-cursor-session-start', off: 'hook-cursor-session-start', team: 'hook-cursor-session-start' },
  agy: { decided: 'hook-agy-pre-invocation', undecided: 'hook-agy-pre-invocation', off: 'hook-agy-pre-invocation', team: 'hook-agy-pre-invocation' },
}
const GUARD = { claude: 'hook-session-guard', codex: 'hook-codex-guard', cursor: 'hook-cursor-guard', agy: 'hook-agy-guard' }
/** What must and must not appear in the main hook's context, per folder state. */
const EXPECT = {
  decided: (ctx) => (!ctx.includes(SEEN) ? 'the seeded memory is not injected' : QUESTION.test(ctx) ? 'the folder question is asked in a decided folder' : true),
  undecided: (ctx) => (!QUESTION.test(ctx) ? 'the folder question is not asked' : ctx.includes(SEEN) ? 'memory is injected before the folder is decided' : true),
  off: (_ctx, raw) => raw === '' || 'not silent',
  team: (ctx) => (!ctx.includes(TEAM_SCOPE) ? `scope ${TEAM_SCOPE} not reported` : QUESTION.test(ctx) ? 'the folder question is asked in a decided folder' : true),
}
/** The text a hook hands the model: only the fields editors read, never the raw JSON. */
function contextOf(stdout) {
  if (!stdout) return ''
  try {
    const j = JSON.parse(stdout)
    return [j.hookSpecificOutput?.additionalContext, j.additional_context, j.additionalContext, j.systemMessage, j.followup_message,
      ...(j.injectSteps ?? []).map((s) => s?.ephemeralMessage)].filter((x) => typeof x === 'string').join('\n')
  } catch { return '' }
}
/** A guard's verdict from its JSON: 'deny' with its reason, or 'allow'. */
function verdictOf(stdout) {
  if (!stdout) return { deny: false }
  const j = JSON.parse(stdout)
  const deny = j.hookSpecificOutput?.permissionDecision === 'deny' || j.permissionDecision === 'deny' || j.permission === 'deny' ||
    j.decision === 'block' || j.decision === 'deny' || j.continue === false
  const reason = [j.hookSpecificOutput?.permissionDecisionReason, j.permissionDecisionReason, j.reason, j.user_message, j.agent_message, j.stopReason].filter(Boolean).join(' ')
  return { deny, reason }
}
/** Files under the PLUR store, with size and time: a write shows as a change. */
function storeState() {
  const out = {}
  const walk = (d) => { for (const f of tryRead(() => readdirSync(d)) ?? []) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p.slice(env.PLUR_PATH.length)] = `${s.size}:${s.mtimeMs}` } }
  walk(env.PLUR_PATH)
  return out
}
const diffState = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync) ?? 'bash'
/** Spawn a hook as its editor does, from the neutral folder: exec form with no shell; a string through the editor's shell. */
function runHook(editor, h, payload, replaceSub = null) {
  const opts = { cwd: NEUTRAL, env, input: payload === null ? '' : JSON.stringify(payload), encoding: 'utf8', timeout: 60000 }
  let command = h.command
  let args = h.args
  if (replaceSub) {
    if (Array.isArray(args)) { const i = args.findIndex((w) => /^hook-/.test(w)); args = [...args.slice(0, i), replaceSub] }
    else command = command.replace(/\s+hook-[a-z0-9-]+(\s.*)?$/, ` ${replaceSub}`)
  }
  let r
  if (Array.isArray(args)) r = spawnSync(command, args, opts)
  else if (!WIN) r = spawnSync('/bin/sh', ['-c', command], opts)
  // Claude Code runs string hooks through Git Bash on Windows; Codex and Cursor
  // through PowerShell (init's fallback form is PowerShell's `& "<path>"`), and
  // so does this probe for Antigravity. Every hook string through bash, pwsh
  // AND cmd is the windows-init-hooks job (scripts/windows-hook-probe.mjs).
  else if (editor === 'claude') r = spawnSync(gitBash, ['-c', command], opts)
  else r = spawnSync('pwsh', ['-NoProfile', '-Command', command], opts)
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', error: r.error?.message }
}

for (const key of ['claude', 'codex', 'cursor', 'agy']) {
  if (!editors.includes(key)) continue
  const name = NAMES[key]
  let all = []
  try { all = registered(key) } catch (e) { console.log(`${name}: hooks file unreadable: ${e.message}`) }
  const plurHooks = all.filter((h) => h.command !== USER_CMD)
  // H2/M4: exactly the expected registrations — by event (and matcher), none missing, extra or twice.
  const want = EXPECTED[key].map(([e, m, k]) => sig(e, m, k)).sort()
  const got = plurHooks.map((h) => sig(h.event, key === 'claude' ? h.matcher : null, keyOf(h) ?? `(not a PLUR hook: ${h.command})`)).sort()
  const missing = want.filter((w) => !got.includes(w))
  const extra = got.filter((g) => !want.includes(g))
  const twice = got.filter((g, i) => got.indexOf(g) !== i)
  let ok = check(missing.length === 0 && extra.length === 0 && twice.length === 0,
    `${name}: registered PLUR hooks are exactly the expected ${want.length}${missing.length ? `; missing: ${missing.join(', ')}` : ''}${extra.length ? `; unexpected: ${extra.join(', ')}` : ''}${twice.length ? `; registered twice: ${twice.join(', ')}` : ''}`)
  const byKey = new Map(plurHooks.map((h) => [keyOf(h), h]))
  // M1: every hook command is this build.
  if (CI_VERSION) {
    for (const [k, h] of byKey) {
      if (!k) continue
      const r = runHook(key, h, null, '--version')
      ok = check(r.stdout.includes(CI_VERSION), `${name}: \`${k}\` runs this build (--version: ${r.stdout.slice(0, 80) || r.stderr.slice(0, 120)})`) && ok
    }
  }
  let runs = 0
  for (const [state, folder] of Object.entries(folders)) {
    const sid = `ci-${key}-${state}-${RUN}`
    const storeBefore = state === 'off' ? storeState() : null
    let guardCalls = 0
    for (const [k, payload] of PAYLOADS[key](sid, folder)) {
      const h = byKey.get(k)
      if (!h) continue // reported above as missing
      runs++
      const r = runHook(key, h, payload)
      const label = `${name} [${state}] ${k}`
      let problem = null
      if (r.error || r.status !== 0) problem = `exit ${r.status}${r.error ? ` (${r.error})` : ''}: ${r.stderr.slice(0, 300)}`
      else if (r.stdout !== '') { try { JSON.parse(r.stdout) } catch { problem = `stdout is not JSON: ${r.stdout.slice(0, 200)}` } }
      // Off is silent. hook-observe passes its input through: that is the hook contract, not output.
      if (!problem && state === 'off' && r.stdout !== '' && !(k.startsWith('hook-observe') && r.stdout === JSON.stringify(payload))) problem = `not silent: ${r.stdout.slice(0, 200)}`
      if (!problem && k === GUARD[key]) {
        guardCalls++
        const v = verdictOf(r.stdout)
        if (state === 'off' || state === 'undecided') { if (r.stdout !== '') problem = `the guard speaks where memory is ${state}: ${r.stdout.slice(0, 200)}` }
        else if (v.deny && guardCalls > 1) problem = `the guard denies again after its one nudge: ${r.stdout.slice(0, 200)}`
        else if (v.deny && !NUDGE.test(v.reason)) problem = `the guard denies for another reason: ${r.stdout.slice(0, 200)}`
      }
      const judged = k === MAIN[key][state] && !(k === GUARD[key])
      if (!problem && judged) {
        const verdict = EXPECT[state](contextOf(r.stdout), r.stdout)
        if (verdict !== true) problem = `${verdict}: ${r.stdout.slice(0, 300)}`
      }
      if (problem) { check(false, `${label}: ${problem}`); ok = false }
      else if (judged) console.log(`PASS  ${label} (${{ decided: 'memory injected, no question', undecided: 'asks, no memory', off: 'silent', team: 'scope reported, no question' }[state]})`)
    }
    if (state === 'off') {
      const changed = diffState(storeBefore, storeState())
      ok = check(changed.length === 0, `${name} [off]: nothing written to the PLUR store${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`) && ok
      if (key === 'cursor') ok = check(!existsSync(join(folders.off, '.cursor', 'rules', 'plur-context.mdc')), 'Cursor [off]: no context rule written into the off folder') && ok
    }
  }
  cell(key, 'hooks', ok, `${byKey.size} hooks × 4 folders (${runs} runs)`)
}
rows.desktop ??= {}; rows.desktop.hooks = 'n/a (no hooks)'

// ── (d) doctor ───────────────────────────────────────────────────────────────
console.log('\n=== (d) plur doctor reports every installed editor as wired ===')
function doctorJson() {
  const r = run('plur', ['doctor', '--json'])
  try { return JSON.parse(r.stdout) } catch { console.log(`doctor output was not JSON: ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 500)}`); return null }
}
const rep = doctorJson()
if (check(!!rep, 'plur doctor --json answers')) {
  const cfg = (label) => (rep.configs ?? []).find((c) => c.label === label)
  check(rep.overall === 'ok', `doctor: overall ${rep.overall}`)
  check(rep.handshake?.ok === true && (!CI_VERSION || rep.handshake?.serverVersion === CI_VERSION), `doctor: MCP handshake ok with this build (${rep.handshake?.serverVersion ?? rep.handshake?.error})`)
  check((rep.cursorHandshake?.toolCount ?? 0) > 0 && rep.cursorHandshake.toolCount <= CURSOR_TOOL_LIMIT, `doctor: Cursor's tool profile has ${rep.cursorHandshake?.toolCount} tools (1..${CURSOR_TOOL_LIMIT})`)
  const wired = {
    claude: rep.claudeCodeMcp?.registered === true && cfg('Claude Code (global)')?.hasPlurHooks === true,
    desktop: cfg('Claude Desktop')?.hasPlurMcp === true,
    cursor: rep.cursorProjectDetected === true && rep.cursorWired === true,
    codex: rep.codexDetected === true && rep.codexWired === true,
    agy: rep.agyDetected === true && rep.agyWired === true,
    opencode: !!rep.opencode && rep.opencode.ok && rep.opencode.pluginDeclared && rep.opencode.mcpPlurDeclared && rep.opencode.mcpPlurMissingPaths.length === 0,
  }
  for (const key of editors) cell(key, 'doctor', check(wired[key], `doctor: ${NAMES[key]} wired`))
  if (editors.includes('opencode')) cell('opencode', 'doctor', check(rep.opencode?.pluginResolvable === 'yes', `doctor: the declared @plur-ai/opencode resolves (${rep.opencode?.pluginResolvable}, ${rep.opencode?.resolvedVia})`))
}

// ── (e) opencode: the PR's plugin, loaded by opencode and exercised ──────────
if (editors.includes('opencode')) {
  console.log("\n=== (e) opencode loads this PR's plugin, which injects / asks / stays silent ===")
  let ok = false
  const tgz = TARBALLS ? readdirSync(TARBALLS).filter((f) => /^plur-ai-(core|opencode)-.*\.tgz$/.test(f)).map((f) => join(TARBALLS, f)) : []
  if (check(tgz.length === 2, `the PR's @plur-ai/core and @plur-ai/opencode tarballs are in PLUR_TARBALLS (${tgz.length})`)) {
    const npmI = run('npm', ['install', '--no-audit', '--no-fund', '--no-save', '--prefix', opencodeDir, ...tgz], { timeout: 600000 })
    const pluginDir = join(opencodeDir, 'node_modules', '@plur-ai', 'opencode')
    const pluginEntry = join(pluginDir, 'dist', 'index.js')
    ok = check(npmI.status === 0 && existsSync(pluginEntry), `install the PR plugin into opencode's config folder (exit ${npmI.status}) ${npmI.stderr.slice(-200)}`)
    const pv = tryRead(() => readJson(join(pluginDir, 'package.json')).version)
    if (CI_OPENCODE_VERSION) ok = check(pv === CI_OPENCODE_VERSION, `the installed plugin is this build (${pv}, expected ${CI_OPENCODE_VERSION})`) && ok
    // init declares the bare name, which opencode fetches from npm; point it at this build instead.
    const cfgPath = opencodeConfig()
    const cfg = readJsonc(cfgPath)
    const declared = (cfg.plugin ?? []).filter((p) => (Array.isArray(p) ? p[0] : p).startsWith('@plur-ai/opencode'))
    cfg.plugin = [...(cfg.plugin ?? []).filter((p) => !declared.includes(p)), pathToFileURL(pluginEntry).href]
    writeJson(cfgPath, cfg)
    const cacheDir = join(home, '.cache', 'opencode', 'packages', '@plur-ai')
    const cachedBefore = tryRead(() => readdirSync(cacheDir)) ?? []
    const r = run('opencode', ['mcp', 'list', '--print-logs'], { timeout: 300000, env: { ...env, PLUR_DEBUG: '1' } })
    const loaded = /\[plur:opencode\] scope root/.test(r.stderr + r.stdout)
    const cachedAfter = tryRead(() => readdirSync(cacheDir)) ?? []
    ok = check(r.status === 0 && loaded, `opencode loads the plugin from ${pluginEntry} (exit ${r.status}, plugin debug line ${loaded ? 'seen' : 'missing'})`) && ok
    ok = check(cachedAfter.length === cachedBefore.length, `opencode fetched no @plur-ai package from npm (${cachedAfter.join(', ') || 'none'})`) && ok
    // The plugin itself, as opencode drives it: chat.message, then the system render.
    // Recorded shapes from packages/opencode/test/folder-map.test.ts.
    try {
      Object.assign(process.env, env)
      process.chdir(NEUTRAL)
      const { PlurPlugin } = await import(pathToFileURL(pluginEntry).href)
      for (const state of ['decided', 'undecided', 'off']) {
        const dir = folders[state]
        const before = state === 'off' ? storeState() : null
        const hooks = await PlurPlugin({ directory: dir, worktree: dir })
        const sessionID = `ci-oc-${state}-${RUN}`
        await hooks['chat.message']?.({ sessionID }, { message: { id: `msg-${sessionID}` }, parts: [{ type: 'text', text: PROMPT }] })
        const out = { system: ['base'] }
        await hooks['experimental.chat.system.transform']?.({ sessionID, model: {} }, out)
        const seen = out.system.slice(1).join('\n')
        const verdict = state === 'off' ? (seen === '' || `not silent: ${seen.slice(0, 200)}`) : EXPECT[state](seen, seen)
        ok = check(verdict === true, `opencode plugin [${state}]: ${verdict === true ? { decided: 'memory injected, no question', undecided: 'asks, no memory', off: 'does nothing' }[state] : verdict}`) && ok
        if (before) ok = check(diffState(before, storeState()).length === 0, 'opencode plugin [off]: nothing written to the PLUR store') && ok
      }
    } catch (e) { ok = check(false, `opencode plugin could not be driven: ${e.message}`) }
    finally { process.chdir(project) }
  }
  rows.opencode ??= {}
  cell('opencode', 'hooks', ok, ok ? 'PR plugin loaded; decided / undecided / off' : 'plugin')
}

// ── (g) the user's own entries survive ───────────────────────────────────────
console.log("\n=== (g) the user's own hooks and MCP entries are still there ===")
let kept = true
for (const [what, u] of Object.entries(USER)) kept = check(tryRead(u.has) === true, `kept: the user's ${what}`) && kept

// ── (h) a deliberately unwired editor is named ───────────────────────────────
if (cli.codex) {
  console.log('\n=== (h) unwired Codex is named by doctor ===')
  run('codex', ['mcp', 'remove', 'plur'])
  // Piped, doctor answers in JSON. Its closing line names exactly the editors
  // with codexDetected && !codexWired (readyLine, covered in doctor-1603.test.ts).
  const rep2 = doctorJson()
  check(rep2?.codexDetected === true && rep2?.codexWired === false, `doctor names Codex once it is deliberately unwired (codexDetected=${rep2?.codexDetected}, codexWired=${rep2?.codexWired})`)
}

// ── #1602: an old pinned plugin in a commented opencode.jsonc ────────────────
if (SCENARIO === 'fresh') {
  console.log('\n=== #1602 (reported, not judged): a pinned @plur-ai/opencode@0.1.3 in a commented opencode.jsonc ===')
  const h2 = realpathSync.native(mkdtempSync(join(tmpdir(), 'Test User-oc-')))
  mkdirSync(join(h2, '.config', 'opencode'), { recursive: true })
  const jsonc = join(h2, '.config', 'opencode', 'opencode.jsonc')
  writeFileSync(jsonc, '{\n  // my settings\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["@plur-ai/opencode@0.1.3"]\n}\n')
  const r = spawnSync(WIN ? 'plur.cmd' : 'plur', ['init', '--no-prompt', '--no-desktop', '--no-codex', '--no-cursor', '--no-antigravity'], {
    cwd: h2, encoding: 'utf8', shell: WIN, timeout: 180000,
    env: { ...env, HOME: h2, USERPROFILE: h2, PLUR_PATH: join(h2, '.plur'), APPDATA: join(h2, 'AppData', 'Roaming'), CODEX_HOME: join(h2, '.codex') },
  })
  const line = (r.stdout ?? '').split(/\r?\n/).find((l) => /^Opencode:/.test(l)) ?? '(no opencode line)'
  const after = readFileSync(jsonc, 'utf8').replace(/\s+/g, ' ').slice(0, 300)
  console.log(`init: ${line}\nfile after: ${after}`)
  notCovered.push(['opencode upgrade from a pinned @plur-ai/opencode@0.1.3 in a commented opencode.jsonc', `#1602 is open; observed: ${line.slice(0, 160)}`])
}

// ── summary ──────────────────────────────────────────────────────────────────
const versions = Object.fromEntries(['claude', 'codex', 'opencode'].filter((k) => cli[k]).map((k) => [k, strip(run(k, ['--version']).stdout).trim().split(/\r?\n/)[0]]))
if (cli.cursor) versions.cursor = strip(run(cli.cursor, ['--version']).stdout).trim().split(/\r?\n/)[0]
const lines = [
  `## Real-editor integration (#1605): scenario \`${SCENARIO}\``, '',
  `Runner: ${process.platform}, Node ${process.version}. PLUR: \`${plurVersion}\`${CI_VERSION ? ` (expected \`${CI_VERSION}\`)` : ''}. ${FROM ? `Published ${FROM} installed and initialised first, then this build. ` : ''}\`plur init --no-prompt\` with no \`--no-*\` flags, run twice.`, '',
  `Editors: ${Object.entries(versions).map(([k, v]) => `${NAMES[k]} \`${v}\``).join(', ')}`, '',
  '| Editor | Editor lists plur (healthy) | Registered MCP command: handshake, this build | Hooks: expected set, this build, decided / undecided / off / team | `plur doctor` wired |',
  '|---|---|---|---|---|',
  ...ORDER.filter((k) => editors.includes(k)).map((k) => {
    const r = rows[k] ?? {}
    const listing = r.listing ?? (k === 'cursor' && !cli.cursor ? 'not covered' : '✗')
    return `| ${NAMES[k]}${k === 'desktop' || k === 'agy' ? ' (no CLI: config file only)' : ''} | ${listing} | ${r.handshake ?? '✗'} | ${r.hooks ?? '✗'} | ${r.doctor ?? '✗'} |`
  }),
  '',
  `Second init changes nothing: ${idempotent ? '✓' : '✗'}. The user's own hooks and MCP entries kept: ${kept ? '✓' : '✗'}.`,
  ...notes.map((n) => `Note: ${n}.`),
  '',
  notCovered.length ? '**Not covered:**' : '**Not covered:** none',
  ...notCovered.map(([n, why]) => `- ${n}: not covered (${why})`),
  '',
  failures.length ? `**${failures.length} check(s) failed:**` : '**All checks passed.**',
  ...failures.map((f) => `- ${f}`),
  '',
]
console.log('\n' + lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
process.exit(failures.length ? 1 : 0)
