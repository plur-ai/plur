// Harness for agent-behaviour promises (kind: agent): what a REAL agent does
// with PLUR attached. Ported from the Datacore agent_eval.py design.
//
// A run is a real headless Claude Code session (`claude -p … --output-format
// stream-json`) with the PLUR MCP server attached to a throwaway store. The
// transcript is graded DETERMINISTICALLY: which tools the agent called, with
// what input, what they returned, the files it left behind and its final text.
//
// Rules the harness enforces:
//  * Opt-in. Real sessions cost money and minutes, so they run only when
//    PLUR_AGENT_EVALS=1. Unset, requireEnabled() FAILS the test with
//    "agent eval not run (set PLUR_AGENT_EVALS=1)" — never a skip, never a pass.
//  * pass^k. A case passes only when EVERY run passes its grader.
//  * Isolation. Every run gets its own working directory and its own fresh HOME
//    under os.tmpdir() (never inside the user's home or data). The child's
//    environment is built from scratch: PATH, HOME, USER, LANG, TMPDIR and the
//    auth token — nothing else from this process leaks in.
//  * Standing context = what a real install gives the agent: the MCP server's
//    own instructions (sent by the server itself) plus the "## PLUR Memory"
//    CLAUDE.md section, written by running the real `plur-mcp init` in the
//    scaffold. Claude Code loads it with --setting-sources project.
//  * MCP route only: NO hooks. --setting-sources project ignores the user
//    settings file where init puts hooks, and every run has a fresh HOME anyway.
//    So nothing is injected automatically; the agent must call PLUR itself.
//  * Seeds go through the real write path (Plur.learn on the same PLUR_PATH the
//    server uses) — never hand-written YAML.
//  * The MCP server runs from packages/mcp/dist (Claude Code spawns it as a
//    separate process), so a change under packages/mcp/src needs
//    `pnpm --filter @plur-ai/mcp build` before it reaches the agent.
//
// Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from this process's env.
// Neither set → the test FAILS with a plain message. The value is passed to the
// child only; it is never printed or written to disk.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plur } from '../../packages/core/src/index.js'
import { useEmbedder } from './store.js'

export const ENV_SWITCH = 'PLUR_AGENT_EVALS'
export const NOT_RUN = `agent eval not run (set ${ENV_SWITCH}=1)`
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MCP_DIST = join(REPO_ROOT, 'packages', 'mcp', 'dist', 'index.js')

/** Model and per-session caps for every agent eval. */
export const MODEL = 'sonnet'
export const MAX_BUDGET_USD = 0.5
export const MAX_TURNS = 8
export const RUN_TIMEOUT_MS = 6 * 60_000
/** pass^k: how many runs each arm makes. PLUR_AGENT_EVAL_RUNS may LOWER it (for a manual mutant check), never raise it. */
export const RUNS = Math.max(1, Math.min(3, Number(process.env.PLUR_AGENT_EVAL_RUNS ?? 3) || 3))
/** Runs a promise needs before it can go green. */
export const CERTIFYING_RUNS = 3
/** A run with fewer than three runs is diagnostic only: it can show red, never green. */
export const CERTIFYING = RUNS >= CERTIFYING_RUNS

/**
 * Fail a diagnostic run that would otherwise pass. Call it AFTER the grading
 * assertions, so a grader failure still reports itself first.
 */
export function requireCertifying(): void {
  if (!CERTIFYING) {
    throw new Error(`non-certifying run: PLUR_AGENT_EVAL_RUNS=${process.env.PLUR_AGENT_EVAL_RUNS} gave ${RUNS} run(s); ` +
      `a promise needs all ${CERTIFYING_RUNS} runs to pass before it can be green. Use fewer runs only for a diagnostic or mutant check.`)
  }
}

/** Fail — never skip — when agent evals are switched off. */
export function requireEnabled(): void {
  if (process.env[ENV_SWITCH] !== '1') throw new Error(NOT_RUN)
}

/** The auth variable to hand the child, or a plain failure. */
export function authEnv(): Record<string, string> {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (oauth) return { CLAUDE_CODE_OAUTH_TOKEN: oauth }
  const key = process.env.ANTHROPIC_API_KEY
  if (key) return { ANTHROPIC_API_KEY: key }
  throw new Error('agent eval cannot run: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY for the claude CLI')
}

export function claudeExe(): string {
  const p = spawnSync('which', ['claude'], { encoding: 'utf8' })
  const exe = p.stdout.trim()
  if (p.status !== 0 || !exe) throw new Error('agent eval cannot run: the claude CLI is not on PATH')
  return exe
}

export function requireMcpBuilt(): void {
  if (!existsSync(MCP_DIST)) throw new Error(`agent eval cannot run: ${MCP_DIST} is missing — run \`pnpm -r build\` first`)
}

// ── isolation ───────────────────────────────────────────────────────────────

/** A fresh directory under os.tmpdir(); refuses anything inside the real home. */
export function freshDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `plur-agent-eval-${label}-`)))
  const realHome = realpathSync(userInfo().homedir)
  if (dir === realHome || dir.startsWith(realHome + sep)) {
    throw new Error(`agent eval workdir ${dir} is inside the real home ${realHome}; refusing`)
  }
  return dir
}

function childEnv(home: string, auth: Record<string, string>): Record<string, string> {
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const path = [dirname(process.execPath), dirname(claudeExe()), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
  return {
    PATH: [...new Set(path)].join(':'),
    HOME: home,
    USER: userInfo().username || 'eval',
    LANG: 'en_US.UTF-8',
    TMPDIR: join(home, 'tmp'),
    ...auth,
  }
}

// ── the store and the standing context ──────────────────────────────────────

/** A new store dir seeded through the real write path (Plur.learn). Returns its path and the seed ids. */
export async function seededStore(statements: string[]): Promise<{ dir: string; ids: string[] }> {
  const dir = freshDir('store')
  writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
  useEmbedder('off')
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  const ids: string[] = []
  for (const s of statements) ids.push((await plur.learn(s, { scope: 'global' })).id)
  return { dir, ids }
}

/**
 * Turn PLUR on for the run's working folder, through the same call
 * `plur folders set <folder> --on` makes. An undecided folder answers every
 * memory tool with the folder question instead of memory (#1525), so without
 * this the agent meets onboarding, not memory. A user who has memories for a
 * project has already said yes to its folder; this is that state.
 */
export async function folderOn(storeDir: string, folder: string, home: string): Promise<void> {
  const plur = new Plur({ path: storeDir, autoDiscover: false })
  await plur.ready()
  plur.setFolder(folder, { mode: 'on' }, { home })
  // Folder consent is a prerequisite of the scenario, set by the user before
  // the agent runs — never something the agent is expected to get past.
  const mode = plur.resolveFolderPolicy(folder, { home }).mode
  if (mode !== 'on') throw new Error(`precondition: memory should be on for ${folder} before the agent runs; the folder map says ${mode}`)
}

/** Every active memory's statement, read by a FRESH instance over `dir` — what a later session can really find. */
export async function persistedStatements(dir: string): Promise<string[]> {
  useEmbedder('off')
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  return (await plur.list()).filter(e => e.status === 'active').map(e => e.statement)
}

/** Keyword recall on a FRESH instance over `dir` — what is really on disk. */
export async function recallFrom(dir: string, query: string): Promise<string[]> {
  useEmbedder('off')
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  return (await plur.recall(query, { limit: 20 })).map(e => e.statement)
}

/**
 * The CLAUDE.md a real install leaves in a project: run `plur-mcp init` (from
 * dist, the shipped entry point) with cwd = the scaffold, in a throwaway HOME
 * and a throwaway store so nothing else it writes (user MCP config, hooks,
 * bundled packs) touches the run. Returns the CLAUDE.md text.
 */
export function installClaudeMd(scaffold: string, auth: Record<string, string>): string {
  requireMcpBuilt()
  const home = freshDir('init-home')
  const env = { ...childEnv(home, auth), PLUR_PATH: join(home, '.plur') }
  delete (env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN
  delete (env as Record<string, string>).ANTHROPIC_API_KEY
  const p = spawnSync(process.execPath, [MCP_DIST, 'init'], { cwd: scaffold, env, encoding: 'utf8', timeout: 120_000 })
  const file = join(scaffold, 'CLAUDE.md')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!text.includes('## PLUR Memory')) {
    throw new Error(`plur-mcp init did not write the PLUR section into ${file} (exit ${p.status}): ${(p.stdout + p.stderr).slice(-600)}`)
  }
  return text
}

/** --mcp-config JSON attaching the plur server to `storeDir`. */
export function writeMcpConfig(dir: string, storeDir: string): string {
  const file = join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify({
    mcpServers: {
      plur: {
        command: 'node',
        args: [MCP_DIST],
        // Downloads off: the memory server must not reach the network; with no
        // cached model it serves keyword search, which is enough for these seeds.
        env: { PLUR_PATH: storeDir, PLUR_MODEL_DOWNLOAD: 'off' },
      },
    },
  }, null, 2))
  return file
}

/** Copy a template scaffold into a fresh per-run working directory. */
export function copyScaffold(template: string, label: string): string {
  const dir = join(freshDir(label), 'work')
  cpSync(template, dir, { recursive: true })
  return dir
}

/** Files under `dir` (relative paths), skipping dot-dirs. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith('.')) continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p))
    }
  }
  walk(dir)
  return out.sort()
}

/** Files under `dir` with their text (skipping dot-dirs). */
export function readFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of listFiles(dir)) out[f] = readFileSync(join(dir, f), 'utf8')
  return out
}

// ── running a session ───────────────────────────────────────────────────────

export interface ToolCall { name: string; input: Record<string, unknown>; result: string; isError: boolean | null }

export interface AgentRun {
  text: string
  exitCode: number | null
  isError: boolean
  timedOut: boolean
  toolCalls: ToolCall[]
  costUsd: number
  numTurns: number
  sessionId: string
  stderrTail: string
}

/** Tools that are the plur MCP server's (direct, or via plur_admin { action }). Lives with the graders. */
export { plurCalls } from './agent-behaviour-graders.js'

export function parseStream(stdout: string): Omit<AgentRun, 'exitCode' | 'timedOut' | 'stderrTail'> {
  const calls: ToolCall[] = []
  const byId = new Map<string, ToolCall>()
  let result: Record<string, unknown> = {}
  let sessionId = ''
  for (const line of stdout.split('\n')) {
    let ev: Record<string, unknown>
    try { ev = JSON.parse(line) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    if (typeof ev.session_id === 'string') sessionId = ev.session_id
    const content = (ev.message as { content?: unknown } | undefined)?.content
    if (ev.type === 'assistant' && Array.isArray(content)) {
      for (const c of content as Array<Record<string, unknown>>) {
        if (c?.type === 'tool_use') {
          const call: ToolCall = { name: String(c.name), input: (c.input as Record<string, unknown>) ?? {}, result: '', isError: null }
          calls.push(call)
          byId.set(String(c.id), call)
        }
      }
    } else if (ev.type === 'user' && Array.isArray(content)) {
      for (const c of content as Array<Record<string, unknown>>) {
        const call = c?.type === 'tool_result' ? byId.get(String(c.tool_use_id)) : undefined
        if (!call) continue
        let body = c.content
        if (Array.isArray(body)) body = body.map(b => (b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : '')).join(' ')
        call.result = String(body ?? '')
        call.isError = (c.is_error as boolean | undefined) ?? null
      }
    } else if (ev.type === 'result') {
      result = ev
    }
  }
  return {
    text: String(result.result ?? ''),
    isError: Boolean(result.is_error) || !('result' in result),
    toolCalls: calls,
    costUsd: Number(result.total_cost_usd ?? 0),
    numTurns: Number(result.num_turns ?? 0),
    sessionId,
  }
}

export interface SessionOpts {
  prompt: string
  cwd: string
  home: string
  auth: Record<string, string>
  /** --mcp-config file; omitted = no MCP server at all (the control arm). */
  mcpConfig?: string
  /** Keep the session on disk so a second turn can --resume it. */
  persist?: boolean
  resume?: string
}

/** One headless claude invocation. Resolves; never throws on agent failure. */
export function runSession(o: SessionOpts): Promise<AgentRun> {
  const tools = ['Read(./**)', 'Write(./**)', 'Edit(./**)']
  if (o.mcpConfig) tools.unshift('mcp__plur', 'ToolSearch')
  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'project',
    '--model', MODEL, '--max-budget-usd', String(MAX_BUDGET_USD), '--max-turns', String(MAX_TURNS),
    '--allowedTools', ...tools]
  if (!o.persist && !o.resume) args.push('--no-session-persistence')
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig)
  if (o.resume) args.push('--resume', o.resume)
  const child = spawn(claudeExe(), args, { cwd: o.cwd, env: childEnv(o.home, o.auth), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  return new Promise(res => {
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, RUN_TIMEOUT_MS)
    child.on('close', code => {
      clearTimeout(timer)
      res({ ...parseStream(out), exitCode: code, timedOut, stderrTail: (err || out).slice(-800) })
    })
  })
}

// ── a language model for PLUR's AI checks (LRN-7) ───────────────────────────

/**
 * An LlmFunction (prompt in, text out) backed by the claude CLI, on the same
 * auth path as the agent sessions (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY,
 * passed to the child only). No tools, no MCP servers, no project settings, a
 * fresh HOME: the model sees the prompt PLUR built and nothing else.
 */
export function claudeLlm(auth: Record<string, string>, model: string = MODEL): (prompt: string) => Promise<string> {
  const exe = claudeExe()
  return (prompt: string) => new Promise((res, rej) => {
    const home = freshDir('llm-home')
    const child = spawn(exe, ['-p', prompt, '--output-format', 'json', '--model', model, '--tools', '',
      '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', String(MAX_BUDGET_USD)],
    { cwd: home, env: childEnv(home, auth), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('close', code => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out)
        if (j.is_error || typeof j.result !== 'string') throw new Error(String(j.result ?? 'no result'))
        res(j.result)
      } catch (e) {
        rej(new Error(`the claude CLI did not answer (exit ${code}): ${(e as Error).message} ${err.slice(-300)}`))
      }
    })
  })
}

// ── verdicts ────────────────────────────────────────────────────────────────

export interface Graded { ok: boolean; why: string; run: AgentRun }

/** Append a finished report to $PLUR_AGENT_EVAL_LOG when set (vitest hides console output of passing tests). */
export function logReport(text: string): void {
  console.log(text)
  const file = process.env.PLUR_AGENT_EVAL_LOG
  if (file) appendFileSync(file, `${new Date().toISOString()}\n${text}\n\n`)
}

/** A one-line-per-run report for failure messages and the eval log. */
export function report(title: string, graded: Graded[]): string {
  const lines = [`${title}: ${graded.filter(g => g.ok).length}/${graded.length} runs passed${CERTIFYING ? '' : ` (NON-CERTIFYING: fewer than ${CERTIFYING_RUNS} runs, cannot turn the promise green)`}`]
  graded.forEach((g, i) => {
    const r = g.run
    const flag = g.ok ? 'PASS' : 'FAIL'
    const extra = r.timedOut ? ' (timed out)' : r.isError ? ' (agent error)' : ''
    lines.push(`  run ${i + 1}: ${flag}${extra} cost=$${r.costUsd.toFixed(3)} turns=${r.numTurns} — ${g.why}`)
    lines.push(`    tools: ${r.toolCalls.map(c => c.name).join(', ') || '(none)'}`)
    lines.push(`    text: ${JSON.stringify(r.text.slice(0, 300))}`)
    if (r.isError && !r.text) lines.push(`    stderr: ${JSON.stringify(r.stderrTail.slice(-300))}`)
  })
  return lines.join('\n')
}
