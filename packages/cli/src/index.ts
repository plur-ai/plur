import { shouldOutputJson, outputJson, setQuiet, exit } from './output.js'
import { parseGlobalFlags, createPlur } from './plur.js'
import { unknownFlagMessage } from './known-flags.js'
import { exitWhenStoreIdle } from './lib/store-lock-exit.js'

export type { GlobalFlags } from './plur.js'
export { parseGlobalFlags, createPlur } from './plur.js'

import { CLI_VERSION as VERSION } from './version.js'

// --- Main ---
const argv = process.argv.slice(2)
// `--` ends option parsing (formal verification S4, 2026-09-26): a statement
// such as `plur learn -- "--help"` is data, not a request for help.
const sep = argv.indexOf('--')
const options = sep === -1 ? argv : argv.slice(0, sep)

// Hook probe (decision H3's Windows CI job): with PLUR_HOOK_PROBE set to a
// file path, a hook-* invocation appends its subcommand to that file and
// exits 0 without running. The job runs every hook string `plur init`
// generated through bash, pwsh and cmd, and this proves each one reached
// the CLI with the right subcommand. Unset (always, outside that job), it
// does nothing.
if (process.env.PLUR_HOOK_PROBE && /^hook-/.test(argv[0] ?? '')) {
  const { appendFileSync } = await import('fs')
  appendFileSync(process.env.PLUR_HOOK_PROBE, `${argv[0]}\n`)
  process.exit(0)
}

if (options.includes('--version') || options.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

if (options.includes('--help') || options.includes('-h') || argv.length === 0) {
  console.log(`plur v${VERSION} — persistent memory for AI agents

Usage: plur <command> [options]

Commands:
  learn <statement>       Create a new engram
  recall <query>          Search engrams
  inject <task>           Get relevant engrams for a task
  list                    List all engrams
  forget <id>             Retire an engram [--scope <scope>] (target one store, #831)
  restore [--list|--yes]  Inspect or restore a daily store snapshot (#799)
  ingest <content>        Extract and save engrams from content
  import                  Import memories from another system (issue #441)
                          --from <generic|gp-engram|mem0> --path <input-file>
                          [--dry-run] [--scope <s>] [--mapping <f>] [--store <dir>]
                          (for import, --path is the INPUT file; --store overrides storage)
  feedback <id> <signal>  Rate an engram (positive|negative|neutral)
  capture <summary>       Record an episode
  timeline [query]        Query episode timeline
  status                  System health check
  dashboard               Open the memory dashboard in a browser (alias: ui)
                          [--port N] [--host <addr>] [--allow-host <name>]... [--no-open]
  provenance <id|search>  Where a memory came from, and whether you may reuse it
  identity [value]        Who your memories are attributed to (--clear to unset)
  receipt [--days N]      What your memory retrieved for you
  sync                    Cross-device sync
  packs list              List installed packs
  packs install <source>  Install engram pack (--force: accept an integrity mismatch)
  packs export <name>     Export engrams as a pack
  packs migrate-integrity Re-baseline installed packs to sha256:v2: (dry run; --yes applies)
  similarity-search <q>   Search by cosine similarity with scores
  promote <id>            Promote an engram to active
  rescope <id...> --to <scope>  Move engram(s) to another scope (#676)
                          [--keep-local] [--dry-run]; also: promote <id> --to <scope>
  migrate [up|down|status] Run schema migrations
  stores list             List configured stores
  stores add <path>       Add a knowledge store
  stores add --url <u>    Add a remote store (verified; --scope, --token-env)
  stores prune            Remove config.yaml store entries that name the primary store file (#1356)
  remote                  Show this folder's team-store connection and check it (#1413)
  remote --url <u> --token <t> --scope <s>
                          Connect this folder to a team store (verified; [--scopes a,b])
  folders list            Your per-folder decisions (~/.plur/folders.yaml, #1347)
  folders repair [--yes]  Fix a broken folders.yaml: shows the change, asks, keeps a backup (#1526)
  folders set <folder>    --scope <s> | --on | --off | --ask  [--trusted|--no-trusted] [--nonce <n>]
  folders rm <folder>     Remove a folder's entry
  scopes                  List authorized-but-unregistered shared scopes (#647)
  scopes register <scope> Register one; scopes dismiss <scope>; scopes --reoffer
  outbox                  Show team-scoped writes queued for an unreachable store
                          [--flush] to retry them now (#667)
  reindex-tokens          Re-derive BM25 tokens after a tokenizer change (Postgres only)
  reindex-hashes          Repair engrams whose content_hash is stale or missing (#852)
  init                    Wire PLUR into detected harnesses (Claude Code, Cursor, Codex, Antigravity)
  login --status          Enterprise token validity per host (probe + expiry) (#587)
  init --keep-opencode-plugin  Keep an intentionally older OpenCode plugin pin
  init --keep-codex-mcp    Keep an intentionally older Codex MCP launch entry
  doctor --codex          Check Codex MCP version and token forwarding in this environment
  doctor                  Diagnose Claude Code / Claude Desktop / Cursor / Codex / Antigravity / opencode integration
  rerank-eval             Per-store reranker self-eval gate (advisory, #451)
                          [--reranker <name>] [--sample N] [--seed N] [--force]
  tensions [--scan]       List or scan for engram contradictions
  audit [--source X]      Audit working memory (claude-code|claw|hermes) for conflicts vs engrams
  hook-inject                   (internal) Hook handler for engram injection
  hook-observe            (internal) Hook handler for observation capture
  hook-learn-check        (internal) Hook handler for learning reflection
  hook-session-guard      (internal) Hook handler for session enforcement
  hook-session-end        (internal) SessionEnd hook — auto-close memory lifecycle
  hook-session-mark       (internal) Hook handler for session sentinel
  hook-session-remind     (internal) Hook handler for session start reminder
  hook-session-resume     (internal) SessionStart(resume) hook: re-ask the folder question
  hook-correction-detect  (internal) UserPromptSubmit hook — detect corrections
  hook-revert-detect      (internal) PostToolUse hook — detect revert operations
  hook-cursor-session-start (internal) Cursor sessionStart hook handler
  hook-cursor-guard      (internal) Cursor preToolUse hook handler
  hook-cursor-post-tool  (internal) Cursor postToolUse hook handler
  hook-cursor-stop       (internal) Cursor stop hook handler
  hook-auto-rate <editor> (internal) End-of-turn hook — rate injected engrams from the reply
  hook-codex-session-start (internal) Codex SessionStart hook handler
  hook-codex-inject      (internal) Codex UserPromptSubmit hook handler
  hook-codex-guard       (internal) Codex PreToolUse hook handler
  hook-codex-post-tool   (internal) Codex PostToolUse hook handler
  hook-codex-session-end (internal) Codex SessionEnd hook handler
  hook-agy-pre-invocation (internal) Antigravity PreInvocation hook handler
  hook-agy-guard         (internal) Antigravity PreToolUse hook handler

Global flags:
  --json       Force JSON output (auto-detected when piped)
  --path <dir> Override storage path (default: ~/.plur)
  --fast       Use BM25-only search (skip embeddings)
  --quiet      Suppress non-essential output (progress, confirmations, hints;
               results, warnings and errors still print)
  --version    Print version
  --help       Show this help`)
  process.exit(0)
}

const { flags, args, error: flagError } = parseGlobalFlags(argv)
// Before anything runs. A mistyped global flag must never reach a command that
// would then act on the wrong store.
if (flagError) exit(1, flagError)
// Arm --quiet globally (#730) so no output site can forget it. Commands still
// pass `flags` to outputInfo where available; this covers the ones that don't.
// hook-* commands are unaffected: their stdout is protocol JSON written
// directly, never through outputInfo.
setQuiet(flags.quiet === true)
// `plur -- learn x`: `--` ends option parsing, so what follows it is data —
// including the word that would have been the command. Say where it goes
// instead of reporting "Unknown command: --" (audit 1228-c #3).
if (args[0] === '--') {
  exit(1, args[1]
    ? `\`--\` goes after the command, not before it: plur ${args[1]} -- <value>`
    : "`--` goes after the command, not before it: plur <command> -- <value>. Run 'plur --help' for usage.")
}
const command = args[0]
const commandArgs = separatedArgs(command, args.slice(1))

const COMMANDS: Record<string, string> = {
  learn: './commands/learn.js',
  recall: './commands/recall.js',
  inject: './commands/inject.js',
  list: './commands/list.js',
  forget: './commands/forget.js',
  feedback: './commands/feedback.js',
  capture: './commands/capture.js',
  timeline: './commands/timeline.js',
  status: './commands/status.js',
  ui: './commands/ui.js',
  // `dashboard` is the documented canonical; `ui` remains as an alias.
  // Both names users guess land here — `dashboard` (minikube's convention,
  // and the word the release copy teaches) and `ui` (mlflow's convention).
  dashboard: './commands/ui.js',
  provenance: './commands/provenance.js',
  identity: './commands/identity.js',
  receipt: './commands/receipt.js',
  sync: './commands/sync.js',
  restore: './commands/restore.js',
  packs: './commands/packs.js',
  ingest: './commands/ingest.js',
  import: './commands/import.js',
  promote: './commands/promote.js',
  rescope: './commands/rescope.js',
  'similarity-search': './commands/similarity-search.js',
  stores: './commands/stores.js',
  remote: './commands/remote.js',
  // Hidden from --help (#1413, design r3): trust is granted by the ask flow,
  // `plur folders set <dir> --trusted` or the trust.yaml import. Both keep
  // working so existing scripts and runbooks do.
  trust: './commands/trust.js',
  untrust: './commands/untrust.js',
  folders: './commands/folders.js',
  scopes: './commands/scopes.js',
  outbox: './commands/outbox.js',
  'reindex-tokens': './commands/reindex-tokens.js',
  'reindex-hashes': './commands/reindex-hashes.js',
  migrate: './commands/migrate.js',
  init: './commands/init.js',
  // Hidden alias of `remote` (#1413); `--verify` is bare `plur remote`.
  'init-remote': './commands/init-remote.js',
  // `login` is registered for `--status` (#587: token validity per host). The
  // OAuth device flow itself (#532) stays GATED INSIDE the command — it is
  // happy-path only (no paste-token fallback, no refresh tokens) and targets
  // device-flow endpoints enterprise servers don't expose yet; attempting it
  // prints the sign-in-URL + plur_stores_add path instead. See #300.
  login: './commands/login.js',
  doctor: './commands/doctor.js',
  'rerank-eval': './commands/rerank-eval.js',
  tensions: './commands/tensions.js',
  audit: './commands/audit.js',
  'hook-inject': './commands/hook-inject.js',
  'hook-observe': './commands/hook-observe.js',
  'hook-learn-check': './commands/hook-learn-check.js',
  'hook-session-guard': './commands/hook-session-guard.js',
  'hook-session-end': './commands/hook-session-end.js',
  'hook-session-mark': './commands/hook-session-mark.js',
  'hook-session-remind': './commands/hook-session-remind.js',
  'hook-session-resume': './commands/hook-session-resume.js',
  'hook-correction-detect': './commands/hook-correction-detect.js',
  'hook-revert-detect': './commands/hook-revert-detect.js',
  'hook-cursor-session-start': './commands/hook-cursor-session-start.js',
  'hook-cursor-guard': './commands/hook-cursor-guard.js',
  'hook-cursor-post-tool': './commands/hook-cursor-post-tool.js',
  'hook-cursor-stop': './commands/hook-cursor-stop.js',
  'hook-auto-rate': './commands/hook-auto-rate.js',
  'hook-codex-session-start': './commands/hook-codex-session-start.js',
  'hook-codex-inject': './commands/hook-codex-inject.js',
  'hook-codex-guard': './commands/hook-codex-guard.js',
  'hook-codex-post-tool': './commands/hook-codex-post-tool.js',
  'hook-codex-session-end': './commands/hook-codex-session-end.js',
  'hook-agy-pre-invocation': './commands/hook-agy-pre-invocation.js',
  'hook-agy-guard': './commands/hook-agy-guard.js',
  // Hidden internal subcommand — spawned by `plur doctor` to isolate the
  // ONNX embedder probe (issue #197). If the probe crashes with SIGABRT
  // on libc++ thread pool cleanup, only the subprocess dies; doctor stays alive.
  '_embedder-probe': './commands/embedder-probe.js',
}

/**
 * Await any background derived-index work started during this process.
 *
 * Deliberately swallows failures: the index is derived, YAML is the source of
 * truth, and a command that already produced correct output must not exit
 * non-zero because a cache could not be warmed. Core records the failure for
 * `plur doctor` either way.
 */
async function drainPendingIndexWork(): Promise<void> {
  try {
    const { getLastPlurInstance } = await import('./plur.js')
    const plur = getLastPlurInstance?.()
    if (plur && typeof plur.waitForIndex === 'function') await plur.waitForIndex()
  } catch { /* derived index — never fail a command over it */ }
}

/**
 * `--` for the commands that do not parse it themselves (audit 1228-c #3).
 *
 * The global parser passes `--` through so a command can see where values
 * start. Eight commands read it (below); every other one took `--` as its
 * first positional — `plur trust -- <dir>` trusted a directory named `--`,
 * `plur feedback -- <id> positive` looked up the id `--`. For those the
 * separator is dropped and the values after it stay positional. They parse
 * any `-…` token as one of their own flags, so a value that begins with `-`
 * after `--` is refused rather than silently read as a flag.
 */
function separatedArgs(cmd: string | undefined, rest: string[]): string[] {
  const SEPARATOR_AWARE = new Set([
    'learn', 'recall', 'inject', 'forget', 'capture', 'timeline', 'similarity-search', 'ingest',
  ])
  const at = rest.indexOf('--')
  if (!cmd || at === -1 || SEPARATOR_AWARE.has(cmd) || cmd.startsWith('hook-')) return rest
  const values = rest.slice(at + 1)
  const dashed = values.find(v => v.startsWith('-'))
  if (dashed !== undefined) {
    exit(1, `plur ${cmd} cannot take a value that begins with "-" (got ${JSON.stringify(dashed)}), even after \`--\`.`)
  }
  return [...rest.slice(0, at), ...values]
}

if (!command || !COMMANDS[command]) {
  exit(1, `Unknown command: ${command}. Run 'plur --help' for usage.`)
}

try {
  const mod = await import(COMMANDS[command])
  // A command that declares its flags gets them checked (#986). One that does
  // not is unchanged, so this is adopted per command rather than all at once.
  if (Array.isArray(mod.FLAGS)) {
    const complaint = unknownFlagMessage(
      commandArgs, mod.FLAGS as string[], (mod.FLAGS_WITH_VALUES as string[]) ?? [])
    if (complaint) exit(1, complaint)
  }
  await mod.run(commandArgs, flags)
  // #1046: background index work (the PGLite initial sync when that backend
  // is opted into, and the Postgres auto-embed pass — both tracked on
  // waitForIndex()) used to be abandoned by every command except `sync`,
  // which on PGLite meant a full-corpus pass restarted and killed on every
  // invocation: the index never converged, found 64MB on disk with no
  // `engrams` table at all. The default SQLite tier does no constructor-time
  // background sync, so for most installs this drain is a no-op; where it
  // isn't, the fingerprint guard makes an unchanged YAML nearly free.
  await drainPendingIndexWork()
} catch (err: any) {
  // Hook commands never print errors to stdout (owner decision H1, formal
  // field report cluster 5). An editor parses a hook's stdout as its result
  // and shows a non-zero exit as a hook error, so an `{"error"}` document
  // there — e.g. from an injection that threw after the watchdog had stopped
  // the run — breaks the turn instead of failing open. Stderr, exit 0.
  // Every other command keeps its error document and exit 1.
  //
  // The exit goes through exitWhenStoreIdle (#1349): the throw can arrive
  // while a store write of this process is still in flight (the hybrid search
  // a hook abandoned at its deadline records its injection under
  // `engrams.yaml.lock`), and exiting there leaves that lock behind for every
  // later writer. Bounded, and immediate when the store is idle.
  if (command.startsWith('hook-')) {
    process.stderr.write(`[plur] ${command} failed: ${err?.message ?? 'unknown error'}\n`)
    await exitWhenStoreIdle()
  }
  if (shouldOutputJson(flags)) {
    outputJson({ error: err.message })
  } else {
    exit(1, `Error: ${err.message}`)
  }
  process.exit(1)
}
