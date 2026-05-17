import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { outputText } from '../output.js'

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
 * Strip the existing remote_* keys from .plur.yaml content so we can
 * append a fresh block — keeps non-remote keys (domain, scope) intact.
 *
 * Fixed (cto #1, data #EC03, dijkstra #5):
 *   - Blank lines INSIDE a remote_scopes list no longer terminate the
 *     skip. Only a non-dash, non-blank line breaks out.
 *   - Block-scalar marker (`remote_scopes: |` / `>`) also triggers list
 *     skipping, matching the parser's accepted forms.
 *   - The list-skip activates whenever the value-after-colon is empty
 *     OR is one of the block-scalar markers, regardless of trailing
 *     whitespace.
 */
function stripRemoteKeys(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skippingList = false
  const REMOTE_KEY = /^remote_(url|token|scopes)\s*:(.*)$/
  for (const line of lines) {
    const trimmed = line.trim()
    if (skippingList) {
      // Inside a previous remote_scopes list — skip dash items AND
      // intervening blank lines. Only break out when a non-dash
      // non-blank line appears.
      if (trimmed === '' || trimmed.startsWith('-')) continue
      skippingList = false
    }
    const m = trimmed.match(REMOTE_KEY)
    if (m) {
      const key = m[1]
      const rest = m[2].trim()
      // If remote_scopes had an empty or block-scalar value, the next
      // lines are dash items — keep skipping.
      if (key === 'scopes' && (rest === '' || rest === '|' || rest === '>')) {
        skippingList = true
      }
      continue
    }
    out.push(line)
  }
  // Remove trailing blank lines that result from key removal
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n')
}

/**
 * Append remote_url, remote_token, and (optional) remote_scopes to the
 * existing .plur.yaml content. Returns the new file body.
 */
function buildConfigBody(existing: string, url: string, token: string, scopes?: string[]): string {
  const stripped = stripRemoteKeys(existing)
  const sep = stripped.length > 0 && !stripped.endsWith('\n') ? '\n\n' : (stripped.length > 0 ? '\n' : '')
  const block: string[] = []
  block.push('# --- PLUR Enterprise remote (opt-in for this project) ---')
  block.push('# remote_token is sensitive — keep .plur.yaml in .gitignore.')
  block.push(`remote_url: ${url}`)
  block.push(`remote_token: ${token}`)
  if (scopes && scopes.length > 0) {
    block.push('remote_scopes:')
    for (const s of scopes) block.push(`  - ${s}`)
  }
  return stripped + sep + block.join('\n') + '\n'
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

  if (!gitignorePath) {
    // No .gitignore found within the project — create one alongside .plur.yaml.
    const newPath = join(process.cwd(), '.gitignore')
    writeFileSync(newPath, `# Added by 'plur init-remote' — .plur.yaml may hold an API token\n${PATTERN}\n`)
    return { path: newPath, action: 'created' }
  }

  const content = readFileSync(gitignorePath, 'utf8')
  // Crude but safe — match the literal pattern as a whole word
  const already = content.split('\n').some(l => l.trim() === PATTERN)
  if (already) return { path: gitignorePath, action: 'already' }

  const sep = content.endsWith('\n') ? '' : '\n'
  appendFileSync(gitignorePath, `${sep}# Added by 'plur init-remote' — .plur.yaml may hold an API token\n${PATTERN}\n`)
  return { path: gitignorePath, action: 'added' }
}

/**
 * Walk upward from cwd to find the nearest existing .plur.yaml.
 * Mirrors hook-inject.ts findProjectConfigPath but locally scoped here
 * to avoid a cross-command import. Same boundaries: .git, home, root.
 */
function findExistingConfigPath(): string | null {
  const home = resolve(homedir())
  let dir = resolve(process.cwd())
  const MAX_DEPTH = 12
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (dir !== home) {
      const candidate = join(dir, '.plur.yaml')
      if (existsSync(candidate)) return candidate
    }
    if (existsSync(join(dir, '.git'))) return null
    if (dir === home || dir === '/' || dir === '.') return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Read existing .plur.yaml fields the parser cares about — minimal,
 * matches the line-by-line approach in hook-inject.ts.
 */
interface ReadConfig {
  url?: string
  token?: string
}
function readRemoteFromConfig(path: string): ReadConfig {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf8')
  const out: ReadConfig = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed) continue
    const m = trimmed.match(/^(remote_url|remote_token)\s*:\s*(.+)$/)
    if (m) {
      if (m[1] === 'remote_url') out.url = m[2].trim()
      if (m[1] === 'remote_token') out.token = m[2].trim()
    }
  }
  return out
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
  const parsed = parseArgs(args)
  if ('error' in parsed) {
    outputText(`Error: ${parsed.error}\n\n${HELP}`, flags)
    process.exit(1)
  }
  const opts = parsed

  if (opts.help) {
    outputText(HELP, flags)
    return
  }

  const configPath = join(process.cwd(), '.plur.yaml')

  // --verify mode — connectivity check against existing config.
  // Walk upward to find the nearest .plur.yaml, matching the hook's
  // discovery so `--verify` from a project subdirectory finds the same
  // config the hook would actually use (data #EC06).
  if (opts.verify) {
    const verifyPath = findExistingConfigPath() ?? configPath
    const cfg = readRemoteFromConfig(verifyPath)
    if (!cfg.url || !cfg.token) {
      outputText(`No remote config found (walked upward from ${process.cwd()}). Run \`plur init-remote --url <url> --token <key>\` first.`, flags)
      process.exit(1)
    }
    outputText(`Using config at ${verifyPath}`, flags)
    try {
      const me = await verifyConnectivity(cfg.url, cfg.token)
      outputText(`✓ Connected to ${cfg.url} as ${me.username} (org: ${me.org_id})`, flags)
      outputText(`  readable scopes: ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}`, flags)
    } catch (err) {
      outputText(`✗ Connection failed: ${(err as Error).message}`, flags)
      process.exit(2)
    }
    return
  }

  // Setup mode — validate inputs
  if (!opts.url || !opts.token) {
    outputText(`Missing required flags.\n${HELP}`, flags)
    process.exit(1)
  }

  // Reject control characters in the token — they corrupt the YAML write
  // and silently break the parser (data #EC09).
  if (/[\n\r\t]/.test(opts.token)) {
    outputText(`Error: token contains newline/tab characters. Refusing to write a corrupt config.`, flags)
    process.exit(1)
  }

  // Validate URL — fail fast on schemes other than http/https.
  try {
    const u = new URL(opts.url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      outputText(`Error: remote_url must be http:// or https:// (got ${u.protocol})`, flags)
      process.exit(1)
    }
  } catch {
    outputText(`Error: remote_url is not a valid URL: ${opts.url}`, flags)
    process.exit(1)
  }

  // Test connectivity before writing the config — fail-fast saves the user
  // from a confusing "hook is silent" mystery if the token is wrong.
  outputText(`Testing connectivity to ${opts.url}...`, flags)
  try {
    const me = await verifyConnectivity(opts.url, opts.token)
    outputText(`✓ Authenticated as ${me.username} (org: ${me.org_id})`, flags)
    outputText(`  readable scopes: ${me.scopes.length === 0 ? '(none)' : me.scopes.join(', ')}`, flags)
  } catch (err) {
    outputText(`✗ Connection failed: ${(err as Error).message}`, flags)
    outputText(`  Refusing to write a broken config. Fix the URL/token and re-run.`, flags)
    process.exit(2)
  }

  // Write/update .plur.yaml
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const next = buildConfigBody(existing, opts.url, opts.token, opts.scopes)
  writeFileSync(configPath, next)
  outputText(`✓ Wrote ${configPath}`, flags)
  if (opts.scopes && opts.scopes.length > 0) {
    outputText(`  scope whitelist: ${opts.scopes.join(', ')}`, flags)
  } else {
    outputText(`  scope whitelist: (none — hook will query all readable scopes)`, flags)
  }

  // Ensure .gitignore
  if (!opts.noGitignore) {
    const gi = ensureGitignore()
    if (gi.action === 'added') outputText(`✓ Added .plur.yaml to ${gi.path}`, flags)
    else if (gi.action === 'created') outputText(`✓ Created ${gi.path} with .plur.yaml entry`, flags)
    else outputText(`✓ ${gi.path} already excludes .plur.yaml`, flags)
  } else {
    outputText(`⚠ Skipped .gitignore (--no-gitignore). The token in .plur.yaml is sensitive.`, flags)
  }

  outputText(`\nDone. The UserPromptSubmit hook will now query ${opts.url} on every prompt`, flags)
  outputText(`from this directory tree (bounded by the nearest .git). Personal/non-project`, flags)
  outputText(`sessions (without a .plur.yaml in the path) stay local-only.`, flags)
  outputText(``, flags)
  outputText(`⚠ Token sensitivity:`, flags)
  outputText(`  .plur.yaml now contains an API token in plaintext.`, flags)
  outputText(`  - .gitignore protects against git commits but NOT against cloud sync`, flags)
  outputText(`    (iCloud Drive, Dropbox, Google Drive). If this project lives in a`, flags)
  outputText(`    synced folder, the token will leave your machine.`, flags)
  outputText(`  - Also not protected: \`cp -r\`, \`zip\`, \`rsync\`, archived backups.`, flags)
  outputText(`  - Consider moving the token to an env var if your project ships with`, flags)
  outputText(`    others (future: env-var substitution in .plur.yaml).`, flags)
}
