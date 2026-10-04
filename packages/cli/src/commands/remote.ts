import { join } from 'path'
import { homedir } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import {
  AddRemoteStoreError, FolderMapError, canonicalize, coversHomeOrRoot, findProjectConfigPath, readProjectConfigFromPath,
  normalizeEndpointUrl, redactToken, redactTokenDeep, type FolderPolicy,
} from '@plur-ai/core'

/**
 * `plur remote` (#1413, folder-map design r3): the one way to connect a folder
 * to a team store.
 *
 *   plur remote --url <u> --token <t> [--scope <s> | --scopes <a,b,...>]
 *   plur remote                 # show this folder's connection and check it
 *
 * With flags it checks the token against the server's /me for every scope
 * first (Plur.verifyRemoteStore) and writes nothing if any is refused; then it
 * registers each scope as a url store in the user's config.yaml
 * (Plur.addRemoteStore, idempotent) and maps the current folder in
 * folders.yaml with the scope (`--scope`, or the first of `--scopes`), under
 * the folder-map lock. Nothing is written to the repo's `.plur.yaml`, so the
 * token never lands in a repo folder, and no trust grant is needed: the URL
 * and token are the user's own, in the user's own config.
 *
 * Without flags it prints the resolved folder policy and checks the stores
 * serving this folder: exit 0 when all are reachable, 2 when one is not, 1
 * when none serves it.
 *
 * `plur init-remote` is a hidden alias (same flags; `--verify` is bare
 * `plur remote`). It used to write the URL and token into `.plur.yaml`.
 *
 * The token is never printed: not in text, not in --json, not in an error.
 */

const HELP = `plur remote — connect this folder to a team store

USAGE
  plur remote --url <url> --token <token> --scope <scope>
  plur remote --url <url> --token <token> --scopes <a,b,...>
  plur remote                  Show this folder's connection and check it

OPTIONS
  --url URL          Server base URL, e.g. https://plur.example.test
  --token TOKEN      API token. --token-env <VAR> reads it from a variable,
                     --token - from stdin, so it need not sit in shell history
  --scope SCOPE      Team scope to use in this folder, e.g. group:example/eng
  --scopes A,B       Several scopes; this folder writes to the first

WHAT THIS DOES
  Checks the token against the server first and writes nothing if it is
  rejected or a scope is not authorised. Then it registers each scope as a
  store in your config.yaml (the token is kept there) and records this folder
  in your folders.yaml with the scope. Nothing is written to this folder.
`

interface Parsed {
  url?: string
  token?: string
  tokenEnv?: string
  scope?: string
  scopes?: string[]
  verify?: boolean
  help?: boolean
}

function parseArgs(args: string[]): Parsed | { error: string } {
  const out: Parsed = {}
  const VALUE_FLAGS = new Set(['--url', '--token', '--token-env', '--scope', '--scopes'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') { out.help = true; continue }
    if (a === '--verify') { out.verify = true; continue }
    // Accepted for init-remote compatibility; nothing is written to the
    // folder any more, so there is no .gitignore to skip.
    if (a === '--no-gitignore') continue
    if (VALUE_FLAGS.has(a)) {
      const next = args[i + 1]
      const ok = next !== undefined && (!next.startsWith('--') || (a === '--token' && next === '-'))
      if (!ok || next === undefined) {
        return { error: `${a} requires a value (got ${next === undefined ? 'nothing' : `another flag: ${next}`})` }
      }
      i++
      if (a === '--url') out.url = next
      if (a === '--token') out.token = next
      if (a === '--token-env') out.tokenEnv = next
      if (a === '--scope') out.scope = next
      if (a === '--scopes') out.scopes = next.split(',').map(s => s.trim()).filter(Boolean)
      continue
    }
    return { error: `Unknown argument ${a}` }
  }
  return out
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Scrub every form of every known token from `text`. */
function scrubAll(text: string, tokens: Array<string | undefined>): string {
  let out = String(text)
  for (const t of tokens) if (t) out = redactToken(out, t)
  return out
}

/** Deep copy of `value` with every form of every known token scrubbed. */
function scrubDeep<T>(value: T, tokens: Array<string | undefined>): T {
  let out = value
  for (const t of tokens) if (t) out = redactTokenDeep(out, t)
  return out
}

interface LegacyRemote {
  path: string
  remote_url?: string
  remote_token?: string
}

/** The nearest `.plur.yaml` above `dir`, when it still carries remote fields. */
function legacyRemote(dir: string): LegacyRemote | null {
  const path = findProjectConfigPath(dir)
  if (!path) return null
  const cfg = readProjectConfigFromPath(path)
  if (!cfg.remote_url && !cfg.remote_token) return null
  return {
    path,
    ...(cfg.remote_url ? { remote_url: cfg.remote_url } : {}),
    ...(cfg.remote_token ? { remote_token: cfg.remote_token } : {}),
  }
}

function legacyMovedMessage(path: string): string {
  return `${path} still carries remote_url/remote_token. The connection now lives in your user config ` +
    `(config.yaml), so you can remove remote_token (and remote_url, remote_scopes) from ${path}. It was not changed.`
}

// Text from outside this machine — a repo's `.plur.yaml`, a server's `/me` —
// reaches the agent reading this output, so only values that fit a narrow
// grammar are printed; anything else is shown as "invalid" (#1415 review).
const SCOPE_OR_DOMAIN = /^[A-Za-z0-9._@/:-]{1,256}$/
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/
const USERNAME = /^[\p{L}\p{N}._@+-]{1,128}$/u
const INVALID = 'invalid'

/** A scope or domain, when it fits the grammar; otherwise "invalid". */
function safeScopeOrDomain(value: unknown): string {
  return typeof value === 'string' && SCOPE_OR_DOMAIN.test(value) ? value : INVALID
}

/** Only the host (and port) of a URL, when it fits the grammar; otherwise "invalid". */
function safeHost(url: unknown): string {
  if (typeof url !== 'string') return INVALID
  try {
    const host = new URL(url).host
    return host.length <= 261 && HOST.test(host) ? host : INVALID
  } catch {
    return INVALID
  }
}

/** A server-supplied username, when it fits the grammar; otherwise "invalid". */
function safeUsername(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return typeof value === 'string' && USERNAME.test(value) ? value : INVALID
}

/**
 * What an untrusted `.plur.yaml` requests, reduced to grammar-checked values:
 * scope and domain as written when valid, and only the host of remote_url.
 */
function safeRequested(r: FolderPolicy['requested']): { scope?: string; domain?: string; remote_host?: string } | undefined {
  if (!r) return undefined
  return {
    ...(r.scope !== undefined ? { scope: safeScopeOrDomain(r.scope) } : {}),
    ...(r.domain !== undefined ? { domain: safeScopeOrDomain(r.domain) } : {}),
    ...(r.remote_url !== undefined ? { remote_host: safeHost(r.remote_url) } : {}),
  }
}

/** The folder policy as printed: `requested` reduced by safeRequested. */
function shownPolicy(policy: FolderPolicy): Omit<FolderPolicy, 'requested'> & { requested?: ReturnType<typeof safeRequested> } {
  const { requested, ...rest } = policy
  const safe = safeRequested(requested)
  return safe ? { ...rest, requested: safe } : rest
}

function coversHomeMessage(folder: string): string {
  return `Error: ${folder} is your home folder, a filesystem root or a folder above your home, and connecting it ` +
    'would connect every folder under it. Run `plur remote` in a subfolder (a project folder) instead.'
}

function fail(json: boolean, message: string, extra: Record<string, unknown> = {}): never {
  if (json) outputJson({ success: false, error: message, ...extra })
  return exit(1, message)
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const parsed = parseArgs(args)
  if ('error' in parsed) return exit(1, `Error: ${parsed.error}\n\n${HELP}`)
  if (parsed.help) { outputText(HELP); return }

  const connecting = parsed.url !== undefined || parsed.token !== undefined || parsed.tokenEnv !== undefined ||
    parsed.scope !== undefined || parsed.scopes !== undefined
  if (parsed.verify && connecting) return exit(1, 'Error: --verify takes no other flags (it is bare `plur remote`).')
  if (!connecting) return show(flags)
  return connect(parsed, flags)
}

async function connect(parsed: Parsed, flags: GlobalFlags): Promise<void> {
  const json = shouldOutputJson(flags)
  const { url } = parsed
  if (parsed.token !== undefined && parsed.tokenEnv !== undefined) {
    return exit(1, 'Error: pass one of --token or --token-env, not both.')
  }
  let token = parsed.token
  if (parsed.tokenEnv !== undefined) {
    token = (process.env[parsed.tokenEnv] ?? '').trim()
    if (!token) return exit(1, `--token-env ${parsed.tokenEnv}: that environment variable is unset or empty. Nothing was written.`)
  } else if (token === '-') {
    token = (await readStdin()).trim()
    if (!token) return exit(1, '--token -: no token on stdin. Nothing was written.')
  }
  if (!url || !token) return exit(1, `Missing required flags: --url and --token.\n\n${HELP}`)
  const tok: string = token

  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return exit(1, `Error: the url must be http:// or https:// (got ${u.protocol})`)
    }
  } catch {
    return exit(1, redactToken(`Error: the url is not a valid URL: ${url}`, tok))
  }
  if (parsed.scope !== undefined && parsed.scopes !== undefined) {
    return exit(1, 'Error: pass one of --scope or --scopes, not both.')
  }
  const scopes = parsed.scopes ?? (parsed.scope ? [parsed.scope] : [])
  if (scopes.length === 0) {
    return exit(1, 'Error: pass --scope <scope> (or --scopes <a,b>) — the team scope this folder should use. Nothing was written.')
  }

  // A folder entry covers everything below it, so connecting $HOME, a
  // filesystem root or an ancestor of $HOME would connect every folder under
  // it (the design keeps $HOME at ask). Refused before any server is dialled.
  // This is the fast check; the write itself refuses again under the
  // folder-map lock (refuseCoveringHome), on the path it actually records.
  const folder = canonicalize(process.cwd())
  if (coversHomeOrRoot(folder, homedir())) return exit(1, `${coversHomeMessage(folder)} Nothing was written.`)

  const plur = createPlur(flags)
  const refuse = (err: unknown, prefix: string): never => {
    const raw = err instanceof Error ? err.message : String(err)
    const msg = redactToken(raw, tok).replace(
      'pass overwriteScope to replace that entry',
      'run `plur stores add --url ... --overwrite-scope` to replace that entry',
    )
    const code = err instanceof AddRemoteStoreError || err instanceof FolderMapError ? err.code : 'error'
    return fail(json, redactToken(`${prefix}${msg}`, tok), redactTokenDeep({ code, url }, tok))
  }

  // Every scope is checked before anything is written, so one refused scope
  // in --scopes leaves config.yaml and folders.yaml exactly as they were.
  let username: string | undefined
  for (const scope of scopes) {
    try {
      const v = await plur.verifyRemoteStore({ url, token: tok, scope })
      username = username ?? safeUsername(v.username)
    } catch (err) {
      return refuse(err, 'Not connected: ')
    }
  }

  const stores: Array<{ scope: string; status: string }> = []
  for (const scope of scopes) {
    try {
      const r = await plur.addRemoteStore({ url, token: tok, scope })
      stores.push({ scope, status: r.status })
    } catch (err) {
      const done = stores.length ? ` Registered before this: ${stores.map(s => s.scope).join(', ')}.` : ''
      return refuse(err, `Not connected (scope ${scope}):${done} `)
    }
  }

  let mapped: string
  try {
    // Literal: a folder really named `proj?` must not be stored as a glob that
    // also covers its siblings. refuseCoveringHome: the $HOME/root refusal is
    // made again on the key written, under the lock, so a folder swapped for
    // a symlink to $HOME while /me was answering is still refused.
    mapped = plur.setFolder(folder, { scope: scopes[0] }, { literal: true, refuseCoveringHome: true }).path
  } catch (err) {
    if (err instanceof FolderMapError && err.code === 'covers-home') {
      const stores = scopes.join(', ')
      return exit(1, `${coversHomeMessage(canonicalize(folder))} The store (${stores}) is registered in config.yaml, ` +
        'but no folder was mapped in folders.yaml.')
    }
    return refuse(err, `The store is registered in config.yaml, but ${folder} could not be mapped in folders.yaml: `)
  }

  const legacy = legacyRemote(canonicalize(folder))
  const root = plur.storageRoot
  if (json) {
    outputJson(scrubDeep({
      success: true, url, folder: mapped, scope: scopes[0], stores,
      ...(username ? { username } : {}),
      ...(legacy ? { legacy_plur_yaml: { path: legacy.path, message: legacyMovedMessage(legacy.path) } } : {}),
    }, [tok, legacy?.remote_token]))
    return
  }
  const lines: string[] = []
  const label: Record<string, string> = {
    added: 'added', already_registered: 'already registered', token_rotated: 'token updated', overwritten: 'reassigned',
  }
  lines.push(`Connected to ${url}${username ? ` as ${username}` : ''}.`)
  for (const s of stores) lines.push(`  store ${s.scope}: ${label[s.status] ?? s.status}`)
  lines.push(`Mapped ${mapped} to scope ${scopes[0]} in ${join(root, 'folders.yaml')}.`)
  lines.push(`The token is kept in ${join(root, 'config.yaml')}; nothing was written to this folder.`)
  for (const l of lines) outputInfo(scrubAll(l, [tok, legacy?.remote_token]), flags)
  // Not suppressed by --quiet: it says a file of yours still holds a token.
  if (legacy) outputText(scrubAll(legacyMovedMessage(legacy.path), [tok, legacy.remote_token]))
}

interface ServedStore {
  url: string
  scope?: string
  source: 'config' | 'plur-yaml'
  ok: boolean
  status: 'ok' | 'auth_expired' | 'unreachable'
  username?: string
  reason?: string
}

/** GET <origin>/api/v1/me for a `.plur.yaml` remote (its token is not in config.yaml). */
async function probeLegacy(url: string, token: string): Promise<Pick<ServedStore, 'ok' | 'status' | 'username' | 'reason'>> {
  let base: string
  try { base = new URL(url).origin } catch { return { ok: false, status: 'unreachable', reason: 'invalid URL' } }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch(`${base}/api/v1/me`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    })
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'auth_expired', reason: `HTTP ${r.status}` }
    if (!r.ok) return { ok: false, status: 'unreachable', reason: `HTTP ${r.status}` }
    const data = await r.json().catch(() => ({})) as { username?: unknown }
    const username = safeUsername(data.username)
    return { ok: true, status: 'ok', ...(username ? { username } : {}) }
  } catch (err) {
    return { ok: false, status: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

const SOURCE_LABEL: Record<FolderPolicy['source'], string> = {
  map: 'your folder map (folders.yaml)',
  'plur-yaml': "this repo's .plur.yaml",
  'mcp-config': 'a project MCP config',
  default: 'no decision recorded',
}

async function show(flags: GlobalFlags): Promise<void> {
  const json = shouldOutputJson(flags)
  const plur = createPlur(flags)
  const folder = canonicalize(process.cwd())
  const policy = plur.resolveFolderPolicy(folder)
  const legacy = legacyRemote(folder)

  const served: ServedStore[] = []
  const tokens: Array<string | undefined> = [legacy?.remote_token]
  if (policy.mode !== 'off') {
    if (policy.scope) {
      const health = await plur.checkRemoteHealth()
      for (const g of plur.remoteEndpointTokenGroups()) tokens.push(g.token)
      for (const h of health) {
        if (!h.scopes.includes(policy.scope)) continue
        served.push({
          url: h.url, scope: policy.scope, source: 'config', ok: h.ok, status: h.status,
          ...(safeUsername(h.username) ? { username: safeUsername(h.username) } : {}),
          ...(h.reason ? { reason: h.reason } : {}),
        })
      }
    }
    if (policy.remoteAllowed && legacy?.remote_url && legacy.remote_token) {
      served.push({ url: legacy.remote_url, source: 'plur-yaml', ...(await probeLegacy(legacy.remote_url, legacy.remote_token)) })
    }
  }

  // A legacy .plur.yaml remote that the user config now also serves can lose
  // its token; one that it does not is pointed at `plur remote`.
  let legacyNote: string | undefined
  if (legacy) {
    const moved = legacy.remote_url !== undefined && plur.remoteEndpointTokenGroups()
      .some(g => normalizeEndpointUrl(g.url) === normalizeEndpointUrl(legacy.remote_url!))
    legacyNote = moved
      ? legacyMovedMessage(legacy.path)
      : `${legacy.path} carries remote_url/remote_token. To keep the token out of the repo, run ` +
        `\`plur remote --url <url> --token <token> --scope <scope>\` here; remote_token can then be removed from it.`
  }

  const code: 0 | 1 | 2 = served.length === 0 ? 1 : served.every(s => s.ok) ? 0 : 2
  if (json) {
    outputJson(scrubDeep({
      success: code === 0, folder, policy: shownPolicy(policy), stores: served,
      ...(legacy ? { legacy_plur_yaml: { path: legacy.path, message: legacyNote } } : {}),
    }, tokens))
    if (code !== 0) process.exit(code)
    return
  }

  const lines: string[] = []
  lines.push(`Folder: ${folder}`)
  lines.push(`  PLUR:  ${policy.mode} (from ${SOURCE_LABEL[policy.source]})`)
  lines.push(`  scope: ${policy.scope ?? '(none)'}`)
  if (policy.reason === 'untrusted-plur-yaml') {
    lines.push("  This repo's .plur.yaml asks for settings that need your trust; they are ignored until you allow them.")
  }
  if (served.length === 0) {
    lines.push(policy.mode === 'off'
      ? 'PLUR is off here, so no store serves this folder.'
      : 'No team store serves this folder. Connect one with: plur remote --url <url> --token <token> --scope <scope>')
  } else {
    lines.push('Stores serving this folder:')
    for (const s of served) {
      const where = `${s.url}${s.scope ? ` [${s.scope}]` : ''}${s.source === 'plur-yaml' ? ' (from .plur.yaml)' : ''}`
      if (s.ok) lines.push(`  ✓ ${where} — reachable${s.username ? ` as ${s.username}` : ''}`)
      else if (s.status === 'auth_expired') lines.push(`  ✗ ${where} — token rejected${s.reason ? `: ${s.reason}` : ''}`)
      else lines.push(`  ✗ ${where} — unreachable${s.reason ? `: ${s.reason}` : ''}`)
    }
  }
  if (legacyNote) lines.push(legacyNote)
  for (const l of lines) outputText(scrubAll(l, tokens))
  if (code !== 0) process.exit(code)
}
