#!/usr/bin/env node
/**
 * Real-editor probe (#1605, layer 1). Run by .github/workflows/windows-editors.yml
 * on windows-latest after the PR's PLUR CLI and the editor CLIs are installed
 * globally. Also runs on macOS/Linux for development. Never run against a real
 * home directory: it creates a temporary HOME (with a space in its path) and
 * points HOME, USERPROFILE, APPDATA, LOCALAPPDATA and PLUR_PATH into it.
 *
 * No logins and no model calls: every check below is local.
 *
 * Editors:
 *   - with a CLI: Claude Code (`claude`), Codex (`codex`), opencode
 *     (`opencode`), Cursor's agent CLI (`agent` / `cursor-agent`). Each is run
 *     once before `plur init`, the way a user's first run creates its state
 *     folder, which is what `plur init` detects.
 *   - without a CLI: Claude Desktop and Antigravity. Their detection folder is
 *     created by hand (an empty Claude Desktop config; ~/.gemini/antigravity-cli),
 *     and only the config file they read is checked.
 *   - Cursor detection is per project: a `.cursor/` folder in the project.
 *
 * Then `plur init --no-prompt` runs with no other flags, and for each editor:
 *   (a) listing: the editor's own `mcp list` names plur (config file for the
 *       editors without a CLI);
 *   (b) handshake: the exact MCP command registered in that editor's config is
 *       spawned with no shell and must answer `initialize` and `tools/list`;
 *   (c) hooks: every hook command registered for that editor runs, exactly as
 *       written, with that editor's recorded payload (shapes from the CLI test
 *       suites, cited at PAYLOADS) in four folders:
 *         decided  (folders.yaml: plur on)        → memory injected
 *         undecided (no entry)                     → the folder question
 *         off      (folders.yaml: plur off)        → silent
 *         team     (folders.yaml: scope group:…)   → scope reported
 *       Every hook must exit 0 and print nothing or JSON; in the off folder
 *       every hook must be silent; the editor's main hook must say the thing
 *       its folder state calls for.
 *   (d) doctor: `plur doctor --json` reports the editor as wired.
 * Finally Codex is deliberately unwired (`codex mcp remove plur`) and doctor
 * must name it (codexWired false: the input its closing line names editors from).
 *
 * PLUR_EDITORS_REQUIRED (comma list of claude,codex,opencode,cursor) names the
 * CLIs whose absence is a failure; any other missing CLI is reported as "not
 * covered (reason)". The result table goes to stdout and, in GitHub Actions, to
 * the job summary. Exits 1 when any check fails.
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, appendFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import { spawn, spawnSync } from 'child_process'

const WIN = process.platform === 'win32'
const required = new Set((process.env.PLUR_EDITORS_REQUIRED ?? '').split(',').map((s) => s.trim()).filter(Boolean))
const CODEWORD = 'Codeword ZEPHYRQUILL: fixture deploys go through the blue staging lane'
const PROMPT = 'how do fixture deploys reach the blue staging lane'
const TEAM_SCOPE = 'group:ci/eng'
const QUESTION = 'no decision for this folder yet'
const RUN = `${process.pid}-${Date.now().toString(36)}`

// ── result bookkeeping ───────────────────────────────────────────────────────
const failures = []
const rows = {} // editor → { listing, handshake, hooks, doctor }
const notCovered = [] // [editor, reason]
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); return ok }
const cell = (editor, col, ok, note = '') => {
  rows[editor] ??= {}
  const prev = rows[editor][col]
  // A column is red as soon as one of its checks is.
  if (prev && prev.startsWith('✗')) return
  rows[editor][col] = `${ok ? '✓' : '✗'}${note ? ` ${note}` : ''}`
}

// ── temp HOME ────────────────────────────────────────────────────────────────
const home = realpathSync(mkdtempSync(join(tmpdir(), 'Test User-')))
if (!/\s/.test(home)) { console.error(`temp HOME has no space: ${home}`); process.exit(1) }
const folders = Object.fromEntries(['decided', 'undecided', 'off', 'team'].map((k) => {
  const p = join(home, k === 'decided' ? 'project' : k)
  mkdirSync(join(p, '.git'), { recursive: true })
  return [k, p]
}))
const project = folders.decided
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  PLUR_PATH: join(home, '.plur'),
  // Hook session state lives in the temp folder: keep it inside this run.
  TMPDIR: join(home, 'tmp'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
  // Deterministic, offline recall: BM25 only, no embedding model download.
  PLUR_HOOK_HYBRID: 'off', PLUR_DISABLE_EMBEDDINGS: '1',
  // Nothing outside the temp HOME decides where an editor keeps its config.
  XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '', XDG_CACHE_HOME: '',
  CODEX_HOME: '', OPENCODE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: '', CLAUDE_SESSION_ID: '',
}
for (const k of Object.keys(env)) if (env[k] === '') delete env[k]
mkdirSync(env.TMPDIR, { recursive: true })
mkdirSync(env.APPDATA, { recursive: true })
mkdirSync(env.LOCALAPPDATA, { recursive: true })
console.log(`HOME: ${home}`)

/** Run a command found on PATH (`.cmd` shims on Windows need a shell, so an argument with a space is quoted there). */
function run(bin, args, opts = {}) {
  const argv = WIN ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
  const r = spawnSync(bin, argv, { cwd: project, env, encoding: 'utf8', timeout: 180000, shell: WIN, ...opts })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const readJsonc = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? ''))
function onPath(name) {
  const r = spawnSync(WIN ? 'where' : 'which', [name], { encoding: 'utf8', env })
  return r.status === 0 ? (r.stdout ?? '').split(/\r?\n/)[0].trim() : null
}

// ── which editors are here ───────────────────────────────────────────────────
const plurBin = onPath('plur')
if (!check(!!plurBin, `plur is installed globally (${plurBin ?? 'not on PATH'})`)) process.exit(1)
console.log(`plur: ${plurBin}`)

const cli = {
  claude: onPath('claude'),
  codex: onPath('codex'),
  opencode: onPath('opencode'),
  cursor: onPath('agent') ? 'agent' : onPath('cursor-agent') ? 'cursor-agent' : null,
}
const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', cursor: 'Cursor', desktop: 'Claude Desktop', agy: 'Antigravity' }
const editors = []
for (const key of ['claude', 'codex', 'opencode', 'cursor']) {
  if (cli[key]) { editors.push(key); continue }
  const reason = process.env[`PLUR_EDITOR_${key.toUpperCase()}_REASON`] || `its CLI is not on PATH on this runner`
  if (required.has(key)) check(false, `${NAMES[key]}: CLI required but not installed (${reason})`)
  else notCovered.push([NAMES[key], reason])
}
editors.push('desktop', 'agy')

// First run of each editor CLI: creates its state folder, as on a user's machine.
if (cli.claude) run('claude', ['mcp', 'list'])
if (cli.codex) run('codex', ['mcp', 'list'])
if (cli.opencode) run('opencode', ['mcp', 'list'])
if (cli.cursor) { run(cli.cursor, ['--version']); mkdirSync(join(project, '.cursor'), { recursive: true }) }
// No CLI: create what the installed app would have.
const desktopConfig = join(WIN ? env.APPDATA : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'), 'Claude', 'claude_desktop_config.json')
mkdirSync(join(desktopConfig, '..'), { recursive: true })
writeFileSync(desktopConfig, '{}\n')
mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })

// ── plur init, no --no-* flags ───────────────────────────────────────────────
console.log('\n=== plur init --no-prompt ===')
const init = run('plur', ['init', '--no-prompt'])
console.log(init.stdout, init.stderr)
check(init.status === 0, `plur init --no-prompt exits 0 (exit ${init.status})`)

// ── (a) listing ──────────────────────────────────────────────────────────────
console.log('\n=== (a) each editor lists plur ===')
const opencodeConfig = ['opencode.json', 'opencode.jsonc'].map((f) => join(home, '.config', 'opencode', f)).find(existsSync)
const configs = {
  claude: () => readJson(join(home, '.claude.json')).mcpServers?.plur,
  codex: () => {
    const r = run('codex', ['mcp', 'get', 'plur', '--json'])
    const t = JSON.parse(r.stdout).transport
    return { command: t.command, args: t.args ?? [], env: t.env ?? undefined }
  },
  opencode: () => {
    const e = readJsonc(opencodeConfig).mcp?.plur
    return e && { command: e.command[0], args: e.command.slice(1), env: e.environment }
  },
  cursor: () => readJson(join(project, '.cursor', 'mcp.json')).mcpServers?.plur,
  desktop: () => readJson(desktopConfig).mcpServers?.plur,
  agy: () => readJson(join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers?.plur,
}
const listings = {
  claude: ['claude', ['mcp', 'list'], /^plur:.*(Connected|✓)/m],
  codex: ['codex', ['mcp', 'list'], /^plur\s+\S/m],
  opencode: ['opencode', ['mcp', 'list'], /plur.*connected/i],
  cursor: [cli.cursor, ['mcp', 'list'], /^plur:/m],
}
for (const key of editors) {
  const name = NAMES[key]
  if (listings[key]) {
    const [bin, args, re] = listings[key]
    const r = run(bin, args)
    const out = strip(r.stdout + r.stderr)
    console.log(`--- ${bin} ${args.join(' ')}\n${out.trim()}`)
    cell(key, 'listing', check(re.test(out), `${name}: \`${bin} ${args.join(' ')}\` lists plur`), `\`${bin} mcp list\``)
  } else {
    let entry = null
    try { entry = configs[key]() } catch { /* missing or unreadable */ }
    cell(key, 'listing', check(!!entry?.command, `${name}: its config file holds the plur entry`), 'config file')
  }
}

// ── (b) MCP handshake with the registered command ────────────────────────────
console.log('\n=== (b) the registered MCP command completes a handshake ===')
function handshake(entry) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(entry.command, entry.args ?? [], { cwd: project, env: { ...env, ...(entry.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
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
        if (!line.startsWith('{')) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
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
  console.log(`${name}: ${JSON.stringify([entry.command, ...(entry.args ?? [])])}`)
  const r = await handshake(entry)
  const ok = check(r.ok, `${name}: registered command answers initialize + tools/list (${r.ok ? `${r.server?.name} ${r.server?.version}, ${r.tools} tools` : r.error})`)
  cell(key, 'handshake', ok, ok ? `${r.tools} tools` : '')
}

// ── (c) hooks ────────────────────────────────────────────────────────────────
console.log('\n=== (c) every registered hook, with recorded payloads, in four folders ===')
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

/** Every hook in an editor's hooks file, with the event it is registered under. */
function collect(value, event = '', out = []) {
  if (Array.isArray(value)) for (const v of value) collect(v, event, out)
  else if (value && typeof value === 'object') {
    if (typeof value.command === 'string') out.push({ event, command: value.command, args: value.args })
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' || k === 'args') continue
      collect(v, /^[A-Za-z]+$/.test(k) && !['hooks', 'enabled'].includes(k) && typeof v === 'object' ? k : event, out)
    }
  }
  return out
}
/** "hook-inject --event skill" from a hook's command string or exec args. */
function keyOf(h) {
  const words = Array.isArray(h.args) ? h.args : h.command.split(/\s+/)
  const i = words.findIndex((w) => /^hook-[a-z0-9-]+$/.test(w))
  return i < 0 ? null : words.slice(i).join(' ')
}

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
 */
function transcript(dir, text) {
  const p = join(home, `agy-${Math.random().toString(36).slice(2)}.jsonl`)
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
      ['hook-cursor-post-tool', p('postToolUse', { tool_name: 'Shell' })],
      ['hook-cursor-stop', p('stop', { status: 'completed' })],
      ['hook-auto-rate cursor', p('afterAgentResponse', { generation_id: 'g', text: 'Done.' })],
    ]
  },
  agy: (sid, cwd) => {
    const t = transcript(cwd, PROMPT)
    return [
      ['hook-agy-pre-invocation', { conversationId: sid, invocationNum: 0, workspacePaths: [cwd], transcriptPath: t }],
      ['hook-agy-guard', { conversationId: sid, workspacePaths: [cwd], toolCall: { name: 'run_command' } }],
      ['hook-auto-rate agy', { conversationId: sid, transcriptPath: t, workspacePaths: [cwd], executionNum: 1, terminationReason: 'model_stop' }],
    ]
  },
}
// The hook each folder state is judged on, and what it must say there. Codex
// reports the folder's scope at session start (its prompt hook carries only the
// recalled memories); Cursor has no prompt hook, so its session start is where
// memory begins (the session-started block, also written to the context rule).
const MAIN = {
  claude: { decided: 'hook-inject', undecided: 'hook-inject', off: 'hook-inject', team: 'hook-inject' },
  codex: { decided: 'hook-codex-inject', undecided: 'hook-codex-inject', off: 'hook-codex-inject', team: 'hook-codex-session-start' },
  cursor: { decided: 'hook-cursor-session-start', undecided: 'hook-cursor-session-start', off: 'hook-cursor-session-start', team: 'hook-cursor-session-start' },
  agy: { decided: 'hook-agy-pre-invocation', undecided: 'hook-agy-pre-invocation', off: 'hook-agy-pre-invocation', team: 'hook-agy-pre-invocation' },
}
const EXPECT = {
  decided: (ctx, _raw, editor) => (editor === 'cursor' ? ctx.includes('[PLUR Memory — session started') : ctx.includes('ZEPHYRQUILL')) || 'memory not injected',
  undecided: (ctx) => ctx.includes(QUESTION) || 'folder question not asked',
  off: (_ctx, raw) => raw === '' || 'not silent',
  team: (ctx) => ctx.includes(TEAM_SCOPE) || `scope ${TEAM_SCOPE} not reported`,
}
function contextOf(stdout) {
  try {
    const j = JSON.parse(stdout)
    return j.hookSpecificOutput?.additionalContext ?? j.additional_context ?? j.additionalContext ?? j.injectSteps?.[0]?.ephemeralMessage ?? stdout
  } catch { return stdout }
}

const hookFiles = {
  claude: join(home, '.claude', 'settings.json'),
  codex: join(home, '.codex', 'hooks.json'),
  cursor: join(project, '.cursor', 'hooks.json'),
  agy: join(home, '.gemini', 'config', 'hooks.json'),
}
const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync) ?? 'bash'
/** Spawn a hook exactly as its editor does: exec form with no shell; a string through the editor's shell. */
function runHook(editor, h, payload, cwd) {
  const input = JSON.stringify(payload)
  const opts = { cwd, env, input, encoding: 'utf8', timeout: 60000 }
  let r
  if (Array.isArray(h.args)) r = spawnSync(h.command, h.args, opts)
  else if (!WIN) r = spawnSync('/bin/sh', ['-c', h.command], opts)
  // Claude Code runs string hooks through Git Bash on Windows; Codex and Cursor
  // through PowerShell (init's fallback form is PowerShell's `& "<path>"`), and
  // so does this probe for Antigravity. Every hook string through bash, pwsh
  // AND cmd is the windows-init-hooks job (scripts/windows-hook-probe.mjs).
  else if (editor === 'claude') r = spawnSync(gitBash, ['-c', h.command], opts)
  else r = spawnSync('pwsh', ['-NoProfile', '-Command', h.command], opts)
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', error: r.error?.message }
}

for (const key of ['claude', 'codex', 'cursor', 'agy']) {
  if (!editors.includes(key)) continue
  const name = NAMES[key]
  let hooks = []
  try { hooks = collect(key === 'agy' ? readJson(hookFiles[key]) : readJson(hookFiles[key]).hooks) } catch (e) { console.log(`${name}: hooks file unreadable: ${e.message}`) }
  if (!check(hooks.length > 0, `${name}: hooks registered in ${hookFiles[key]} (${hooks.length})`)) { cell(key, 'hooks', false); continue }
  const byKey = new Map(hooks.map((h) => [keyOf(h), h]))
  const known = new Set(PAYLOADS[key]('x', project).map(([k]) => k))
  for (const k of byKey.keys()) check(known.has(k), `${name}: registered hook \`${k}\` has a recorded payload`) || cell(key, 'hooks', false)
  let runs = 0
  for (const [state, cwd] of Object.entries(folders)) {
    const sid = `ci-${key}-${state}-${RUN}`
    for (const [k, payload] of PAYLOADS[key](sid, cwd)) {
      const h = byKey.get(k)
      if (!h) continue // not registered for this editor: nothing to run
      runs++
      const r = runHook(key, h, payload, cwd)
      const label = `${name} [${state}] ${k}`
      let problem = null
      if (r.error || r.status !== 0) problem = `exit ${r.status}${r.error ? ` (${r.error})` : ''}: ${r.stderr.slice(0, 300)}`
      else if (r.stdout !== '') { try { JSON.parse(r.stdout) } catch { problem = `stdout is not JSON: ${r.stdout.slice(0, 200)}` } }
      // Off is silent. hook-observe passes its input through: that is the hook contract, not output.
      if (!problem && state === 'off' && r.stdout !== '' && !(k.startsWith('hook-observe') && r.stdout === JSON.stringify(payload))) problem = `not silent: ${r.stdout.slice(0, 200)}`
      const judged = k === MAIN[key][state]
      if (!problem && judged) {
        const verdict = EXPECT[state](contextOf(r.stdout), r.stdout, key)
        if (verdict !== true) problem = `${verdict}: ${r.stdout.slice(0, 300)}`
      }
      if (problem) { check(false, `${label}: ${problem}`); cell(key, 'hooks', false) }
      else if (judged) console.log(`PASS  ${label} (${state === 'off' ? 'silent' : state === 'undecided' ? 'asks' : state === 'team' ? 'scope reported' : 'memory injected'})`)
    }
  }
  cell(key, 'hooks', true, `${byKey.size} hooks × 4 folders (${runs} runs)`)
}
// opencode's automatic layer is the @plur-ai/opencode plugin, not hook commands.
if (editors.includes('opencode')) rows.opencode.hooks = 'n/a (plugin, no hook commands)'
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
  check(rep.handshake?.ok === true, `doctor: MCP handshake ok (${rep.handshake?.probed ?? rep.handshake?.error})`)
  const wired = {
    claude: rep.claudeCodeMcp?.registered === true && cfg('Claude Code (global)')?.hasPlurHooks === true,
    desktop: cfg('Claude Desktop')?.hasPlurMcp === true,
    cursor: rep.cursorProjectDetected === true && rep.cursorWired === true,
    codex: rep.codexDetected === true && rep.codexWired === true,
    agy: rep.agyDetected === true && rep.agyWired === true,
    opencode: !!rep.opencode && rep.opencode.ok && rep.opencode.pluginDeclared && rep.opencode.mcpPlurDeclared && rep.opencode.mcpPlurMissingPaths.length === 0,
  }
  for (const key of editors) cell(key, 'doctor', check(wired[key], `doctor: ${NAMES[key]} wired`))
}

// A deliberately unwired editor is named.
if (cli.codex) {
  console.log('\n=== unwired Codex is named by doctor ===')
  run('codex', ['mcp', 'remove', 'plur'])
  // Piped, doctor answers in JSON. Its closing line names exactly the editors
  // with codexDetected && !codexWired (readyLine, covered in doctor-1603.test.ts).
  const rep2 = doctorJson()
  check(rep2?.codexDetected === true && rep2?.codexWired === false, `doctor names Codex once it is deliberately unwired (codexDetected=${rep2?.codexDetected}, codexWired=${rep2?.codexWired})`)
}

// ── summary ──────────────────────────────────────────────────────────────────
const order = ['claude', 'codex', 'opencode', 'cursor', 'desktop', 'agy']
const lines = [
  '## Real-editor integration (#1605)', '',
  `Runner: ${process.platform}, Node ${process.version}. \`plur init --no-prompt\` with no \`--no-*\` flags.`, '',
  '| Editor | Editor lists plur | Registered MCP command handshake | Hooks (decided / undecided / off / team folder) | `plur doctor` wired |',
  '|---|---|---|---|---|',
  ...order.filter((k) => editors.includes(k)).map((k) => {
    const r = rows[k] ?? {}
    return `| ${NAMES[k]}${k === 'desktop' || k === 'agy' ? ' (no CLI: config file only)' : ''} | ${r.listing ?? '✗'} | ${r.handshake ?? '✗'} | ${r.hooks ?? '✗'} | ${r.doctor ?? '✗'} |`
  }),
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
