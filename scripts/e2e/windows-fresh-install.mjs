#!/usr/bin/env node
/**
 * Fresh-install e2e for the field-report done-when (#1270, #1273/#1277,
 * #1318, #1403/#1418):
 *
 *   "A fresh install, in a never-registered folder, asks once; on 'yes' it
 *    writes an engram that reaches the url store, and produces a feedback
 *    outcome."
 *
 * Run by .github/workflows/e2e-windows-fresh-install.yml on windows-latest.
 * NOT a live editor session: no editor runs. The hook commands and MCP
 * entries `plur init` wrote are executed exactly as written, with the JSON
 * payloads each editor sends, through the shells those editors use.
 *
 *   node scripts/e2e/windows-fresh-install.mjs --tarballs <dir> --home plain|spaced --out <dir>
 *
 * Everything happens under fresh temp dirs: HOME/USERPROFILE, TEMP/TMP,
 * PLUR_PATH, APPDATA/LOCALAPPDATA, XDG_CONFIG_HOME. The packed tarballs are
 * installed into a temp prefix (not the repo); the team store is the in-repo
 * stub on localhost (scripts/e2e/stub-store.ts) with a test token.
 *
 * Per shell (bash = Git Bash, pwsh, cmd /C), per editor:
 *   (a) first prompt carries the one-time folder question, a second does not
 *   (b) the question's "Yes" command, run as the model would, sets the folder on
 *   (c) `plur learn --scope group:e2e/test` reaches the stub (once per shell)
 *   (d) the end-of-turn hook leaves a local rated record and the stub a
 *       feedback event with source auto
 *   (e) re-running `plur init` does not duplicate hooks (once per shell)
 *   (f) every MCP entry starts the server and answers tools/list (once per shell)
 *
 * Claude Code string hooks run through bash and pwsh only (the shells Claude
 * Code uses on Windows); exec-form entries (command + args) are spawned with
 * no shell. Exit code 1 when any check fails. Results: <out>/results.json.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, statSync, appendFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'

const argv = process.argv.slice(2)
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt }
const TARBALLS = resolve(opt('tarballs', 'tarballs'))
const HOME_KIND = opt('home', 'plain')
const OUT = resolve(opt('out', 'e2e-out'))
const ONLY_SHELLS = opt('shells', '')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIN = process.platform === 'win32'
const SCOPE = 'group:e2e/test'
const TOKEN = process.env.PLUR_E2E_TOKEN || 'e2e-localhost-test-token'
mkdirSync(OUT, { recursive: true })
const LOG = join(OUT, 'log.txt')
writeFileSync(LOG, '')

const redact = (s) => String(s ?? '').split(TOKEN).join('***')
function log(...parts) {
  const line = redact(parts.join(' '))
  console.log(line)
  appendFileSync(LOG, line + '\n')
}
const clip = (s, n = 1500) => { s = redact(s); return s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- the machine

const base = WIN ? realpathSync.native(tmpdir()) : realpathSync(tmpdir())
const HOME = mkdtempSync(join(base, HOME_KIND === 'spaced' ? 'E2E User ' : 'e2euser'))
if (HOME_KIND === 'spaced' && !/\s/.test(HOME)) throw new Error(`home has no space: ${HOME}`)
const PREFIX = mkdtempSync(join(base, 'plur-prefix-'))
const TEMP = join(HOME, 'AppData', 'Local', 'Temp')
const PLUR_PATH = join(HOME, '.plur')
for (const d of [TEMP, join(HOME, 'AppData', 'Roaming'), join(HOME, '.config'), join(HOME, 'work')]) mkdirSync(d, { recursive: true })
const BIN = join(PREFIX, 'node_modules', '.bin')
const CLI_JS = join(PREFIX, 'node_modules', '@plur-ai', 'cli', 'dist', 'index.js')

const env = {
  ...process.env,
  HOME, USERPROFILE: HOME, HOMEDRIVE: '', HOMEPATH: '',
  TEMP, TMP: TEMP, TMPDIR: TEMP,
  APPDATA: join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: join(HOME, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(HOME, '.config'),
  PLUR_PATH,
  PATH: `${BIN}${WIN ? ';' : ':'}${process.env.PATH}`,
}
for (const k of ['PLUR_AUTO_RATE', 'PLUR_AUTO_CAPTURE', 'CLAUDE_SESSION_ID', 'OPENCODE_CONFIG_DIR', 'PLUR_HOOK_PROBE']) delete env[k]
if (WIN) { delete env.HOMEDRIVE; delete env.HOMEPATH }

log(`home kind: ${HOME_KIND}`)
log(`HOME=${HOME}`)
log(`TEMP=${TEMP}`)
log(`PLUR_PATH=${PLUR_PATH}`)
log(`prefix=${PREFIX}`)

// ------------------------------------------------------------------- results

const results = []  // { shell, editor, check, pass, detail }
function record(shell, editor, check, pass, detail = '') {
  results.push({ home: HOME_KIND, shell, editor, check, pass: pass === null ? null : !!pass, detail: clip(detail, 4000) })
  log(`${pass === null ? 'N/A ' : pass ? 'PASS' : 'FAIL'}  [${HOME_KIND}] ${shell} ${editor} (${check}) ${clip(detail, 600)}`)
}

// ----------------------------------------------------------------- processes

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync) ?? 'bash'
const pwshBin = WIN ? 'pwsh' : (spawnSync('pwsh', ['-v']).status === 0 ? 'pwsh' : null)
const SHELLS = {
  bash: (cmd) => [gitBash, ['-c', cmd], {}],
  pwsh: (cmd) => [pwshBin ?? 'pwsh', ['-NoProfile', '-Command', cmd], {}],
  cmd: (cmd) => ['cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true }],
}
const shellList = (WIN ? ['bash', 'pwsh', 'cmd'] : ['bash', ...(pwshBin ? ['pwsh'] : [])])
  .filter(s => !ONLY_SHELLS || ONLY_SHELLS.split(',').includes(s))

function run(file, args, { input = '', cwd = HOME, timeoutMs = 120_000, extraEnv = {}, spawnOpts = {} } = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now()
    let child
    try {
      child = spawn(file, args, { cwd, env: { ...env, ...extraEnv }, windowsHide: true, ...spawnOpts })
    } catch (err) {
      resolvePromise({ code: null, stdout: '', stderr: `spawn threw: ${err.message}`, ms: 0, error: err.code ?? err.message })
      return
    }
    let stdout = '', stderr = '', done = false
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })
    const timer = setTimeout(() => { if (!done) { try { child.kill() } catch {} ; stderr += `\n[e2e] killed after ${timeoutMs}ms` } }, timeoutMs)
    child.on('error', err => { if (done) return; done = true; clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: stderr + `\n[e2e] spawn error: ${err.message}`, ms: Date.now() - t0, error: err.code ?? err.message }) })
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolvePromise({ code, stdout, stderr, ms: Date.now() - t0 }) })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

/** Run a hook spec exactly as written: exec form spawned directly, a string through `shell`. */
function runHook(spec, shell, payload, cwd, timeoutS = 60) {
  const input = JSON.stringify(payload)
  if (Array.isArray(spec.args)) return run(spec.command, spec.args, { input, cwd, timeoutMs: (timeoutS + 30) * 1000 })
  const [file, args, spawnOpts] = SHELLS[shell](spec.command)
  return run(file, args, { input, cwd, timeoutMs: (timeoutS + 30) * 1000, spawnOpts })
}

/** Run a command line the way a model runs one in that editor's shell. */
function runLine(line, shell, cwd) {
  const [file, args, spawnOpts] = SHELLS[shell](line)
  return run(file, args, { cwd, spawnOpts })
}

const plurNode = (args, opts = {}) => run(process.execPath, [CLI_JS, ...args], opts)

// ---------------------------------------------------------------- the install

async function install() {
  const tgz = readdirSync(TARBALLS).filter(f => f.endsWith('.tgz')).map(f => join(TARBALLS, f))
  log(`tarballs: ${tgz.map(t => t.split(/[\\/]/).pop()).join(', ')}`)
  writeFileSync(join(PREFIX, 'package.json'), JSON.stringify({ name: 'plur-e2e-prefix', private: true }))
  const npm = WIN ? 'npm.cmd' : 'npm'
  const r = await run(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tgz], { cwd: PREFIX, timeoutMs: 900_000, spawnOpts: { shell: WIN } })
  log(`npm install exit ${r.code} in ${r.ms}ms ${clip(r.stderr, 800)}`)
  if (r.code !== 0 || !existsSync(CLI_JS)) throw new Error('install of the packed tarballs failed')
  const v = await plurNode(['--version'])
  log(`installed plur ${v.stdout.trim()} from ${CLI_JS}`)
}

// -------------------------------------------------------------------- stub

let stubUrl = ''
let stubProc = null
async function startStub() {
  stubProc = spawn(process.execPath, ['--experimental-transform-types', '--no-warnings', join(REPO, 'scripts', 'e2e', 'stub-store.ts')], {
    env: { ...process.env, PLUR_E2E_TOKEN: TOKEN, PLUR_E2E_SCOPE: SCOPE }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  stubProc.stderr.on('data', d => appendFileSync(join(OUT, 'stub-stderr.txt'), redact(d)))
  stubUrl = await new Promise((res, rej) => {
    let buf = ''
    const t = setTimeout(() => rej(new Error('stub did not start')), 30_000)
    stubProc.stdout.on('data', d => { buf += d; const m = /E2E_STUB_URL=(\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]) } })
    stubProc.on('exit', c => rej(new Error(`stub exited ${c}`)))
  })
  log(`stub store at ${stubUrl}`)
}
async function stubState() {
  const r = await fetch(`${stubUrl}/__e2e/state`)
  return r.json()
}

// ---------------------------------------------------------------- init/hooks

const INIT_ARGS = ['init', '--global', '--no-desktop', '--cursor', '--codex', '--antigravity', '--opencode', '--no-prompt']
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const hookFiles = () => ({
  claude: join(HOME, '.claude', 'settings.json'),
  cursor: join(HOME, '.cursor', 'hooks.json'),
  codex: join(HOME, '.codex', 'hooks.json'),
  agy: join(HOME, '.gemini', 'config', 'hooks.json'),
})

/** Every hook spec for `event` in an editor's hooks file, in file order. */
function hooksFor(editor, event) {
  const f = hookFiles()[editor]
  if (!existsSync(f)) return []
  const j = readJson(f)
  // agy's file holds named hook sets ({"plur-memory": {PreInvocation: [...]}}).
  const roots = editor === 'agy' ? Object.values(j).filter(v => v && typeof v === 'object') : [j.hooks ?? {}]
  const entries = roots.flatMap(r => r[event] ?? [])
  const out = []
  for (const e of entries) {
    if (typeof e?.command === 'string') out.push({ command: e.command, args: e.args, timeout: e.timeout })
    for (const h of e?.hooks ?? []) if (typeof h?.command === 'string') out.push({ command: h.command, args: h.args, timeout: h.timeout })
  }
  return out
}
function allHookSpecs(editor) {
  const f = hookFiles()[editor]
  if (!existsSync(f)) return []
  const out = []
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      if (typeof v.command === 'string') out.push(JSON.stringify({ c: v.command, a: v.args ?? null }))
      for (const [k, x] of Object.entries(v)) if (k !== 'command' && k !== 'args') walk(x)
    }
  }
  const j = readJson(f)
  walk(editor === 'agy' ? j : j.hooks)
  return out
}

/** Every MCP server entry named plur in any config file under HOME. */
function mcpEntries() {
  const out = []
  const skip = new Set(['node_modules', '.plur', 'AppData', 'work', '.cache'])
  const files = []
  const walk = (d, depth) => {
    if (depth > 5) return
    let names = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (!skip.has(n)) walk(p, depth + 1) }
      else if (/\.(json|jsonc|toml)$/.test(n) && st.size < 2_000_000) files.push(p)
    }
  }
  walk(HOME, 0)
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    if (!/plur/i.test(text)) continue
    if (f.endsWith('.toml')) {
      const m = /\[mcp_servers\.("?)plur\1\]([\s\S]*?)(?=\n\[|$)/.exec(text)
      if (!m) continue
      const body = m[2]
      const str = (s) => s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s)
      const cm = /\ncommand\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec('\n' + body)
      const am = /\nargs\s*=\s*\[([\s\S]*?)\]/.exec('\n' + body)
      const args = am ? [...am[1].matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map(x => str(x[0])) : []
      if (cm) out.push({ file: f, command: str(cm[1]), args })
      continue
    }
    let j
    try { j = JSON.parse(text) } catch { continue }
    const visit = (v) => {
      if (!v || typeof v !== 'object') return
      for (const [k, x] of Object.entries(v)) {
        if (['mcpServers', 'mcp', 'servers', 'mcp_servers'].includes(k) && x && typeof x === 'object' && x.plur) {
          const e = x.plur
          if (Array.isArray(e.command)) out.push({ file: f, command: e.command[0], args: e.command.slice(1), env: e.env ?? e.environment })
          else if (typeof e.command === 'string') out.push({ file: f, command: e.command, args: e.args ?? [], env: e.env })
        } else visit(x)
      }
    }
    visit(j)
  }
  return out
}

// ----------------------------------------------------------------- MCP stdio

function mcpToolsList(entry) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(entry.command, entry.args, { env: { ...env, ...(entry.env ?? {}) }, cwd: HOME, windowsHide: true })
    } catch (err) { resolvePromise({ ok: false, detail: `spawn threw ${err.code ?? err.message}` }); return }
    let buf = '', err = '', done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child.kill() } catch {} ; resolvePromise(r) }
    const t = setTimeout(() => finish({ ok: false, detail: `no tools/list answer in 90s; stderr: ${clip(err, 800)}` }), 90_000)
    child.on('error', e => finish({ ok: false, detail: `spawn error ${e.code ?? e.message}` }))
    child.on('exit', c => finish({ ok: false, detail: `server exited ${c} before answering; stderr: ${clip(err, 800)}` }))
    child.stderr.on('data', d => { err += d })
    child.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
        } else if (msg.id === 2) {
          const n = msg.result?.tools?.length ?? 0
          finish({ ok: n > 0, detail: n > 0 ? `tools/list answered with ${n} tools` : `tools/list: ${clip(JSON.stringify(msg), 500)}` })
        }
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plur-e2e', version: '0' } } }) + '\n')
  })
}

// ------------------------------------------------------------- hook outcomes

/** All text a hook printed: raw stdout plus every string inside it if it is JSON. */
function hookText(stdout) {
  // Decoded JSON strings first: the raw text has them JSON-escaped.
  const parts = []
  const collect = (v) => { if (typeof v === 'string') parts.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect) }
  for (const chunk of stdout.split(/\n(?=\{)/)) { try { collect(JSON.parse(chunk)) } catch {} }
  parts.push(stdout)
  return parts.join('\n')
}
const QUESTION = /no decision for this folder yet|is not trusted, so no memories were loaded/
function yesCommand(text) {
  const m = /- Yes(?:, without its settings)?: (plur folders set .*? --nonce \S+)/.exec(text)
  return m ? m[1] : null
}

const rateDir = () => join(TEMP, 'plur-auto-rate')
const safeKey = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_')
async function autoRateIdle(timeoutMs = 120_000) {
  const t0 = Date.now()
  for (;;) {
    const busy = existsSync(rateDir()) && readdirSync(rateDir()).some(f => /\.(queue|worker)/.test(f))
    if (!busy) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(250)
  }
}
function ratedIds(editor, sid) {
  if (!existsSync(rateDir())) return []
  const f = join(rateDir(), `${editor}-${safeKey(sid)}.rated`)
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}
function injectedIds(editor, sid) {
  if (!existsSync(rateDir())) return []
  const f = join(rateDir(), `${editor}-${safeKey(sid)}.injected`)
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []
}

// ------------------------------------------------------------ editor models

/**
 * Each editor: the hooks file events for its prompt, end-of-turn and
 * session-end, the payload it sends, and the working directory it runs hooks
 * in. Cursor's prompt-level hook is sessionStart (once per conversation);
 * agy's is PreInvocation, with the user turn in a transcript file.
 */
function transcriptFor(folder, sid, turns) {
  const p = join(folder, `.agy-transcript-${sid}.jsonl`)
  const lines = turns.map((t, i) => t.role === 'user'
    ? { type: 'USER_INPUT', step_index: i * 2, content: t.text }
    : { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: i * 2 + 1, content: t.text })
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return p
}
const EDITORS = {
  claude: {
    shells: ['bash', 'pwsh'],
    prompt: (folder, sid, text) => ({ event: 'UserPromptSubmit', cwd: folder, payload: { session_id: sid, transcript_path: join(folder, `${sid}.jsonl`), cwd: folder, hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: text } }),
    stop: (folder, sid, reply) => ({ event: 'Stop', cwd: folder, payload: { session_id: sid, transcript_path: join(folder, `${sid}.jsonl`), cwd: folder, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: reply } }),
    end: (folder, sid) => ({ event: 'SessionEnd', cwd: folder, payload: { session_id: sid, transcript_path: join(folder, `${sid}.jsonl`), cwd: folder, hook_event_name: 'SessionEnd', reason: 'other' } }),
    newSessionForInject: false,
  },
  codex: {
    shells: ['bash', 'pwsh', 'cmd'],
    prompt: (folder, sid, text) => ({ event: 'UserPromptSubmit', cwd: folder, payload: { session_id: sid, transcript_path: null, cwd: folder, hook_event_name: 'UserPromptSubmit', model: 'gpt-5', prompt: text } }),
    stop: (folder, sid, reply) => ({ event: 'Stop', cwd: folder, payload: { session_id: sid, transcript_path: null, cwd: folder, hook_event_name: 'Stop', model: 'gpt-5', stop_hook_active: false, last_assistant_message: reply } }),
    end: (folder, sid) => ({ event: 'SessionEnd', cwd: folder, payload: { session_id: sid, cwd: folder, hook_event_name: 'SessionEnd' } }),
    newSessionForInject: false,
  },
  cursor: {
    shells: ['bash', 'pwsh', 'cmd'],
    prompt: (folder, sid) => ({ event: 'sessionStart', cwd: folder, payload: { conversation_id: sid, generation_id: `${sid}-g`, hook_event_name: 'sessionStart', workspace_roots: [folder], is_background_agent: false, composer_mode: 'agent' } }),
    stop: (folder, sid, reply) => ({ event: 'afterAgentResponse', cwd: folder, payload: { conversation_id: sid, generation_id: `${sid}-g`, hook_event_name: 'afterAgentResponse', workspace_roots: [folder], text: reply } }),
    end: (folder, sid) => ({ event: 'stop', cwd: folder, payload: { conversation_id: sid, generation_id: `${sid}-g`, hook_event_name: 'stop', workspace_roots: [folder], status: 'completed', loop_count: 0 } }),
    newSessionForInject: true, // sessionStart fires once per conversation: memory loads in the next one
  },
  agy: {
    shells: ['bash', 'pwsh', 'cmd'],
    turns: new Map(),
    prompt(folder, sid, text) {
      const turns = this.turns.get(sid) ?? []
      turns.push({ role: 'user', text })
      this.turns.set(sid, turns)
      return { event: 'PreInvocation', cwd: join(HOME, '.gemini', 'config'), payload: { conversationId: sid, workspacePaths: [folder], transcriptPath: transcriptFor(folder, sid, turns), invocationNum: 0 } }
    },
    stop(folder, sid, reply) {
      const turns = this.turns.get(sid) ?? []
      turns.push({ role: 'model', text: reply })
      return { event: 'Stop', cwd: join(HOME, '.gemini', 'config'), payload: { conversationId: sid, workspacePaths: [folder], transcriptPath: transcriptFor(folder, sid, turns) } }
    },
    end: () => null,
    newSessionForInject: false,
  },
}

async function fire(editor, shell, call, label) {
  const specs = hooksFor(editor, call.event)
  const outs = []
  for (const spec of specs) {
    const r = await runHook(spec, shell, call.payload, call.cwd, spec.timeout ?? 60)
    const form = Array.isArray(spec.args) ? `exec: ${[spec.command, ...spec.args].join(' ')}` : spec.command
    log(`  ${editor}/${shell} ${label} ${call.event} -> exit ${r.code} ${r.ms}ms  [${clip(form, 200)}]  stdout=${JSON.stringify(clip(r.stdout, 300))} stderr=${JSON.stringify(clip(r.stderr, 300))}`)
    outs.push({ spec, ...r })
  }
  return { specs, outs, text: outs.map(o => hookText(o.stdout)).join('\n') }
}

// ------------------------------------------------------------------ scenario

let runN = 0
async function scenario(shell) {
  log(`\n=== shell: ${shell} ===`)
  const statement = `E2E ${shell} ${HOME_KIND} rule: tag every Windows release candidate with the quartz sprint number`
  const reply = `Done. I tagged the Windows release candidate with the quartz sprint number, as the team rule says: ${statement}.`

  // (c) once per shell: a learn to the team scope, run in this shell the way
  // a model runs `plur learn` (the MCP route is (f)'s server).
  let learned = false
  for (const [editor, model] of Object.entries(EDITORS)) {
    if (!model.shells.includes(shell)) { record(shell, editor, 'a-e', null, `${editor} does not run hooks through ${shell}`); continue }
    const folder = join(HOME, 'work', `never registered ${shell} ${editor}`.replace(/ /g, HOME_KIND === 'spaced' ? ' ' : '-'))
    mkdirSync(folder, { recursive: true })
    const sid = `e2e-${HOME_KIND}-${shell}-${editor}-${Date.now()}-${++runN}`

    // (a) the first prompt asks, the second does not
    const p1 = await fire(editor, shell, model.prompt(folder, sid, 'Help me prepare the Windows release candidate.'), 'prompt#1')
    const asked = QUESTION.test(p1.text)
    const yes = yesCommand(p1.text)
    const p2 = await fire(editor, shell, model.prompt(folder, sid, 'And what about the changelog?'), 'prompt#2')
    const askedAgain = QUESTION.test(p2.text)
    record(shell, editor, 'a', p1.specs.length > 0 && asked && !askedAgain,
      `hooks=${p1.specs.length}; first prompt asked=${asked}; second asked=${askedAgain}; yes=${yes ?? '(none)'}` +
      (asked ? '' : `; first output: ${clip(p1.text, 800)}`))

    // (b) "yes", exactly as the model would run it, in this shell
    let on = false
    if (yes) {
      const r = await runLine(yes, shell, folder)
      const { resolveFolderPolicy } = await import(pathToFileURL(join(PREFIX, 'node_modules', '@plur-ai', 'core', 'dist', 'index.js')).href)
      let policy = null
      try { policy = resolveFolderPolicy(folder, { root: PLUR_PATH, home: HOME }) } catch (e) { policy = { error: e.message } }
      const map = existsSync(join(PLUR_PATH, 'folders.yaml')) ? readFileSync(join(PLUR_PATH, 'folders.yaml'), 'utf8') : '(no folders.yaml)'
      on = policy?.mode === 'on'
      record(shell, editor, 'b', r.code === 0 && on,
        `ran: ${yes} -> exit ${r.code}; stdout=${clip(r.stdout.trim(), 300)}; stderr=${clip(r.stderr.trim(), 400)}; policy=${JSON.stringify(policy)}; folders.yaml:\n${clip(map, 1500)}`)
    } else {
      record(shell, editor, 'b', false, 'no Yes command to run (the question was not shown)')
    }

    // (c) once per shell
    if (!learned) {
      learned = true
      const before = await stubState()
      const r = await runLine(`plur learn "${statement}" --scope ${SCOPE} --domain e2e.windows --json`, shell, folder)
      let out = null
      try { out = JSON.parse(r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop() ?? '') } catch {}
      const after = await stubState()
      const onStub = after.engrams.find(e => e.statement === statement && e.scope === SCOPE)
      record(shell, 'cli', 'c', r.code === 0 && !!onStub && out?.delivery === 'remote',
        `exit ${r.code}; delivery=${out?.delivery}; warning=${out?.delivery_warning ?? out?.warning ?? ''}; stub appends ${before.appendCalls}->${after.appendCalls}; on stub: ${onStub ? `${onStub.id} ${onStub.scope}` : 'no'}; stderr=${clip(r.stderr, 400)}`)
    }

    // (d) memory loads on the next prompt; the end-of-turn hook rates it
    let isid = sid
    if (model.newSessionForInject) isid = `${sid}-2`
    const p3 = await fire(editor, shell, model.prompt(folder, isid, `Tag the Windows release candidate with the quartz sprint number.`), 'prompt#3')
    const injected = injectedIds(editor, isid)
    const shown = p3.text.includes('quartz sprint number')
    const fbBefore = (await stubState()).feedbackBodies.length
    const st = model.stop(folder, isid, reply)
    const s1 = await fire(editor, shell, st, 'end-of-turn')
    const idle = await autoRateIdle()
    const rated = ratedIds(editor, isid)
    const state = await stubState()
    const fbNew = state.feedbackBodies.slice(fbBefore)
    const auto = fbNew.filter(b => b.source === 'auto')
    record(shell, editor, 'd', rated.length > 0 && auto.length > 0,
      `prompt#3 showed the engram=${shown}; injected ids=${JSON.stringify(injected)}; end-of-turn hooks=${s1.specs.length} exits=${s1.outs.map(o => o.code).join(',')}; worker idle=${idle}; local rated=${JSON.stringify(rated)}; stub feedback new=${JSON.stringify(fbNew)}; files in plur-auto-rate: ${existsSync(rateDir()) ? readdirSync(rateDir()).filter(f => f.includes(safeKey(isid) + '.')).join(', ') : '(none)'}` +
      (shown ? '' : `; prompt#3 output: ${clip(p3.text, 600)}`))

    // Control, not a done-when check: when (d) fails, repeat the end-of-turn
    // hook once with a project marker (.plur.yaml) in the folder, to show
    // whether the folder-map "on" alone is what the hook does not honour.
    if (!(rated.length > 0 && auto.length > 0) && injected.length > 0) {
      writeFileSync(join(folder, '.plur.yaml'), '# e2e control: project marker only\n')
      const again = await fire(editor, shell, model.stop(folder, isid, reply + ' (second reply)'), 'end-of-turn+marker')
      await autoRateIdle()
      const rated2 = ratedIds(editor, isid)
      const fb2 = (await stubState()).feedbackBodies.slice(fbBefore)
      record(shell, editor, 'd-control', null,
        `with .plur.yaml in the folder: exits=${again.outs.map(o => o.code).join(',')}; local rated=${JSON.stringify(rated2)}; stub feedback new=${JSON.stringify(fb2)}`)
    }

    const endCall = model.end(folder, isid)
    if (endCall) {
      const e = await fire(editor, shell, endCall, 'session-end')
      const bad = e.outs.filter(o => o.code !== 0)
      record(shell, editor, 'end', bad.length === 0, `session-end hooks=${e.specs.length} exits=${e.outs.map(o => o.code).join(',')} stdout=${clip(e.outs.map(o => o.stdout).join(''), 300)}`)
    }
  }

  // (e) re-init through this shell: no duplicated hooks, no duplicated MCP entries
  const before = Object.fromEntries(Object.keys(hookFiles()).map(ed => [ed, allHookSpecs(ed)]))
  const mcpBefore = mcpEntries().length
  const r = await runLine(`plur ${INIT_ARGS.join(' ')}`, shell, HOME)
  const after = Object.fromEntries(Object.keys(hookFiles()).map(ed => [ed, allHookSpecs(ed)]))
  const mcpAfter = mcpEntries().length
  const diffs = Object.keys(before).filter(ed => JSON.stringify(before[ed]) !== JSON.stringify(after[ed]) || new Set(after[ed]).size !== after[ed].length)
  record(shell, 'all', 'e', r.code === 0 && diffs.length === 0 && mcpBefore === mcpAfter,
    `re-init exit ${r.code}; hook counts ${Object.keys(before).map(ed => `${ed} ${before[ed].length}->${after[ed].length}`).join(', ')}; changed: ${diffs.join(',') || 'none'}; mcp entries ${mcpBefore}->${mcpAfter}` + (r.code === 0 ? '' : `; stderr=${clip(r.stderr, 600)}`))

  // (f) every MCP entry starts the server
  for (const e of mcpEntries()) {
    const res = await mcpToolsList(e)
    record(shell, `mcp:${e.file.slice(HOME.length + 1)}`, 'f', res.ok, `${e.command} ${e.args.join(' ')} -> ${res.detail}`)
  }
}

// ---------------------------------------------------------------------- main

async function main() {
  await install()
  await startStub()

  // A fresh install: plur init, then connect the team store.
  const init = await plurNode(INIT_ARGS, { cwd: HOME })
  log(`plur init exit ${init.code}\n${clip(init.stdout, 6000)}\n${clip(init.stderr, 1500)}`)
  record('-', 'init', 'init', init.code === 0, `exit ${init.code}`)
  for (const [ed, f] of Object.entries(hookFiles())) log(`${ed} hooks file ${f}: ${existsSync(f) ? `${allHookSpecs(ed).length} hooks` : 'MISSING'}`)
  for (const [ed, f] of Object.entries(hookFiles())) if (existsSync(f)) writeFileSync(join(OUT, `hooks-${ed}.json`), readFileSync(f))
  writeFileSync(join(OUT, 'mcp-entries.json'), JSON.stringify(mcpEntries(), null, 2))

  const add = await plurNode(['stores', 'add', '--url', stubUrl, '--scope', SCOPE, '--token-env', 'PLUR_E2E_TOKEN'], { cwd: HOME, extraEnv: { PLUR_E2E_TOKEN: TOKEN } })
  log(`plur stores add exit ${add.code}: ${clip(add.stdout, 800)} ${clip(add.stderr, 800)}`)
  record('-', 'stores add', 'store', add.code === 0, `exit ${add.code}`)

  for (const shell of shellList) {
    try { await scenario(shell) } catch (err) { record(shell, 'harness', 'error', false, err.stack ?? String(err)) }
  }

  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ home: HOME_KIND, homePath: HOME, results }, null, 2))
  const table = ['| home | shell | editor | check | result | detail |', '|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.home} | ${r.shell} | ${r.editor} | ${r.check} | ${r.pass === null ? 'n/a' : r.pass ? 'PASS' : 'FAIL'} | ${redact(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`)].join('\n')
  writeFileSync(join(OUT, 'summary.md'), table + '\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Fresh install e2e — ${HOME_KIND} home\n\n${table}\n`)
  const failed = results.filter(r => r.pass === false)
  log(`\n${results.length} checks, ${failed.length} failed`)
  for (const f of failed) log(`  FAIL [${f.home}] ${f.shell} ${f.editor} (${f.check})`)
  try { stubProc?.kill() } catch {}
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { log(`harness error: ${err.stack ?? err}`); try { stubProc?.kill() } catch {} ; process.exit(2) })
