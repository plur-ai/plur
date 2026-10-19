// Run the PLUR CLI (packages/cli) and the MCP entry point (packages/mcp) from
// SOURCE in a child process, through the tsx loader, so a planted bug in
// packages/** takes effect without a rebuild. Hooks are separate processes in
// real use (stdin payload in, JSON on stdout, exit code), so they are driven
// the same way here.
//
// tsx is not a direct dependency of the repo root; it is installed as a peer
// of tsup (a root devDependency), and is resolved through it. When it cannot
// be found the eval fails with a plain message; it never skips.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = resolve(__dirname, '..', '..')
const ENTRY = {
  cli: join(REPO, 'packages', 'cli', 'src', 'index.ts'),
  mcp: join(REPO, 'packages', 'mcp', 'src', 'index.ts'),
} as const

export function tsxLoader(): string {
  try {
    const fromTsup = createRequire(createRequire(join(REPO, 'package.json')).resolve('tsup'))
    return fromTsup.resolve('tsx/esm')
  } catch (err) {
    throw new Error(
      'Cannot run the CLI from source: the tsx loader was not found (looked for it as a peer of tsup ' +
      `from the repo root). Run "pnpm install" at the repo root. (${(err as Error).message})`,
    )
  }
}

export interface Ran { status: number | null; stdout: string; stderr: string; ms: number }

/** Run `node --import tsx [--import preload] packages/<pkg>/src/index.ts ...args`. */
export function runSource(
  pkg: keyof typeof ENTRY,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; input?: string; timeoutMs?: number; preload?: string },
): Ran {
  const nodeArgs = ['--import', tsxLoader(), ...(opts.preload ? ['--import', opts.preload] : []), ENTRY[pkg], ...args]
  const t0 = Date.now()
  const r: SpawnSyncReturns<string> = spawnSync(process.execPath, nodeArgs, {
    env: opts.env, cwd: opts.cwd, input: opts.input ?? '', encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
  })
  const ms = Date.now() - t0
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code
    if (code !== 'ETIMEDOUT') {
      throw new Error(`could not run ${pkg} ${args.join(' ')}: ${r.error.message}\nstderr: ${r.stderr}`)
    }
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms }
}

/** A throwaway HOME for one install or one hook session. */
export interface HookHome {
  home: string
  /** Where hook-inject and the session guard keep per-session state. */
  sessions: string
  env: NodeJS.ProcessEnv
  cleanup(): void
}

/**
 * HOME, TMPDIR and the store all inside one temp dir. The folder is marked as
 * using PLUR (a `.mcp.json` naming the plur server, as a project set up for
 * PLUR has), so the hooks do their work instead of asking. Embeddings are off:
 * keyword search only, deterministic, never the real model.
 */
export function hookHome(): HookHome {
  const home = mkdtempSync(join(tmpdir(), 'plur-eval-hooks-'))
  mkdirSync(join(home, 'tmp'), { recursive: true })
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'), OPENCODE_CONFIG_DIR: '', CODEX_HOME: join(home, '.codex'),
    PLUR_PATH: join(home, '.plur'),
    PLUR_BACKEND: '', PLUR_POSTGRES_URL: '', PLUR_TELEMETRY: '',
    PLUR_DISABLE_EMBEDDINGS: '1', PLUR_REMOTE_RECALL: 'off',
  }
  for (const k of ['CLAUDE_SESSION_ID', 'PLUR_HOOK_HYBRID', 'PLUR_HOOK_HYBRID_DEADLINE_MS', 'PLUR_HOOK_CEILING_MS', 'PLUR_LOCK_STALE_MS']) delete env[k]
  return {
    home, sessions: join(home, 'tmp', 'plur-sessions'), env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

/** Seed one memory into the hook home's store through the CLI. */
export function seed(h: HookHome, statement: string): void {
  const r = runSource('cli', ['learn', statement, '--scope', 'global'], { env: h.env, cwd: h.home })
  if (r.status !== 0) throw new Error(`could not seed a memory: exit ${r.status}\n${r.stderr}`)
}

/** Send one prompt to hook-inject; return what the agent is given (additionalContext), '' when nothing. */
export function prompt(h: HookHome, sessionId: string, text: string, opts: { preload?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Ran & { context: string } {
  const r = runSource('cli', ['hook-inject'], {
    env: { ...h.env, ...(opts.env ?? {}) }, cwd: h.home, preload: opts.preload, timeoutMs: opts.timeoutMs,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: text, cwd: h.home }),
  })
  let context = ''
  if (r.stdout.trim()) {
    try { context = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' } catch {
      throw new Error(`hook-inject printed something that is not hook JSON: ${r.stdout.slice(0, 300)}`)
    }
  }
  return { ...r, context }
}
