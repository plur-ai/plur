/**
 * Wiring each AI tool for an enterprise install (#1638): the company CA and
 * the proxy go into each tool's own PLUR MCP entry, and the exact launch each
 * tool would use is read back for the version check and the hello proof.
 *
 * - `runPlurInit` runs `plur init --no-prompt`, which writes the `plur`
 *   entries. The caller runs it first and decides what an init failure means.
 * - `applyMcpEnv` sets the launch keys (`PLUR_ENV_KEYS`) on the `plur` entry
 *   only, keeps every other key, server, comment and byte it does not need to
 *   change, and removes a PLUR key it wrote earlier that is now absent. A file
 *   that does not parse is refused and left untouched; so is an edit whose
 *   re-parsed result differs anywhere but that entry's env.
 * - `toolLaunch` is the command and env the tool itself would start.
 * - `launchProblem` names a launch the proof must not run. Only PLUR itself
 *   (`plur-mcp`, or Node running a script directly) passes; npx, cmd.exe, a
 *   shell, a package runner or a `.cmd` does not: killing such a wrapper can
 *   leave the real server behind, and on Windows a `.cmd` cannot start
 *   without a shell at all.
 * - `wslSide` / `probeWsl`: Codex on the other side of WSL is reported with
 *   its side, never wired here. Nothing an env variable or a planted file
 *   says can make the probe run a different program: WSL is read from the
 *   kernel release, Windows drive mounts from the kernel's mount table, the
 *   Windows probe runs `<SystemRoot>\System32\wsl.exe` by absolute path for a
 *   SystemRoot of `<drive>:\Windows` only, and inside WSL nothing is run.
 *
 * Modelled in spec/formal/PlurSpec/Trust.lean, section 4.
 */
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs'
import { homedir, release } from 'os'
import { dirname, join } from 'path'
import { isDeepStrictEqual } from 'util'
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree } from 'jsonc-parser'
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser'
import { atomicWrite, windowsSystemRoot } from '@plur-ai/core'
import { readCodexEntry, codexMcpEnvironment, patchCodexEntry } from '../codex-config.js'
import { unambiguousJsonc } from '../opencode-config.js'
import { parseJsonc } from '../lib/jsonc.js'
import { resolveCodexBinary } from '../lib/codex-binary.js'
import { TOOL_ENV_KEYS, buildToolMcpEnv } from './launch-env.js'
import { isNpxLaunch } from './launch-check.js'
import { TOOL_LABEL, type ToolId } from './hello.js'
import { realExec, type ExecFn } from './exec.js'

export { TOOL_LABEL, type ToolId }

/** The only keys PLUR sets on a tool's entry, and so the only keys it ever removes. */
export const PLUR_ENV_KEYS: readonly string[] = TOOL_ENV_KEYS

/** The order tools are wired and reported in. */
export const TOOLS: readonly ToolId[] = ['claude-code', 'codex', 'opencode', 'cursor']

/** A launch: what the tool runs, with the env it runs it with. */
export type ToolLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv }

/** Where tool configs are looked up. Defaults: os.homedir() and process.env. */
export type WireLocation = { home?: string; env?: NodeJS.ProcessEnv }

export type ApplyResult = { status: 'updated' | 'unchanged' | 'absent' | 'refused'; path: string; detail?: string }

/** Which side of WSL a tool runs on, when it is not this side (owner decision O10). */
export type WireSide = 'wsl' | 'windows'

/** What the summary says for a tool on the other side, by side. */
export const OTHER_SIDE_TEXT: Record<WireSide, string> = {
  wsl: 'runs in WSL — run the installer inside WSL',
  windows: 'runs on Windows — run the installer in PowerShell',
}

/**
 * One tool's wiring.
 *
 * - `wired`: the env is in the tool's `plur` entry. `launch` is set only when
 *   it is a direct launch the proof can run; a `wired` result without
 *   `launch` cannot be proven, and `detail` says why.
 * - `other-side`: the tool runs on the other side of WSL; `side` says which,
 *   and `detail` is `OTHER_SIDE_TEXT[side]`. Nothing was changed.
 * - `refused`: the config could not be edited safely; nothing was changed.
 * - `failed`: the env was written but no launch could be read back.
 */
export type WireResult =
  | { tool: ToolId; status: 'wired'; configPath: string; launch?: ToolLaunch; detail?: string }
  | { tool: ToolId; status: 'other-side'; side: WireSide; configPath: string; detail: string }
  | { tool: ToolId; status: 'refused' | 'failed'; configPath: string; detail?: string }

// ─── Paths ────────────────────────────────────────────────────────────────────

/** The user-level config file each tool reads its MCP servers from. */
export function toolConfigPath(tool: ToolId, loc: WireLocation = {}): string {
  const home = loc.home ?? homedir()
  const env = loc.env ?? process.env
  switch (tool) {
    case 'claude-code':
      return join(home, '.claude.json')
    case 'cursor':
      return join(home, '.cursor', 'mcp.json')
    case 'codex':
      return join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
    case 'opencode': {
      // Same resolution as opencodeConfigDir / opencodeConfigPath, from `home`.
      const dir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
      const json = join(dir, 'opencode.json')
      const jsonc = join(dir, 'opencode.jsonc')
      return !exists(json) && exists(jsonc) ? jsonc : json
    }
  }
}

function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

// ─── runPlurInit ──────────────────────────────────────────────────────────────

/**
 * Runs `<node> <cliEntry> init --no-prompt` (no shell, this Node by absolute
 * path) and writes its output, stdout then stderr, to `logPath`. The log is
 * a new owner-only file every run (0600, an owner-only access list on
 * Windows): an older log, or a link in its place, is removed first, never
 * written through. `ok` is the exit status only; a log that cannot be
 * written does not change it.
 */
export function runPlurInit(exec: ExecFn, cliEntry: string, logPath: string): { ok: boolean } {
  const r = exec(process.execPath, [cliEntry, 'init', '--no-prompt'], { timeoutMs: 120_000, stderr: true })
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    rmSync(logPath, { force: true })
    atomicWrite(logPath, r.stdout + (r.stderr ?? ''), { mode: 0o600, secret: true })
  } catch {
    // The log is for the user's diagnosis; the result does not depend on it.
  }
  return { ok: r.status === 0 }
}

// ─── applyMcpEnv ──────────────────────────────────────────────────────────────

type Env = Record<string, string>
type Plan = { status: 'absent' } | { status: 'refused'; detail: string } | { status: 'unchanged' } | { status: 'edit'; content: string }

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

const REMOTE_TYPES = new Set(['http', 'sse', 'remote', 'streamable-http', 'streamable_http', 'streamablehttp'])

/** A remote (url) entry, even when a `command` was left in it: a launch env does not apply, and nothing is started. */
function isRemoteEntry(entry: Record<string, unknown>): boolean {
  return entry.url !== undefined || (typeof entry.type === 'string' && REMOTE_TYPES.has(entry.type.toLowerCase()))
}

/** The entry's env after PLUR's keys are set to `next`: other keys kept, PLUR keys not in `next` removed. */
export function mergeEnv(current: Env, next: Env): Env {
  const out: Env = {}
  for (const [k, v] of Object.entries(current)) if (!PLUR_ENV_KEYS.includes(k)) out[k] = v
  for (const k of PLUR_ENV_KEYS) if (next[k] !== undefined) out[k] = next[k]
  return out
}

function stringRecord(x: unknown): Env | null {
  if (!isRecord(x)) return null
  return Object.values(x).every(v => typeof v === 'string') ? (x as Env) : null
}

/** `data` with the env at `entryPath` replaced by `env`; an empty env and no env are the same. */
function withEnv(data: unknown, entryPath: string[], envKey: string, env: Env): unknown {
  const copy = structuredClone(data) as Record<string, unknown>
  let node: Record<string, unknown> = copy
  for (const k of entryPath) node = node[k] as Record<string, unknown>
  if (Object.keys(env).length === 0) delete node[envKey]
  else node[envKey] = env
  return copy
}

function normalizedEnv(data: unknown, entryPath: string[], envKey: string): unknown {
  let node: unknown = data
  for (const k of entryPath) node = isRecord(node) ? node[k] : undefined
  const env = isRecord(node) ? node[envKey] : undefined
  return withEnv(data, entryPath, envKey, isRecord(env) ? (env as Env) : {})
}

/**
 * Sets `env` on the tool's `plur` entry: Claude Code `~/.claude.json`
 * `mcpServers.plur.env`, Cursor `~/.cursor/mcp.json` `mcpServers.plur.env`,
 * Codex `[mcp_servers.plur.env]`, OpenCode `mcp.plur.environment` (JSONC,
 * comments kept). See the file header for the rules.
 */
export function applyMcpEnv(tool: ToolId, env: Env, loc: WireLocation = {}): ApplyResult {
  const path = toolConfigPath(tool, loc)
  const foreign = Object.keys(env).filter(k => !PLUR_ENV_KEYS.includes(k))
  if (foreign.length > 0) {
    return { status: 'refused', path, detail: `not a PLUR launch setting: ${foreign.join(', ')}` }
  }
  const bad = valueProblem(env)
  if (bad) return { status: 'refused', path, detail: `${bad}; left unchanged` }
  // A link is edited at its target, so the link survives; the target is
  // resolved once, read once, and checked again just before the write.
  const target = linkTarget(path)
  let snapshot: string
  try {
    snapshot = readFileSync(target, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent', path }
    return { status: 'refused', path, detail: 'could not read the file' }
  }
  let plan: Plan
  try {
    plan = tool === 'codex' ? planCodex(snapshot, env) : tool === 'opencode' ? planOpencode(snapshot, env) : planMcpServersJson(snapshot, env)
  } catch (e) {
    plan = { status: 'refused', detail: e instanceof Error ? e.message : String(e) }
  }
  if (plan.status !== 'edit') return plan.status === 'refused' ? { status: 'refused', path, detail: `${plan.detail}; left unchanged` } : { status: plan.status, path }
  try {
    // An editor that saved the file (or re-pointed the link) meanwhile is not
    // overwritten. This narrows the window to the atomic write itself; editors
    // take no lock PLUR could honour, so it cannot be closed completely.
    if (linkTarget(path) !== target || readFileSync(target, 'utf8') !== snapshot) {
      return { status: 'refused', path, detail: 'the file changed while PLUR was editing it; left as it is now' }
    }
    atomicWrite(target, plan.content, { secret: true })
  } catch (e) {
    return { status: 'refused', path, detail: `could not write the file (${e instanceof Error ? e.message : String(e)})` }
  }
  return { status: 'updated', path }
}

/**
 * Why a value must not be written, or null. The same rules as
 * `buildToolMcpEnv`, applied again here so no caller can put a proxy user
 * name or password into an editor config, or a line break into a config
 * line. The detail names the setting, never its value.
 */
function valueProblem(env: Env): string | null {
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n\0]/.test(v)) return `${k} contains a line break or NUL`
  }
  try {
    buildToolMcpEnv({ caPath: env.NODE_EXTRA_CA_CERTS, proxy: { https: env.HTTPS_PROXY, http: env.HTTP_PROXY, noProxy: env.NO_PROXY } })
  } catch (e) {
    return e instanceof Error ? e.message.replace(/\.$/, '') : 'a launch setting cannot be written'
  }
  return null
}

/** The file a write lands in: a symlink's final target, else the path itself. Writes are atomic (temp file, rename, mode kept). */
function linkTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch {
    // Not a link, or it vanished: the path as given.
  }
  return path
}

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

/** Edits `entryPath.envKey` in a JSON/JSONC text key by key; verify() decides whether the result is safe. */
function editJsonEnv(text: string, entryPath: string[], envKey: string, current: Env | undefined, desired: Env): string {
  if (current === undefined) {
    return applyEdits(text, modify(text, [...entryPath, envKey], desired, JSON_FORMAT))
  }
  let out = text
  for (const k of new Set([...Object.keys(current), ...Object.keys(desired)])) {
    if (current[k] === desired[k]) continue
    out = desired[k] === undefined
      ? removeJsonProperty(out, [...entryPath, envKey], k)
      : applyEdits(out, modify(out, [...entryPath, envKey, k], desired[k], JSON_FORMAT))
  }
  return out
}

const COMMA = 5 // jsonc-parser SyntaxKind.CommaToken
const TRIVIA = new Set([12, 13, 14, 15]) // line comment, block comment, line break, whitespace

/**
 * Removes `key` from the object at `objectPath`: the property and one comma,
 * nothing else, so every comment stays (jsonc-parser's own removal takes the
 * comments up to the next property with it). A line left blank goes too.
 */
function removeJsonProperty(text: string, objectPath: string[], key: string): string {
  const object = findNodeAtLocation(parseTree(text) ?? { type: 'null', offset: 0, length: 0 } as never, objectPath)
  const props = object?.type === 'object' ? object.children ?? [] : []
  const i = props.map(p => p.children?.[0]?.value).lastIndexOf(key)
  if (i < 0) return text
  const prop = props[i]
  const tokenAfter = (pos: number) => {
    const scanner = createScanner(text, false)
    scanner.setPosition(pos)
    let kind = scanner.scan()
    while (TRIVIA.has(kind)) kind = scanner.scan()
    return { kind, offset: scanner.getTokenOffset() }
  }
  // The property, and one separating comma cut on its own: whatever lies
  // between them (comments, line breaks) stays.
  const cuts: Array<[number, number]> = [[prop.offset, prop.offset + prop.length]]
  // Comments inside the property (between key and value) stay, in its place.
  const kept: string[] = []
  const inner = createScanner(text, false)
  inner.setPosition(prop.offset)
  for (let k = inner.scan(); inner.getTokenOffset() < prop.offset + prop.length && k !== 17; k = inner.scan()) {
    if (k === 12 || k === 13) kept.push(text.slice(inner.getTokenOffset(), inner.getTokenOffset() + inner.getTokenLength()))
  }
  const next = tokenAfter(prop.offset + prop.length)
  if (next.kind === COMMA) cuts.push([next.offset, next.offset + 1])
  else if (i > 0) {
    const prev = tokenAfter(props[i - 1].offset + props[i - 1].length)
    if (prev.kind === COMMA) cuts.push([prev.offset, prev.offset + 1])
  }
  let out = text
  for (const [from, to] of [...cuts].sort((x, y) => y[0] - x[0])) {
    out = out.slice(0, from) + (from === prop.offset ? kept.join(' ') : '') + out.slice(to)
  }
  const at = prop.offset - cuts.filter(([from]) => from < prop.offset).reduce((n, [from, to]) => n + to - from, 0)
  const from = out.lastIndexOf('\n', at - 1) + 1
  const nl = out.indexOf('\n', at)
  const to = nl < 0 ? out.length : nl + 1
  if (out.slice(from, to).trim() === '') out = out.slice(0, from) + out.slice(to)
  return out
}

function planJsonEntry(
  text: string,
  parse: (t: string) => unknown,
  locate: (data: Record<string, unknown>) => string[] | null,
  envKey: string,
  env: Env,
  isLocal: (entry: Record<string, unknown>) => boolean,
): Plan {
  let data: unknown
  try {
    data = parse(text)
  } catch {
    return { status: 'refused', detail: 'the file could not be parsed' }
  }
  if (!isRecord(data)) return { status: 'refused', detail: 'the file could not be parsed' }
  const entryPath = locate(data)
  if (!entryPath) return { status: 'absent' }
  let entry: unknown = data
  for (const k of entryPath) entry = (entry as Record<string, unknown>)[k]
  if (!isRecord(entry)) return { status: 'refused', detail: 'the plur entry is not an object' }
  if (!isLocal(entry)) return { status: 'refused', detail: 'the plur entry is a remote entry with no command; a launch env does not apply to it' }
  const raw = entry[envKey]
  const current = raw === undefined ? undefined : stringRecord(raw)
  if (raw !== undefined && current === null) return { status: 'refused', detail: `the plur entry's ${envKey} is not a set of text values` }
  const desired = mergeEnv(current ?? {}, env)
  if (isDeepStrictEqual(current ?? {}, desired)) return { status: 'unchanged' }
  const content = editJsonEnv(text, entryPath, envKey, current ?? undefined, desired)
  let after: unknown
  try {
    after = parse(content)
  } catch {
    return { status: 'refused', detail: 'the edited file would not parse' }
  }
  if (!isDeepStrictEqual(normalizedEnv(after, entryPath, envKey), withEnv(data, entryPath, envKey, desired))) {
    return { status: 'refused', detail: 'the edit would change more than the plur entry' }
  }
  return { status: 'edit', content }
}

/** Claude Code and Cursor: strict JSON, `mcpServers.plur` with a command. */
function planMcpServersJson(text: string, env: Env): Plan {
  return planJsonEntry(text, t => JSON.parse(t), data => {
    const servers = data.mcpServers
    if (!isRecord(servers) || servers.plur === undefined) return null
    return ['mcpServers', 'plur']
  }, 'env', env, entry => !isRemoteEntry(entry) && typeof entry.command === 'string' && entry.command.length > 0)
}

/**
 * OpenCode: JSONC (comments and a BOM kept). The entry is where opencode-config
 * puts it: `mcp.servers.plur` when that exists (or no `mcp.plur` does), else
 * `mcp.plur`. A duplicate key makes the active entry ambiguous: refused.
 */
function planOpencode(text: string, env: Env): Plan {
  const bom = text.charCodeAt(0) === 0xfeff ? text[0] : ''
  const source = bom ? text.slice(1) : text
  try {
    parseJsonc(source)
  } catch {
    return { status: 'refused', detail: 'the file could not be parsed as JSONC' }
  }
  if (!unambiguousJsonc(source)) return { status: 'refused', detail: 'the file has a duplicate key, so which entry is active is ambiguous' }
  const plan = planJsonEntry(source, parseJsonc, data => {
    const mcp = isRecord(data.mcp) ? data.mcp : undefined
    if (!mcp) return null
    const servers = isRecord(mcp.servers) ? mcp.servers : undefined
    if (servers && (servers.plur != null || mcp.plur == null)) return servers.plur != null ? ['mcp', 'servers', 'plur'] : null
    return mcp.plur != null ? ['mcp', 'plur'] : null
  }, 'environment', env, entry => !isRemoteEntry(entry) && Array.isArray(entry.command) && entry.command.length > 0)
  return plan.status === 'edit' ? { status: 'edit', content: bom + plan.content } : plan
}

// ─── Codex TOML ───────────────────────────────────────────────────────────────

const PLUR_PATH = ['mcp_servers', 'plur']
const ENV_PATH = [...PLUR_PATH, 'env']
const keyPath = (k: AST.TOMLKey): string[] => k.keys.map(x => (x.type === 'TOMLBare' ? x.name : x.value))
const same = (a: (string | number)[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))
const tomlString = (v: string) => JSON.stringify(v)

/** Start of the line holding `offset`, and the offset just past that line's newline. */
function lineOf(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', end)
  return [from, nl < 0 ? text.length : nl + 1]
}

function planCodex(text: string, env: Env): Plan {
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(text, { tomlVersion: '1.0' })
  } catch {
    // Parser diagnostics may quote a line, and a line may hold a token.
    return { status: 'refused', detail: 'config.toml is not valid TOML' }
  }
  const data = getStaticTOMLValue(ast) as Record<string, unknown>
  const servers = data.mcp_servers
  const plur = isRecord(servers) ? servers.plur : undefined
  if (plur === undefined) return { status: 'absent' }
  if (!isRecord(plur)) return { status: 'refused', detail: 'the plur entry is not a table' }
  if (isRemoteEntry(plur) || typeof plur.command !== 'string') return { status: 'refused', detail: 'the plur entry is a remote entry with no command; a launch env does not apply to it' }
  const current = plur.env === undefined ? {} : stringRecord(plur.env)
  if (current === null) return { status: 'refused', detail: 'the plur entry\'s env is not a set of text values' }
  const desired = mergeEnv(current, env)
  if (isDeepStrictEqual(current, desired)) return { status: 'unchanged' }

  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const top = ast.body[0]
  // Every key/value with its full path, and the tables that matter.
  // `owner` is the path the kv's key is relative to (its table, or the key of
  // the inline table it sits in); `inline` is that inline table, if any.
  const kvs: Array<{ path: string[]; kv: AST.TOMLKeyValue; owner: string[]; inline: AST.TOMLInlineTable | null }> = []
  let envTable: AST.TOMLTable | null = null
  let plurTable: AST.TOMLTable | null = null
  const visit = (owner: string[], kv: AST.TOMLKeyValue, inline: AST.TOMLInlineTable | null) => {
    const path = [...owner, ...keyPath(kv.key)]
    kvs.push({ path, kv, owner, inline })
    if (kv.value.type === 'TOMLInlineTable') for (const child of kv.value.body) visit(path, child, kv.value)
  }
  for (const node of top.body) {
    if (node.type === 'TOMLKeyValue') visit([], node, null)
    else {
      const rk = node.resolvedKey.map(String)
      if (node.kind === 'standard' && same(rk, ENV_PATH)) envTable = node
      if (node.kind === 'standard' && same(rk, PLUR_PATH)) plurTable = node
      for (const kv of node.body) visit(rk, kv, null)
    }
  }

  let content: string
  const envNode = kvs.find(e => same(e.path, ENV_PATH))
  const envKeyNodes = kvs.filter(e => e.path.length === ENV_PATH.length + 1 && same(e.path.slice(0, -1), ENV_PATH))
  const commandNode = kvs.find(e => same(e.path, [...PLUR_PATH, 'command']))
  const noEnvYet = !envNode && !envTable && envKeyNodes.length === 0 && !plurTable
  if (noEnvYet && commandNode?.inline) {
    // The plur entry sits in an inline table (`plur = { … }`, or
    // `mcp_servers = { plur.command = … }`): its env goes inside those braces,
    // keyed relative to that table.
    const inline = commandNode.inline
    const prefix = [...PLUR_PATH.slice(commandNode.owner.length), 'env'].map(tomlKey).join('.')
    const value = '{ ' + Object.entries(desired).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ') + ' }'
    const at = inline.body[inline.body.length - 1].range[1]
    content = text.slice(0, at) + `, ${prefix} = ${value}` + text.slice(at)
  } else if (envNode || noEnvYet) {
    // `env = { … }` inline, or a plur entry written with dotted keys and no
    // env yet: one value, replaced or added by the shared Codex patcher.
    content = patchCodexEntry(text, { env: desired })
  } else {
    const edits: Array<{ start: number; end: number; text: string }> = []
    const adds: string[] = []
    const inlineRemovals = new Map<AST.TOMLInlineTable, Set<AST.TOMLKeyValue>>()
    for (const k of new Set([...Object.keys(current), ...Object.keys(desired)])) {
      if (current[k] === desired[k]) continue
      const node = envKeyNodes.find(e => e.path[e.path.length - 1] === k)
      if (desired[k] === undefined) {
        if (!node) return { status: 'refused', detail: `could not find ${k} in the plur env to remove it` }
        if (node.inline) {
          // Inside `{ … }`: cut below, per run of removed keys, with their commas.
          const set = inlineRemovals.get(node.inline) ?? new Set<AST.TOMLKeyValue>()
          inlineRemovals.set(node.inline, set.add(node.kv))
          continue
        }
        const [from, to] = lineOf(text, node.kv.range[0], node.kv.range[1])
        if (text.slice(from, node.kv.range[0]).trim() !== '') return { status: 'refused', detail: `${k} shares a line with another setting` }
        // A comment after the value stays, on its own line.
        const rest = text.slice(node.kv.range[1], to).trim()
        if (rest !== '' && !rest.startsWith('#')) return { status: 'refused', detail: `${k} shares a line with another setting` }
        const eol = /\r?\n$/.exec(text.slice(from, to))?.[0] ?? ''
        edits.push({ start: from, end: to, text: rest ? text.slice(from, node.kv.range[0]) + rest + eol : '' })
      } else if (node) {
        edits.push({ start: node.kv.value.range[0], end: node.kv.value.range[1], text: tomlString(desired[k]) })
      } else {
        adds.push(k)
      }
    }
    if (adds.length > 0) {
      if (envTable) {
        const table = envTable as AST.TOMLTable
        const last = table.body.length > 0 ? table.body[table.body.length - 1].range[1] : table.key.range[1]
        const [, at] = lineOf(text, last, last)
        const lines = adds.map(k => `${tomlKey(k)} = ${tomlString(desired[k])}`).join(newline) + newline
        edits.push({ start: at, end: at, text: (at === text.length && !text.endsWith('\n') ? newline : '') + lines })
      } else if (envKeyNodes.length > 0 && envKeyNodes[envKeyNodes.length - 1].inline) {
        // Dotted keys inside an inline table: added inside its braces.
        const lastNode = envKeyNodes[envKeyNodes.length - 1]
        const inline = lastNode.inline as AST.TOMLInlineTable
        const prefix = ENV_PATH.slice(lastNode.owner.length).map(tomlKey).join('.')
        const at = inline.body[inline.body.length - 1].range[1]
        edits.push({ start: at, end: at, text: adds.map(k => `, ${prefix}.${tomlKey(k)} = ${tomlString(desired[k])}`).join('') })
      } else if (envKeyNodes.length > 0) {
        // Dotted keys (`env.X = …`): add beside the last one, in the same form.
        const lastNode = envKeyNodes[envKeyNodes.length - 1]
        const prefix = ENV_PATH.slice(lastNode.owner.length).map(tomlKey).join('.')
        const [, at] = lineOf(text, lastNode.kv.range[1], lastNode.kv.range[1])
        const lines = adds.map(k => `${prefix}.${tomlKey(k)} = ${tomlString(desired[k])}`).join(newline) + newline
        edits.push({ start: at, end: at, text: (at === text.length && !text.endsWith('\n') ? newline : '') + lines })
      } else {
        // `[mcp_servers.plur]` with no env: a `[mcp_servers.plur.env]` table right after it.
        const table = plurTable as unknown as AST.TOMLTable
        const [, at] = lineOf(text, table.range[1], table.range[1])
        const lines = ['[mcp_servers.plur.env]', ...adds.map(k => `${tomlKey(k)} = ${tomlString(desired[k])}`)].join(newline) + newline
        edits.push({ start: at, end: at, text: (at === text.length && !text.endsWith('\n') ? newline : '') + lines })
      }
    }
    // An inline table (one line, no comments): each run of removed keys goes
    // with the comma before it, or, at the start, the comma after it.
    for (const [inline, removed] of inlineRemovals) {
      const body = inline.body
      for (let i = 0; i < body.length; ) {
        if (!removed.has(body[i])) { i++; continue }
        let j = i
        while (j + 1 < body.length && removed.has(body[j + 1])) j++
        if (i > 0) edits.push({ start: body[i - 1].range[1], end: body[j].range[1], text: '' })
        else if (j + 1 < body.length) edits.push({ start: body[i].range[0], end: body[j + 1].range[0], text: '' })
        else edits.push({ start: body[i].range[0], end: body[j].range[1], text: '' })
        i = j + 1
      }
    }
    // Overlapping deletions (none expected) are merged rather than applied twice.
    const merged: typeof edits = []
    for (const e of edits.sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1]
      if (last && last.text === '' && e.text === '' && e.start < last.end) last.end = Math.max(last.end, e.end)
      else merged.push({ ...e })
    }
    content = text
    for (const e of merged.reverse()) content = content.slice(0, e.start) + e.text + content.slice(e.end)
  }

  let after: unknown
  try {
    after = getStaticTOMLValue(parseTOML(content, { tomlVersion: '1.0' }))
  } catch {
    return { status: 'refused', detail: 'config.toml would not parse after the edit' }
  }
  if (!isDeepStrictEqual(normalizedEnv(after, PLUR_PATH, 'env'), withEnv(data, PLUR_PATH, 'env', desired))) {
    return { status: 'refused', detail: 'the edit would change more than the plur entry' }
  }
  return { status: 'edit', content }
}

// ─── toolLaunch ───────────────────────────────────────────────────────────────

/**
 * The exact command and env the tool would start for its `plur` entry, or
 * null when there is no local (command) entry to start. Codex passes on only
 * what `codexMcpEnvironment` says it does; the others start with the parent
 * env plus the entry's env.
 */
export function toolLaunch(
  tool: ToolId,
  parentEnv: NodeJS.ProcessEnv,
  loc: WireLocation & { platform?: NodeJS.Platform } = {},
): ToolLaunch | null {
  let text: string
  try {
    text = readFileSync(toolConfigPath(tool, loc), 'utf8')
  } catch {
    return null
  }
  try {
    if (tool === 'codex') {
      const entry = readCodexEntry(text)
      if (!entry || typeof entry.command !== 'string' || entry.url !== undefined) return null
      return { command: entry.command, args: entry.args ?? [], env: codexMcpEnvironment(entry, parentEnv, (loc.platform ?? process.platform) === 'win32') }
    }
    if (tool === 'opencode') {
      const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      const data = parseJsonc(source)
      const mcp = isRecord(data) && isRecord(data.mcp) ? data.mcp : undefined
      const servers = mcp && isRecord(mcp.servers) ? mcp.servers : undefined
      const entry = servers && (servers.plur != null || mcp?.plur == null) ? servers.plur : mcp?.plur
      if (!isRecord(entry) || isRemoteEntry(entry) || !Array.isArray(entry.command) || entry.command.length === 0) return null
      if (!entry.command.every((c): c is string => typeof c === 'string')) return null
      const environment = entry.environment === undefined ? {} : stringRecord(entry.environment)
      if (environment === null) return null
      return { command: entry.command[0], args: entry.command.slice(1), env: { ...parentEnv, ...environment } }
    }
    const data: unknown = JSON.parse(text)
    const servers = isRecord(data) && isRecord(data.mcpServers) ? data.mcpServers : undefined
    const entry = servers?.plur
    if (!isRecord(entry) || isRemoteEntry(entry) || typeof entry.command !== 'string' || entry.command.length === 0) return null
    const args = Array.isArray(entry.args) ? entry.args : []
    if (!args.every((a): a is string => typeof a === 'string')) return null
    const env = entry.env === undefined ? {} : stringRecord(entry.env)
    if (env === null) return null
    return { command: entry.command, args, env: { ...parentEnv, ...env } }
  } catch {
    return null
  }
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh'])
/** Launchers that start PLUR as a child of their own (package runners, WSL, busybox). */
const WRAPPERS = new Set(['bunx', 'pnpx', 'pnpm', 'yarn', 'npm', 'uvx', 'wsl', 'busybox'])

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')

/** A script of a package manager or runner run by Node itself (`node …/npm/bin/npx-cli.js`). */
const RUNNER_SCRIPT = /(^|[\\/])(node_modules[\\/](npm|corepack|pnpm|yarn|bun)|\.yarn)[\\/]|(^|[\\/])(npx|npm|pnpm|pnpx|yarn|corepack)([-.][^\\/]*)?\.c?js$/i

/**
 * The only launches the proof runs: PLUR's own `plur-mcp` (the `.plur/bin`
 * shim execs Node in place, so its pid is the server's), or Node running a
 * script file directly — the script first, no Node option before it, and not
 * a package runner's script.
 */
function isDirectLaunch(launch: ToolLaunch): boolean {
  const base = baseName(launch.command)
  if (base === 'plur-mcp') return true
  if (base !== 'node') return false
  const script = launch.args[0]
  return script !== undefined && !script.startsWith('-') && /\.(c|m)?js$/i.test(script) && !RUNNER_SCRIPT.test(script)
}

/**
 * Why the proof must not run this launch, or null for a direct one
 * (`isDirectLaunch`). Through npx, cmd.exe, a shell, `env` or a package
 * runner (bunx, pnpm, uvx, wsl, …), the process the proof starts is not the server, so
 * a timeout kill can leave the server running; a `.cmd`/`.bat` cannot start
 * at all on Windows without a shell (EINVAL).
 */
export function launchProblem(label: string, launch: ToolLaunch, platform: NodeJS.Platform): string | null {
  const fix = 're-run `plur init` after installing @plur-ai/mcp so it starts PLUR directly'
  if (isNpxLaunch(launch)) return `${label} starts PLUR through npx — ${fix}`
  let base = baseName(launch.command)
  // `env [-opts] [NAME=value…] program …` runs `program`: judge that one.
  if (base === 'env') base = baseName(launch.args.find(a => !a.startsWith('-') && !a.includes('=')) ?? '')
  if (SHELLS.has(base) || WRAPPERS.has(base)) return `${label} starts PLUR through ${base} — ${fix}`
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(launch.command)) {
    return `${label} starts PLUR through a .cmd launcher, which cannot start without a shell — ${fix}`
  }
  if (!isDirectLaunch(launch)) return `${label} starts PLUR through ${baseName(launch.command) || 'an unknown command'}, not PLUR itself — ${fix}`
  return null
}

// ─── WSL ──────────────────────────────────────────────────────────────────────

export type WslProbes = { codexOnPath: boolean; codexInWsl: boolean; isWsl: boolean; codexOnWindows: boolean }

/** Where Codex runs relative to this installer: here, across WSL (either way), or not found. */
export function wslSide(platform: NodeJS.Platform, probes: WslProbes): 'here' | 'wsl' | 'windows' | 'absent' {
  if (probes.codexOnPath) return 'here'
  if (platform === 'win32') return probes.codexInWsl ? 'wsl' : 'absent'
  if (platform === 'linux' && probes.isWsl) return probes.codexOnWindows ? 'windows' : 'absent'
  return 'absent'
}

/** WSL, from the kernel release (`os.release()`): an env variable or a file cannot fake it. */
export function isWslKernel(osRelease: string): boolean {
  return /microsoft/i.test(osRelease)
}

/** Mount points of Windows drives, from the kernel's mount table (WSL 1 `drvfs`, WSL 2 `9p` with `aname=drvfs`). */
export function windowsDriveMounts(mounts: string): string[] {
  const out: string[] = []
  for (const line of mounts.split('\n')) {
    const [, point, type, options = ''] = line.split(' ')
    if (!point || !type) continue
    if (type === 'drvfs' || (type === '9p' && /(^|,)aname=drvfs(;|,|$)/.test(options))) {
      // The table escapes a space as \040.
      out.push(point.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))))
    }
  }
  return out
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The facts `wslSide` needs, found without running anything a value from the
 * environment could choose:
 * - win32: Codex here is `resolveCodexBinary` (PATH or the Codex app). Only
 *   when it is missing, WSL is asked through `<SystemRoot>\System32\wsl.exe`
 *   by absolute path, for a SystemRoot of `<drive>:\Windows` only; any other
 *   SystemRoot runs nothing.
 * - linux: WSL from the kernel release; a `codex` on PATH counts as here
 *   unless it sits on a Windows drive mount (the mount table), where it is
 *   Windows' Codex. Nothing is run.
 */
export function probeWsl(opts: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  osRelease: string
  exec: ExecFn
  readMounts?: () => string
}): WslProbes {
  const probes: WslProbes = { codexOnPath: false, codexInWsl: false, isWsl: false, codexOnWindows: false }
  if (opts.platform === 'win32') {
    probes.codexOnPath = resolveCodexBinary(opts.env, 'win32') !== null
    if (probes.codexOnPath) return probes
    const root = windowsSystemRoot(opts.env)
    if (!root) return probes
    const r = opts.exec(`${root}\\System32\\wsl.exe`, ['-e', 'sh', '-lc', 'command -v codex'], { timeoutMs: 15_000 })
    probes.codexInWsl = r.status === 0 && /^\/\S*codex\s*$/.test(r.stdout.trim() + '\n')
    return probes
  }
  probes.isWsl = opts.platform === 'linux' && isWslKernel(opts.osRelease)
  let mounts: string[] = []
  if (probes.isWsl) {
    try {
      mounts = windowsDriveMounts((opts.readMounts ?? (() => readFileSync('/proc/mounts', 'utf8')))())
    } catch {
      mounts = []
    }
  }
  const onWindowsMount = (dir: string) => mounts.some(m => dir === m || dir.startsWith(m.endsWith('/') ? m : m + '/'))
  for (const dir of (opts.env.PATH ?? '').split(':')) {
    if (!dir || !dir.startsWith('/')) continue
    if (onWindowsMount(dir)) {
      if (['codex', 'codex.exe', 'codex.cmd'].some(n => exists(join(dir, n)))) probes.codexOnWindows = true
    } else if (isExecutableFile(join(dir, 'codex'))) {
      probes.codexOnPath = true
    }
  }
  return probes
}

// ─── wireTools ────────────────────────────────────────────────────────────────

/**
 * Wires every tool after `runPlurInit`: Codex on the other side of WSL is
 * reported with its side (and its config here is not touched); every other
 * tool with a `plur` entry gets `mcpEnv` and its launch read back. A tool
 * with no entry is not listed.
 */
export async function wireTools(opts: {
  mcpEnv: Env
  home?: string
  env?: NodeJS.ProcessEnv
  /** The env the tools start from (default process.env). */
  parentEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Precomputed WSL facts; otherwise `probeWsl` runs with `exec` (default the real one) and `osRelease` (default `os.release()`). */
  probes?: WslProbes
  exec?: ExecFn
  osRelease?: string
}): Promise<WireResult[]> {
  const platform = opts.platform ?? process.platform
  const loc = { home: opts.home, env: opts.env, platform }
  const parentEnv = opts.parentEnv ?? process.env
  const results: WireResult[] = []
  for (const tool of TOOLS) {
    const configPath = toolConfigPath(tool, loc)
    if (tool === 'codex') {
      const probes = opts.probes ?? probeWsl({ platform, env: opts.env ?? process.env, osRelease: opts.osRelease ?? release(), exec: opts.exec ?? realExec })
      const side = wslSide(platform, probes)
      if (side === 'wsl' || side === 'windows') {
        results.push({ tool, status: 'other-side', side, configPath, detail: OTHER_SIDE_TEXT[side] })
        continue
      }
    }
    const applied = applyMcpEnv(tool, opts.mcpEnv, loc)
    if (applied.status === 'absent') continue
    if (applied.status === 'refused') {
      results.push({ tool, status: 'refused', configPath, ...(applied.detail ? { detail: applied.detail } : {}) })
      continue
    }
    const launch = toolLaunch(tool, parentEnv, loc)
    if (!launch) {
      results.push({ tool, status: 'failed', configPath, detail: `the plur entry in ${configPath} has no command PLUR can start` })
      continue
    }
    const problem = launchProblem(TOOL_LABEL[tool], launch, platform)
    results.push(problem ? { tool, status: 'wired', configPath, detail: problem } : { tool, status: 'wired', configPath, launch })
  }
  return results
}
