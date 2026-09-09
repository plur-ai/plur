import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { readProjectConfig, updateProjectConfig, findProjectConfigPath, atomicWrite, withLock } from '@plur-ai/core'
import { type GlobalFlags } from '../plur.js'
import { outputText, outputInfo, outputError } from '../output.js'

/**
 * plur init-remote — opt this project into recall-from-Enterprise.
 *
 * Writes/updates `.plur.yaml` at the current directory with the remote
 * fields so that the UserPromptSubmit hook (hook-inject) calls Enterprise
 * via POST /api/v1/inject on every prompt instead of (or before) the
 * local PLUR store.
 *
 * Privacy guarantee: only projects that have run this command (and
 * therefore have a .plur.yaml with remote_url + remote_token) will route
 * their prompts to Enterprise. Personal/non-project sessions stay local.
 *
 * Side effects:
 *   - Creates/updates `.plur.yaml` in cwd (idempotent — preserves existing
 *     keys; updates the remote_* fields).
 *   - Adds `.plur.yaml` to `.gitignore` (the file holds an API key).
 *
 * Usage:
 *   plur init-remote --url https://plur.datafund.io --token plur_ent_abc
 *   plur init-remote --url https://plur.datafund.io --token plur_ent_abc \
 *     --scopes "org:plur,group:plur/engineering"
 *   plur init-remote --verify   # connectivity check against an existing config
 */

const HELP = `plur init-remote — opt this project into recall from PLUR Enterprise

USAGE
  plur init-remote --url <enterprise-url> --token <api-key> [--scopes <list>]
  plur init-remote --verify   Check connectivity against existing .plur.yaml

OPTIONS
  --url URL           Enterprise base URL, e.g. https://plur.datafund.io
  --token KEY         API key for authentication
  --scopes SCOPES     Optional comma-separated scope whitelist
                      e.g. "org:plur,group:plur/engineering"
  --no-gitignore      Skip adding .plur.yaml to .gitignore (NOT RECOMMENDED —
                      the token is sensitive)
  --verify            Read existing .plur.yaml and test the /api/v1/me
                      endpoint against the configured remote

WHAT THIS DOES
  Writes .plur.yaml in the current directory with remote_url, remote_token,
  and optional remote_scopes fields. The UserPromptSubmit hook will then
  call \${remote_url}/api/v1/inject for each prompt (before falling back to
  local PLUR). The hook walks upward from the current working directory to
  find .plur.yaml, so you can work from any subdirectory.

  WITHOUT this command, projects stay 100% local-only and Enterprise
  never sees their prompts.
`

interface ParsedArgs {
  url?: string
  token?: string
  scopes?: string[]
  noGitignore?: boolean
  verify?: boolean
  help?: boolean
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {}
  // Value-bearing flags require a following argument that is not itself
  // another flag. Missing or flag-shaped values are explicit errors
  // rather than silent "undefined" coercions (critic #5, cto #2,
  // data #EC02, dijkstra #8).
  const consumeValue = (i: number, flag: string): { value: string } | { error: string } => {
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      return { error: `${flag} requires a value (got ${next === undefined ? 'nothing' : `another flag: ${next}`})` }
    }
    return { value: next }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h')  { out.help = true; continue }
    if (a === '--verify')              { out.verify = true; continue }
    if (a === '--no-gitignore')        { out.noGitignore = true; continue }
    if (a === '--url' || a === '--token' || a === '--scopes') {
      const r = consumeValue(i, a)
      if ('error' in r) return r
      i++
      if (a === '--url')    out.url = r.value
      if (a === '--token')  out.token = r.value
      if (a === '--scopes') out.scopes = r.value.split(',').map(s => s.trim()).filter(Boolean)
      continue
    }
  }
  return out
}

/**
 * Add `.plur.yaml` to the project's .gitignore if not already present.
 *
 * Bounded by the .git boundary (dijkstra #2, critic #2):
 *   - Walk upward looking for the nearest .gitignore, but stop at the
 *     directory containing .git (the project root). Never escape into
 *     a parent monorepo's gitignore or — worse — into the user's
 *     global ~/.gitignore.
 *   - If no .gitignore is found within the project tree, create one
 *     in the same directory as .plur.yaml (cwd).
 *   - Uses dirname() to avoid accumulating `..` components, which
 *     `join(dir, '..')` does silently.
 */
function ensureGitignore(): { path: string; action: 'added' | 'already' | 'created' } {
  const home = resolve(homedir())
  let dir = resolve(process.cwd())
  let gitignorePath: string | null = null
  const MAX_DEPTH = 12
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = join(dir, '.gitignore')
    if (existsSync(candidate)) { gitignorePath = candidate; break }
    // Stop at .git boundary — don't escape the project.
    if (existsSync(join(dir, '.git'))) break
    // Hard ceilings: home, root.
    if (dir === home || dir === '/' || dir === '.') break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const PATTERN = '.plur.yaml'

  const target = gitignorePath ?? join(process.cwd(), '.gitignore')
  return withLock(target, () => {
    const exists = existsSync(target)
    const content = exists ? readFileSync(target, 'utf8') : ''
    // The final matching rule wins: a later !.plur.yaml must not undo the
    // protection while an earlier occurrence makes setup report success.
    const rules = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    if (rules.at(-1) === PATTERN) return { path: target, action: 'already' }
    const sep = content && !content.endsWith('\n') ? '\n' : ''
    atomicWrite(target, `${content}${sep}# Added by 'plur init-remote' — .plur.yaml may hold an API token\n${PATTERN}\n`, { mode: 0o644 })
    return { path: target, action: exists ? 'added' : 'created' }
  })

}

/**
 * Verify connectivity: GET ${url}/api/v1/me with the token.
 * Returns the response body or throws with a useful message.
 *
 * URL normalization uses `new URL().origin` — same approach as
 * hook-inject.ts tryRemoteInject. The earlier regex-strip diverged from
 * the hook: a remote_url with any path component (`/api`, `/sse/...`)
 * passed --verify with a wrong probe URL while the hook normalized
 * correctly to the origin (critic NEW-2).
 *
 * clearTimeout deferred to finally — same fix as tryRemoteInject. The
 * earlier early-clear pattern released the abort guard before r.json()
 * began, leaving a stalled body read unprotected (dijkstra NEW-5).
 */
async function verifyConnectivity(url: string, token: string): Promise<{ username: string; org_id: string; scopes: string[] }> {
  let base: string
  try {
    base = new URL(url).origin
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  const probeUrl = `${base}/api/v1/me`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch(probeUrl, {
      signal: ctrl.signal,
      headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json' },
    })
    if (r.status === 401) throw new Error(`401 Unauthorized — check your API token`)
    if (r.status === 403) throw new Error(`403 Forbidden — token lacks /me access`)
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${probeUrl}`)
    const data = await r.json() as { username?: string; org_id?: string; scopes?: string[] }
    if (!data.username) throw new Error(`Unexpected response shape from ${probeUrl}`)
    return {
      username: data.username,
      org_id:   data.org_id ?? '(unknown)',
      scopes:   Array.isArray(data.scopes) ? data.scopes : [],
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  // This command reports progress as prose across ~35 messages and has no
  // machine-readable result to offer. It used to accept `--json` and print that
  // prose anyway, so a caller parsing stdout got a syntax error rather than an
  // answer. Refusing is the honest response; silently ignoring the flag is not.
  if (flags.json === true) {
    process.stderr.write(
      'Error: init-remote does not support --json — it is an interactive setup command with no structured result.\n' +
      'Run it without --json, or use `plur init-remote --verify` and check the exit code.\n',
    )
    process.exit(1)
  }

  const parsed = parseArgs(args)
  if ('error' in parsed) {
    outputError(`Error: ${parsed.error}\n\n${HELP}`)
    process.exit(1)
  }
  const opts = parsed

  if (opts.help) {
    outputText(HELP) // explicitly requested — never suppressed
    return
  }

  const configPath = join(process.cwd(), '.plur.yaml')

  // --verify mode — connectivity check against existing config.
  // Walk upward to find the nearest .plur.yaml, matching the hook's
  // discovery so `--verify` from a project subdirectory finds the same
  // config the hook would actually use (data #EC06).
  if (opts.verify) {
    const verifyPath = findProjectConfigPath() ?? configPath
    const cfg = readProjectConfig(process.cwd())
    if (!cfg.remote_url || !cfg.remote_token) {
      outputError(`No remote config found (walked upward from ${process.cwd()}). Run \`plur init-remote --url <url> --token <key>\` first.`)
      process.exit(1)
    }
    outputInfo(`Using config at ${verifyPath}`, flags)
    try {
      const me = await verifyConnectivity(cfg.remote_url, cfg.remote_token)
      // The verify result IS the requested output — never suppressed.
      outputText(`✓ Connected to ${cfg.remote_url} as ${me.username} (org: ${me.org_id})`)
      outputText(`  readable scopes: ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}`)
    } catch (err) {
      outputError(`✗ Connection failed: ${(err as Error).message}`)
      process.exit(2)
    }
    return
  }

  // Setup mode — validate inputs
  if (!opts.url || !opts.token) {
    outputError(`Missing required flags.\n${HELP}`)
    process.exit(1)
  }

  // Reject control characters in the token — they corrupt the YAML write
  // and silently break the parser (data #EC09).
  if (/[\n\r\t]/.test(opts.token)) {
    outputError(`Error: token contains newline/tab characters. Refusing to write a corrupt config.`)
    process.exit(1)
  }

  // Validate URL — fail fast on schemes other than http/https.
  try {
    const u = new URL(opts.url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      outputError(`Error: remote_url must be http:// or https:// (got ${u.protocol})`)
      process.exit(1)
    }
  } catch {
    outputError(`Error: remote_url is not a valid URL: ${opts.url}`)
    process.exit(1)
  }

  // Test connectivity before writing the config — fail-fast saves the user
  // from a confusing "hook is silent" mystery if the token is wrong.
  outputInfo(`Testing connectivity to ${opts.url}...`, flags)
  try {
    const me = await verifyConnectivity(opts.url, opts.token)
    outputInfo(`✓ Authenticated as ${me.username} (org: ${me.org_id})`, flags)
    outputInfo(`  readable scopes: ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}`, flags)
  } catch (err) {
    outputError(`✗ Connection failed: ${(err as Error).message}`)
    outputError(`  Refusing to write a broken config. Fix the URL/token and re-run.`)
    process.exit(2)
  }

  // Persist ignore protection BEFORE publishing the token-bearing config.
  if (!opts.noGitignore) {
    const gi = ensureGitignore()
    if (gi.action === 'added') outputInfo(`✓ Added .plur.yaml to ${gi.path}`, flags)
    else if (gi.action === 'created') outputInfo(`✓ Created ${gi.path} with .plur.yaml entry`, flags)
    else outputInfo(`✓ ${gi.path} already excludes .plur.yaml`, flags)
  } else {
    // The token is now committed-able — outcome differs from the safe default;
    // never suppressed (#730).
    outputText(`⚠ Skipped .gitignore (--no-gitignore). The token in .plur.yaml is sensitive.`)
  }

  // Write/update .plur.yaml
  updateProjectConfig(configPath, { remote_url: opts.url, remote_token: opts.token, remote_scopes: opts.scopes })
  outputInfo(`✓ Wrote ${configPath}`, flags)
  if (opts.scopes && opts.scopes.length > 0) {
    outputInfo(`  scope whitelist: ${opts.scopes.join(', ')}`, flags)
  } else {
    outputInfo(`  scope whitelist: (none — hook will query all readable scopes)`, flags)
  }


  outputInfo(`\nDone. The UserPromptSubmit hook will now query ${opts.url} on every prompt`, flags)
  outputInfo(`from this directory tree (bounded by the nearest .git). Personal/non-project`, flags)
  outputInfo(`sessions (without a .plur.yaml in the path) stay local-only.`, flags)
  outputInfo(``, flags)
  outputInfo(`⚠ Token sensitivity:`, flags)
  outputInfo(`  .plur.yaml now contains an API token in plaintext.`, flags)
  outputInfo(`  - .gitignore protects against git commits but NOT against cloud sync`, flags)
  outputInfo(`    (iCloud Drive, Dropbox, Google Drive). If this project lives in a`, flags)
  outputInfo(`    synced folder, the token will leave your machine.`, flags)
  outputInfo(`  - Also not protected: \`cp -r\`, \`zip\`, \`rsync\`, archived backups.`, flags)
  outputInfo(`  - Consider moving the token to an env var if your project ships with`, flags)
  outputInfo(`    others (future: env-var substitution in .plur.yaml).`, flags)
}
