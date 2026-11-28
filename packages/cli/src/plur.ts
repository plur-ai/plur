import { isatty } from 'tty'
import { Plur, folderMapProblem, type ProjectConfig } from '@plur-ai/core'
import { join, resolve } from 'path'
import { homedir } from 'os'
import type { OutputOptions } from './output.js'

export interface GlobalFlags extends OutputOptions {
  path?: string
  fast?: boolean
}

/** Parse global flags from argv, return remaining positional args + flags. */
/**
 * Split `--flag=value` into `--flag` and `value` for every command at once
 * (parsers expect a separate value and would silently drop it). Only the first
 * `=` splits; positional arguments and the `--` separator pass through.
 */
export function expandEqualsFlags(argv: string[]): string[] {
  const out: string[] = []
  let seenSeparator = false
  for (const arg of argv) {
    if (arg === '--') { seenSeparator = true; out.push(arg); continue }
    const m = seenSeparator ? null : /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(arg)
    if (m) { out.push(m[1], m[2]) } else { out.push(arg) }
  }
  return out
}

/** Long flags every command understands. */
const GLOBAL_NAMES = ['--json', '--quiet', '--fast', '--path', '--help', '--version']

/** Edit distance, for catching a near miss like `--pathh`. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1])
    }
  }
  return rows[a.length][b.length]
}

export function parseGlobalFlags(rawArgv: string[]): {
  flags: GlobalFlags; args: string[]; error?: string
} {
  const argv = expandEqualsFlags(rawArgv)
  const flags: GlobalFlags = {}
  const args: string[] = []
  let error: string | undefined
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    // `--` ends option parsing. Everything after it
    // is passed to the command verbatim, `--` included so the command can see
    // where values start: a statement such as "--path=/elsewhere …" must never
    // select — or create — a store, and "--json" after `--` is a value.
    if (arg === '--') { args.push(...argv.slice(i)); break }
    if (arg === '--json') { flags.json = true; i++ }
    else if (arg === '--quiet') { flags.quiet = true; i++ }
    else if (arg === '--fast') { flags.fast = true; i++ }
    else if (arg === '--path') {
      // A missing value must not leave --path unset, or the command would
      // silently run against the DEFAULT store instead of the one named.
      const value = argv[i + 1]
      if (value === undefined || /^--[A-Za-z]/.test(value)) {
        error = error ?? `--path needs a directory, but the next argument was ${value ?? '(nothing)'}.`
        i += 1
      } else if (flags.path !== undefined && flags.path !== value) {
        // security audit 2026-11-06: a later --path (maybe a flag value) must not override the first
        error = error ?? `--path was given twice with different directories (${flags.path} and ${value}); `
          + 'refusing to guess which store you meant.'
        i += 2
      } else { flags.path = value; i += 2 }
    }
    else {
      // A near miss on `--path` is caught for EVERY command, whether or not it
      // declares its own flags: a mistyped `--path` would pass through as a
      // positional argument and the command would run against the user's real
      // store. Every other global flag mistyped is merely ignored.
      //
      // ONLY `--path`, and only ONE edit. A wider net rejects legitimate
      // command flags (`--batch` and `--date` are two edits from `--path`).
      // This runs before the command is loaded and cannot consult what it
      // declares, so the distance must be tight enough that no declared flag
      // falls inside it; test/known-flags.test.ts sweeps every flag literal in
      // this package against this check.
      if (/^--[A-Za-z]/.test(arg) && !GLOBAL_NAMES.includes(arg) && editDistance(arg, '--path') <= 1) {
        error = error ?? `Unrecognised flag ${arg} — did you mean --path? `
          + 'Left as it is, this command would run against your default store rather than the one you named.'
      }
      args.push(arg); i++
    }
  }
  return { flags, args, error }
}

/**
 * The most recent Plur built in this process.
 *
 * The CLI entrypoint needs a handle on it to drain background index work
 * before exiting, and commands construct their own instance rather than
 * receiving one. Last-wins is the working assumption: a CLI process runs one
 * command, and the commands that build more than one build them against the
 * same store — `import` with `--store` routes through createPlur precisely
 * so this stays true.
 */
let lastInstance: Plur | null = null

/** The last Plur constructed in this process, or null if none was. */
export function getLastPlurInstance(): Plur | null {
  return lastInstance
}

/**
 * Create Plur instance from flags.
 * `readonly: true`: reads work, mutations throw `ReadonlyStoreError`, recall
 * skips activation refresh; pure queries pass it so they cannot mutate the store.
 * `autoDiscover: false` skips registering a `<cwd>/.plur` store in config.yaml;
 * the folder question passes it so asking changes nothing.
 */
/**
 * Who the CLI writes for (overhaul D2, audit S1). The pinning policy
 * (`pinning.agents`) restricts an agent, never the owner. A person at a
 * terminal is the owner. The CLI is an agent when:
 *   - it runs a `hook-*` command (an editor runs those inside an agent
 *     session — set by the entry point through {@link setCliActor});
 *   - `PLUR_ACTOR=agent` is set (a wrapper driving the CLI for an agent);
 *   - an agent environment is detected ({@link agentEnvironmentMarker}) —
 *     an agent's shell tool runs the CLI with its harness's variables;
 *   - stdin is not a terminal — an agent's shell tool, a pipe, a script.
 * `PLUR_ACTOR=owner` overrides the last two. An agent can set it too, so the
 * commands that grant pins or apply journalled changes under a restrictive
 * policy also need a confirmation typed at a terminal (lib/pin-confirm.ts).
 */
let cliActor: 'owner' | 'agent' = 'owner'
export function setCliActor(actor: 'owner' | 'agent'): void { cliActor = actor }

/**
 * Environment variables agent harnesses set in the shells they run commands
 * in: Claude Code (CLAUDECODE), Codex (CODEX_SANDBOX, CODEX_THREAD_ID), the
 * Cursor agent (CURSOR_AGENT), Gemini CLI / Antigravity (GEMINI_CLI,
 * ANTIGRAVITY_AGENT), opencode (OPENCODE). Best effort: a harness that sets
 * none still runs commands without a terminal, which the stdin check catches.
 */
export const AGENT_ENV_MARKERS = ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'ANTIGRAVITY_AGENT', 'OPENCODE'] as const

/** The first agent marker set (non-empty, not "0") in `env`, or null. */
export function agentEnvironmentMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of AGENT_ENV_MARKERS) {
    const v = env[k]
    if (v !== undefined && v !== '' && v !== '0') return k
  }
  return null
}

export function resolveCliActor(env: NodeJS.ProcessEnv = process.env, stdinIsTTY: boolean = isatty(0)): 'owner' | 'agent' {
  if (env.PLUR_ACTOR === 'agent' || cliActor === 'agent') return 'agent'
  if (env.PLUR_ACTOR === 'owner') return 'owner'
  if (agentEnvironmentMarker(env)) return 'agent'
  return stdinIsTTY ? 'owner' : 'agent'
}

export function createPlur(flags: GlobalFlags, options?: { readonly?: boolean; autoDiscover?: boolean }): Plur {
  const path = flags.path || process.env.PLUR_PATH || undefined
  lastInstance = new Plur({
    path,
    readonly: options?.readonly,
    actor: resolveCliActor(),
    ...(options?.autoDiscover !== undefined ? { autoDiscover: options.autoDiscover } : {}),
  })
  // Every command is bound to the folder it runs in, so
  // `plur learn`, `recall`, `inject`, `capture`, `import` … obey a remote-only
  // folder exactly as the hooks and the MCP server do. Hooks re-bind to the
  // folder their payload names, failing closed (bindHookFolder).
  //
  // A folder map that cannot be read, or a folder that cannot be resolved,
  // leaves a CLI command unbound: local memory still prints and
  // folderReadContext contacts no store. Binding only looks: it never imports
  // a legacy trust.yaml.
  const cwd = process.cwd()
  try {
    // Checked first, silently: the CLI's own notice about a broken map is
    // folderReadContext's, said once.
    if (folderMapProblem(lastInstance.storageRoot)) return lastInstance
    const policy = lastInstance.resolveFolderPolicy(cwd, { readOnly: true })
    if (policy.reason !== 'malformed-map' && policy.reason !== 'resolver-error') lastInstance.bindFolderPolicy(cwd, policy)
  } catch { /* unbound, as above */ }
  return lastInstance
}


/**
 * One argument of a command printed for the user or the agent to run, or null
 * when it cannot be quoted safely. POSIX: single quotes. Windows: double quotes, which
 * PowerShell and cmd still expand for $, backtick, %, ! and the curly double
 * quotes, so a path holding one gets no command. A line break, bidi or
 * zero-width character never gets one.
 */
function shellWord(s: string, platform: NodeJS.Platform = process.platform): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(s)) return null
  if (/^[A-Za-z0-9_@+=:,./~-]+$/.test(s)) return s
  if (platform === 'win32') {
    if (/[$`%!"\u201c\u201d\u201e]/.test(s) || s.endsWith('\\')) return null
    return `"${s}"`
  }
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The trust command a notice tells the user to run.
 *
 * `plur trust <dir>` writes `trust.yaml` in the store the CLI resolves —
 * `--path`, else `PLUR_PATH`, else `~/.plur`. A hook or server running on a
 * different store (its own `PLUR_PATH`, `--path`, an MCP config's env) checks
 * THAT store's file, and the user's shell usually has none of those set, so
 * the bare command would write a grant the adapter never reads. So when the
 * store is not the default one, the command names it.
 */
export function trustCommand(dir: string | null, storageRoot?: string, platform: NodeJS.Platform = process.platform): string | null {
  const target = dir === null ? '<dir>' : shellWord(dir, platform)
  if (target === null) return null
  if (!storageRoot || resolve(storageRoot) === resolve(join(homedir(), '.plur'))) return `plur trust ${target}`
  const store = shellWord(resolve(storageRoot), platform)
  return store === null ? null : `plur --path ${store} trust ${target}`
}
