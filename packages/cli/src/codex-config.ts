/** Codex MCP edits use TOML syntax ranges: never remove/re-add a user's table. */
import { existsSync, readFileSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser'
import yaml from 'js-yaml'
import { writeWithBackup } from '@plur-ai/core'
import { codexConfigTomlPath, findMcpJsEntry, isOwnWin32CmdShimCommand, type McpServerEntry } from './mcp-config.js'

export interface CodexEntry extends McpServerEntry {
  env_vars?: Array<string | { name: string; source?: string }>
  cwd?: string
  enabled?: boolean
  url?: string
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const key = (k: AST.TOMLKey): string[] => k.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)
const pathKey = (p: (string | number)[]) => JSON.stringify(p)

function document(text: string) {
  let ast: AST.TOMLProgram
  try { ast = parseTOML(text, { tomlVersion: '1.0' }) } catch {
    // Parser diagnostics may contain the offending line, including a token.
    throw new Error('Codex config.toml is not valid TOML; nothing was changed')
  }
  const data = getStaticTOMLValue(ast) as Record<string, unknown>
  const nodes = new Map<string, AST.TOMLKeyValue>()
  const visit = (base: (string | number)[], kv: AST.TOMLKeyValue) => {
    const path = [...base, ...key(kv.key)]
    nodes.set(pathKey(path), kv)
    if (kv.value.type === 'TOMLInlineTable') for (const child of kv.value.body) visit(path, child)
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') visit([], node)
    else for (const kv of node.body) visit(node.resolvedKey, kv)
  }
  const servers = data.mcp_servers
  const raw = record(servers) ? servers.plur : undefined
  return { ast, nodes, raw }
}

export function readCodexEntry(text: string): CodexEntry | null {
  const { raw } = document(text)
  if (raw === undefined) return null
  if (!record(raw)) throw new Error('Codex plur MCP entry must be a table')
  if (raw.url !== undefined) return { ...raw } as unknown as CodexEntry
  if (typeof raw.command !== 'string' || (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(x => typeof x !== 'string')))) {
    throw new Error('Codex plur MCP command/args have an unsupported shape; nothing was changed')
  }
  if (raw.env !== undefined && (!record(raw.env) || Object.values(raw.env).some(v => typeof v !== 'string'))) throw new Error('Codex plur MCP env must contain strings')
  if (raw.env_vars !== undefined && (!Array.isArray(raw.env_vars) || raw.env_vars.some(v => typeof v !== 'string' && !(record(v) && typeof v.name === 'string' && (v.source === undefined || v.source === 'local' || v.source === 'remote'))))) throw new Error('Codex plur MCP env_vars has an unsupported shape')
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error('Codex plur MCP cwd must be a string')
  return { ...raw, args: raw.args ?? [] } as unknown as CodexEntry
}

function version(v: string): { parts: number[]; pre?: string } | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  return m ? { parts: m.slice(1, 4).map(Number), pre: m[4] } : null
}
export function olderOrEqual(a: string, b: string): boolean {
  const av = version(a), bv = version(b)
  if (!av || !bv) return false
  for (let i = 0; i < 3; i++) if (av.parts[i] !== bv.parts[i]) return av.parts[i] < bv.parts[i]
  if (av.pre === bv.pre) return true
  if (!av.pre) return false
  if (!bv.pre) return true
  const ap = av.pre.split('.'), bp = bv.pre.split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return true
    if (bp[i] === undefined) return false
    if (ap[i] === bp[i]) continue
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i])
    return an && bn ? Number(ap[i]) < Number(bp[i]) : an !== bn ? an : ap[i] < bp[i]
  }
  return true
}

/** Only launch forms PLUR has shipped; no arbitrary shell scripts or forks. */
export function codexLaunchKind(entry: CodexEntry, cliVersion: string): 'upgrade' | 'current' | 'newer' | 'custom' {
  if (entry.url || typeof entry.command !== 'string') return 'custom'
  const args = entry.args ?? []
  let spec: string | undefined
  if (/(^|[/\\])npx(?:\.cmd|\.exe)?$/i.test(entry.command)) {
    if (args.length === 1) spec = args[0]
    else if (args.length === 2 && ['-y', '--yes'].includes(args[0])) spec = args[1]
  } else if (/(^|[/\\])cmd(?:\.exe)?$/i.test(entry.command)) {
    if (args.length === 4 && args[0] === '/c' && args[1] === 'npx' && args[2] === '-y') spec = args[3]
  } else if (entry.command === '/bin/sh' && args.length === 2 && args[0] === '-lc') {
    spec = /^\s*(?:exec\s+)?npx\s+(?:-y\s+)?(@plur-ai\/mcp(?:@[^\s]+)?)\s*$/.exec(args[1])?.[1]
  }
  if (spec) {
    if (spec === '@plur-ai/mcp' || spec === '@plur-ai/mcp@latest') return 'upgrade'
    const pin = /^@plur-ai\/mcp@(.+)$/.exec(spec)?.[1]
    if (pin && version(pin)) return olderOrEqual(pin, cliVersion) ? 'upgrade' : 'newer'
    return 'custom'
  }
  const normalized = entry.command.replace(/\\/g, '/')
  const bin = join(homedir(), '.plur', 'bin', 'plur-mcp').replace(/\\/g, '/')
  if (args.length === 0 && (normalized === bin || isOwnWin32CmdShimCommand(entry.command))) return 'current'
  if (/(^|[/\\])node(?:\.exe)?$/i.test(entry.command) && args.length === 1 && /[/\\]@plur-ai[/\\]mcp[/\\]dist[/\\]index\.js$/.test(args[0])) return 'current'
  return 'custom'
}

type TomlValue = string | TomlValue[] | { [key: string]: TomlValue }
function literal(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(literal).join(', ') + ']'
  return '{ ' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ' = ' + literal(v)).join(', ') + ' }'
}

/** Replace only value spans; unrelated settings and comments keep their bytes. */
export function patchCodexEntry(text: string, values: Record<string, TomlValue>): string {
  const { nodes, ast } = document(text)
  const base = ['mcp_servers', 'plur']
  const anchor = nodes.get(pathKey([...base, 'command']))
  if (!anchor) throw new Error('Codex plur MCP has no editable command; nothing was changed')
  const edits: Array<{ start: number; end: number; text: string }> = []
  const missing: string[] = []
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  for (const [name, value] of Object.entries(values)) {
    const node = nodes.get(pathKey([...base, name]))
    if (node) {
      const previous = getStaticTOMLValue(node.value)
      if (JSON.stringify(previous) === JSON.stringify(value)) continue
      if (name === 'env_vars' && node.value.type === 'TOMLArray' && Array.isArray(previous) && Array.isArray(value) && previous.every((v, i) => JSON.stringify(v) === JSON.stringify(value[i]))) {
        // Append after the final element, before any trailing comma/comment.
        const elements = node.value.elements
        const at = elements.length ? elements[elements.length - 1].range[1] : node.value.range[0] + 1
        edits.push({ start: at, end: at, text: (elements.length ? ', ' : '') + value.slice(previous.length).map(literal).join(', ') })
      } else {
        const comments = ast.comments.filter(c => c.range[0] >= node.value.range[0] && c.range[1] <= node.value.range[1])
        const rendered = comments.length && Array.isArray(value)
          ? '[' + newline + comments.map(c => text.slice(...c.range) + newline).join('') + value.map(literal).join(', ') + newline + ']'
          : literal(value)
        edits.push({ start: node.value.range[0], end: node.value.range[1], text: rendered })
      }
    } else missing.push(`${name} = ${literal(value)}`)
  }
  if (missing.length) {
    const parent = anchor.parent
    if (parent.type === 'TOMLInlineTable') {
      edits.push({ start: parent.range[1] - 1, end: parent.range[1] - 1, text: ', ' + missing.join(', ') })
    } else {
      const prefix = parent.type === 'TOMLTable' ? parent.resolvedKey : []
      const rest = base.slice(prefix.length).map(k => JSON.stringify(k)).join('.')
      const lines = missing.map(line => (rest ? rest + '.' : '') + line).join(newline)
      const end = text.indexOf('\n', anchor.value.range[1])
      const at = end < 0 ? text.length : end + 1
      edits.push({ start: at, end: at, text: (end < 0 ? newline : '') + lines + newline })
    }
  }
  let output = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  document(output) // Validate the resulting whole document before writing it.
  return output
}

export function configuredTokenVariables(root: string): string[] {
  const path = join(root, 'config.yaml')
  if (!existsSync(path)) return []
  let raw: unknown
  try { raw = yaml.load(readFileSync(path, 'utf8')) } catch { throw new Error('PLUR config.yaml is not valid YAML; token forwarding could not be checked') }
  if (raw == null) return []
  if (!record(raw) || (raw.stores !== undefined && !Array.isArray(raw.stores))) throw new Error('PLUR stores configuration has an unsupported shape')
  const names = new Set<string>()
  for (const store of (raw.stores ?? []) as unknown[]) {
    if (!record(store)) throw new Error('PLUR store configuration has an unsupported shape')
    if (!store.url || !store.token_env || store.token) continue
    if (typeof store.token_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(store.token_env)) throw new Error('PLUR token_env must be an environment variable name')
    names.add(store.token_env)
  }
  return [...names].sort()
}
export function forwardedTokenVariables(entry: CodexEntry): Set<string> {
  return new Set((entry.env_vars ?? []).flatMap(v => typeof v === 'string' ? [v] : v.source !== 'remote' ? [v.name] : []))
}

export function updateCodexRegistration(options: { root: string; version: string; replacement?: McpServerEntry; keepLaunch?: boolean; path?: string }): { status: 'absent' | 'unchanged' | 'updated' | 'custom'; message: string } {
  const path = options.path ?? codexConfigTomlPath()
  if (!existsSync(path)) return { status: 'absent', message: 'Codex config not present' }
  const original = readFileSync(path, 'utf8')
  const entry = readCodexEntry(original)
  if (!entry) return { status: 'absent', message: 'Codex plur MCP not registered' }
  const kind = codexLaunchKind(entry, options.version)
  if (kind === 'custom') return { status: 'custom', message: 'custom/remote Codex MCP entry preserved; run `plur doctor --codex` to verify it' }
  const changes: Record<string, TomlValue> = {}
  // Newer pins and an explicit opt-out are preserved. In-place installed
  // node/shim entries already follow npm updates at the same path.
  const brokenInstalled = kind === 'current' && (isOwnWin32CmdShimCommand(entry.command)
    || (isAbsolute(entry.command) && !existsSync(entry.command))
    || entry.args.some(arg => isAbsolute(arg) && !existsSync(arg)))
  if ((kind === 'upgrade' || brokenInstalled) && options.replacement && !options.keepLaunch) {
    changes.command = options.replacement.command
    changes.args = options.replacement.args
    // Preserve intentional PATH-based Node selection while refreshing the JS entry.
    if (/^node(?:\.exe)?$/i.test(entry.command) && kind === 'current') {
      changes.command = entry.command
      changes.args = [findMcpJsEntry() ?? entry.args[0]]
    }
  }
  const declared = new Set((entry.env_vars ?? []).map(v => typeof v === 'string' ? v : v.name))
  const needed = configuredTokenVariables(codexStorageRoot(entry, options.root)).filter(name => !declared.has(name) && !Object.hasOwn(entry.env ?? {}, name))
  // Object-form entries must keep their source; append names via the AST
  // without replacing or flattening existing forwarding definitions.
  let updated = patchCodexEntry(original, changes)
  if (needed.length) {
    const values = [...(entry.env_vars ?? []), ...needed]
    updated = patchCodexEntry(updated, { env_vars: values as TomlValue[] })
  }
  if (updated === original) return { status: 'unchanged', message: kind === 'newer' ? 'newer Codex MCP pin preserved' : 'already registered (configuration preserved)' }
  writeWithBackup(path, updated, original)
  return { status: 'updated', message: 'updated Codex MCP registration in place (other settings preserved)' }
}

/** Resolve a server's own storage override before considering CLI storage flags. */
export function codexStorageRoot(entry: CodexEntry, fallback: string): string {
  return entry.env?.PLUR_PATH ? resolve(entry.cwd ?? process.cwd(), entry.env.PLUR_PATH) : fallback
}

/** Codex local stdio inheritance, upstream rmcp-client/src/utils.rs (0.160.1).
 * This models the invoking environment, never a separately running desktop app.
 */
export function codexMcpEnvironment(entry: CodexEntry, parent: NodeJS.ProcessEnv = process.env, windows = process.platform === 'win32'): NodeJS.ProcessEnv {
  if (entry.env_vars?.some(v => typeof v !== 'string' && v.source === 'remote')) throw new Error('Remote-source env_vars requires remote stdio; local runtime cannot be verified')
  const defaults = windows
    ? 'PATH PATHEXT SHELL COMSPEC SYSTEMROOT WINDIR SYSTEMDRIVE USERNAME USERDOMAIN USERPROFILE HOMEDRIVE HOMEPATH PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 PROGRAMDATA LOCALAPPDATA APPDATA TEMP TMP TMPDIR POWERSHELL PWSH'.split(' ')
    : 'HOME LOGNAME PATH SHELL USER __CF_USER_TEXT_ENCODING LANG LC_ALL TERM TMPDIR TZ'.split(' ')
  const caNames = ['CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'CARGO_HTTP_CAINFO', 'PIP_CERT', 'BUNDLE_SSL_CA_CERT', 'npm_config_cafile', 'NPM_CONFIG_CAFILE']
  const names = new Set([...defaults, ...forwardedTokenVariables(entry)].map(k => windows ? k.toUpperCase() : k))
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(parent)) if (names.has(windows ? k.toUpperCase() : k)) env[k] = v
  // Codex resolves inherited CA files before changing the server's cwd.
  for (const name of caNames) {
    const source = Object.keys(parent).find(k => windows ? k.toLowerCase() === name.toLowerCase() : k === name)
    if (!source || !parent[source]) continue
    if (windows) for (const old of Object.keys(env)) if (old.toLowerCase() === name.toLowerCase()) delete env[old]
    env[name] = resolve(parent[source]!)
  }
  for (const [k, v] of Object.entries(entry.env ?? {})) {
    if (windows || caNames.some(name => name.toLowerCase() === k.toLowerCase())) for (const old of Object.keys(env)) if (old.toLowerCase() === k.toLowerCase()) delete env[old]
    env[k] = v
  }
  const blocked = new Set(['CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN', 'NODE_REPL_AUTH_TOKEN', 'CODEX_GUARDIAN_DECISIONS_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT'])
  for (const k of Object.keys(env)) if (blocked.has(k.toUpperCase())) delete env[k]
  return env
}
