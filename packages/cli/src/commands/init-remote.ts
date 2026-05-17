import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'fs'
import { join } from 'path'
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

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--verify')           { out.verify = true; continue }
    if (a === '--no-gitignore')     { out.noGitignore = true; continue }
    if (a === '--url')     { out.url = args[++i]; continue }
    if (a === '--token')   { out.token = args[++i]; continue }
    if (a === '--scopes')  { out.scopes = args[++i].split(',').map(s => s.trim()).filter(Boolean); continue }
  }
  return out
}

/**
 * Strip the existing remote_* keys from .plur.yaml content so we can
 * append a fresh block — keeps non-remote keys (domain, scope) intact.
 * Preserves comments and ordering of unrelated keys.
 */
function stripRemoteKeys(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skippingList = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (skippingList) {
      // Inside a YAML list — skip dashes until a new key or blank
      if (trimmed.startsWith('-') || trimmed === '') continue
      skippingList = false
    }
    if (/^remote_(url|token|scopes)\s*:/.test(trimmed)) {
      // Skip this key. If it's remote_scopes with a multi-line list, swallow
      // the subsequent dashed lines too.
      if (/^remote_scopes\s*:\s*$/.test(trimmed)) skippingList = true
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
 * Walks upward looking for an existing .gitignore (so we update the right
 * one if the user is in a subdirectory). Creates one in cwd as a fallback.
 */
function ensureGitignore(): { path: string; action: 'added' | 'already' | 'created' } {
  // Find the nearest .gitignore (project root usually)
  let dir = process.cwd()
  const root = '/'
  let gitignorePath: string | null = null
  while (true) {
    const candidate = join(dir, '.gitignore')
    if (existsSync(candidate)) { gitignorePath = candidate; break }
    if (dir === root) break
    const parent = join(dir, '..')
    try {
      if (statSync(parent).ino === statSync(dir).ino) break  // hit FS boundary
    } catch { break }
    dir = parent
  }

  const PATTERN = '.plur.yaml'

  if (!gitignorePath) {
    // No .gitignore found — create one in cwd
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
 */
async function verifyConnectivity(url: string, token: string): Promise<{ username: string; org_id: string; scopes: string[] }> {
  const base = url.replace(/\/sse\/?$/, '').replace(/\/$/, '')
  const probeUrl = `${base}/api/v1/me`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch(probeUrl, {
      signal: ctrl.signal,
      headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json' },
    })
    clearTimeout(timer)
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
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const opts = parseArgs(args)

  if (opts.help) {
    outputText(HELP, flags)
    return
  }

  const configPath = join(process.cwd(), '.plur.yaml')

  // --verify mode — connectivity check against existing config
  if (opts.verify) {
    const cfg = readRemoteFromConfig(configPath)
    if (!cfg.url || !cfg.token) {
      outputText(`No remote config in ${configPath}. Run \`plur init-remote --url <url> --token <key>\` first.`, flags)
      process.exit(1)
    }
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
  outputText(`from this directory and its descendants. Personal/non-project sessions`, flags)
  outputText(`(without a .plur.yaml in the path) stay local-only.`, flags)
}
