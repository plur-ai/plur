import { existsSync, readFileSync } from 'fs'
import { dirname, join, win32 } from 'path'
import { homedir, hostname, release } from 'os'
import yaml from 'js-yaml'
import { Plur, PersonalScopeTakenError, currentWindowsAccount, normalizeEndpointUrl, redactToken, windowsSystemRoot } from '@plur-ai/core'
import { deviceSignIn, DEVICE_KEY_RE } from '../commands/login.js'
import { countUploadCandidates } from '../commands/upload.js'
import { CLI_VERSION } from '../version.js'
import { urlOpener } from '../lib/open-url.js'
import type { InitOptions } from './args.js'
import { installCompanyCa } from './ca.js'
import { buildToolMcpEnv, envProxySupported, resolveProxy } from './launch-env.js'
import { deviceName, isHeadless, isVsCodeRemote, isWslRelease } from './device-name.js'
import { realExec, type ExecFn } from './exec.js'
import { checkExistingKey, connectServerStore, storeRefusalLines } from './server-store.js'
import { fetchMe, personalScopeOf, redactConsoleWith, type FetchFn } from './sign-in-shared.js'
import { protectKeyFile } from './key-file.js'
import { runPlurInit, wireTools } from './wire.js'
import { checkLaunchVersion } from './launch-check.js'
import { helloStatement, runHello, TOOL_LABEL } from './hello.js'
import { cleanupLegacy } from './cleanup.js'
import type { EnterpriseInitResult, WriteCheckResult } from './summary.js'

export interface InitDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  hostname?: () => string
  clock?: () => Date
  exec?: ExecFn
  fetch?: FetchFn
  sleep?: (ms: number) => Promise<void>
  print?: (line: string) => void
  openBrowser?: (url: string) => Promise<boolean>
  readToken?: () => Promise<string>
  cliEntry: string
}

/** Only deliberately constructed user diagnostics may leave this module. */
class InitFailure extends Error {}

/** Prepare trust before any network access. The CLI re-execs when this changes
 * startup-only Node settings; assigning NODE_EXTRA_CA_CERTS at runtime is not trust. */
export function prepareInitEnvironment(opts: InitOptions, deps: InitDeps): Record<string, string> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const plurDir = env.PLUR_PATH || join(deps.home ?? homedir(), '.plur')
  let caPath: string | undefined
  if (opts.caSha256) {
    const ca = installCompanyCa({ sha256: opts.caSha256, caFile: opts.caFile, plurDir, platform, env, exec: deps.exec ?? realExec })
    if (!ca.ok) throw new Error(ca.reason)
    caPath = ca.path
  }
  const mcpEnv = buildToolMcpEnv({ caPath, proxy: resolveProxy({ flag: opts.proxy, env }) })
  if (mcpEnv.NODE_USE_ENV_PROXY && !envProxySupported(process.versions.node)) {
    throw new Error('Proxy support needs Node 22.21 or newer supported Node; update Node and retry.')
  }
  return mcpEnv
}

async function readToken(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Pipe a key on stdin with --token-stdin.')
  let value = ''
  for await (const chunk of process.stdin) {
    value += chunk.toString()
    if (value.length > 4096) throw new Error('The key on stdin is too long.')
  }
  return value.trim()
}

/** Each requested scope must have one well-formed answer; an empty response is
 * not evidence of write access. Read-only preflight, never a test memory. */
async function writeChecks(server: string, token: string, scopes: string[], fetcher: FetchFn): Promise<WriteCheckResult[]> {
  const out: WriteCheckResult[] = []
  for (let i = 0; i < scopes.length; i += 50) {
    const chunk = scopes.slice(i, i + 50)
    const response = await fetcher(`${server}/api/v1/write-check`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: chunk }), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error('The server write check could not be completed.')
    const data = await response.json() as { results?: unknown }
    if (!Array.isArray(data.results) || data.results.length !== chunk.length) throw new Error('The server write check returned an incomplete answer.')
    for (const scope of chunk) {
      const rows = data.results.filter(row => row && row.scope === scope)
      const row = rows[0]
      if (rows.length !== 1 || typeof row.writable !== 'boolean' || typeof row.review_held !== 'boolean' || (row.reason !== undefined && typeof row.reason !== 'string')) {
        throw new Error('The server write check returned an invalid answer.')
      }
      out.push({ scope, writable: row.writable, review_held: row.review_held, ...(row.reason ? { reason: row.reason } : {}) })
    }
  }
  return out
}

export async function runEnterpriseInit(opts: InitOptions, deps: InitDeps): Promise<EnterpriseInitResult> {
  const env = deps.env ?? process.env, home = deps.home ?? homedir(), platform = deps.platform ?? process.platform
  const plurDir = env.PLUR_PATH || join(home, '.plur'), configPath = join(plurDir, 'config.yaml')
  const fetcher = deps.fetch ?? fetch
  const exec: ExecFn = (command, args, options) => (deps.exec ?? realExec)(command, args, { ...options, env: options?.env ?? env })
  const result: EnterpriseInitResult = { ok: false, signIn: { username: '', reused: false }, hello: null, tools: [], writeCheck: [], writeCheckState: 'pending', uploadCandidates: 0, vsCodeRemote: isVsCodeRemote(env) }
  let step: NonNullable<EnterpriseInitResult['failure']>['step'] = 'ca', token = '', plur: Plur | undefined
  let undoConsole: (() => void) | undefined
  let rollback: (() => ReturnType<typeof protectKeyFile>) | undefined
  let learnMayHaveRun = false
  const undoRegistration = () => {
    if (!rollback || result.signIn.reused || learnMayHaveRun) return
    try {
      const protectedFile = rollback()
      if (!protectedFile.ok) throw new Error('unprotected restore')
      rollback = undefined
    } catch { throw new InitFailure('Configuration changed or could not be safely restored. It was preserved; inspect the backup before retrying.') }
  }
  try {
    const mcpEnv = prepareInitEnvironment(opts, deps)
    if (Object.entries(mcpEnv).some(([key, value]) => env[key] !== value)) throw new Error('Start the installer with its verified CA and proxy environment before sign-in.')
    step = 'sign-in'
    const raw = existsSync(configPath) ? yaml.load(readFileSync(configPath, 'utf8')) : {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.yaml is not a configuration object. Nothing was changed.')
    const config = raw as { stores?: Array<{ url?: string; enterprise?: { hello_engram_id?: string } }> }
    const existing = await checkExistingKey({ server: opts.server, config, fetch: fetcher, env })
    if (existing.state === 'unknown') throw new InitFailure(`Could not check the existing key (${existing.reason}). Nothing was changed — run the installer again later.`)
    const name = deviceName((deps.hostname ?? hostname)(), platform, isWslRelease(release(), env))
    let me
    if (existing.state === 'works' && !opts.tokenStdin) {
      token = existing.token; me = existing.me
      result.signIn = { username: me.username, reused: true }
    } else {
      if (opts.tokenStdin) {
        token = (await (deps.readToken ?? readToken)()).trim()
        if (!DEVICE_KEY_RE.test(token)) throw new Error('The key on stdin is not a valid device key.')
      } else {
        const signed = await deviceSignIn({ server: opts.server, deviceName: name, fetch: fetcher,
          sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
          print: deps.print ?? (line => process.stderr.write(line + '\n')),
          headless: opts.noBrowser || isHeadless(env, platform), rerunHint: 'Run the installer again.',
          openBrowser: deps.openBrowser ?? (async url => {
            let [command, args] = urlOpener(url, platform)
            if (platform === 'win32') {
              const root = windowsSystemRoot(env)
              if (!root) return false
              command = win32.join(root, 'System32', 'rundll32.exe')
            }
            return exec(command, args, { timeoutMs: 5000 }).status === 0
          }),
        })
        token = signed.key; result.signIn.keyName = signed.keyName
      }
      const checked = await fetchMe(opts.server, token, { fetch: fetcher })
      if (checked.status !== 'ok') throw new Error('Could not verify the new key. Nothing was changed.')
      me = checked; result.signIn.username = me.username
    }
    undoConsole = redactConsoleWith(token)
    const personalScope = personalScopeOf(me)
    step = 'store'
    plur = new Plur({ path: plurDir, autoDiscover: false })
    const connected = await connectServerStore({ plur, server: opts.server, token, personalScope, configPath })
    rollback = connected.rollback
    result.backupDir = connected.backupPath ? dirname(connected.backupPath) : join(plurDir, 'backups', String((deps.clock ?? (() => new Date()))().getTime()))
    const protection = protectKeyFile(configPath, platform, undefined, currentWindowsAccount(env))
    if (!protection.ok) throw new Error(protection.detail)
    step = 'wire'
    if (!runPlurInit(exec, deps.cliEntry, join(result.backupDir, 'init.log')).ok) throw new InitFailure('Tool installation failed; inspect the installer log in the backup directory.')
    const wired = await wireTools({ mcpEnv, home, env, parentEnv: env, platform, exec })
    const expected = opts.expectVersion ?? CLI_VERSION
    result.tools = wired.map(tool => ({ tool: tool.tool, configPath: tool.configPath, status: tool.status, detail: tool.detail,
      ...(tool.status === 'other-side' ? { side: tool.side } : {}), proven: false,
      ...(tool.status === 'wired' && tool.launch ? { version: checkLaunchVersion(TOOL_LABEL[tool.tool], tool.launch, expected, exec) } : {}),
    }))
    const launches = wired.flatMap(tool => tool.status === 'wired' && tool.launch && result.tools.find(t => t.tool === tool.tool)?.version?.ok ? [{ tool: tool.tool, launch: tool.launch }] : [])
    step = 'hello'
    const previous = config.stores?.find(store => typeof store.url === 'string' && normalizeEndpointUrl(store.url) === normalizeEndpointUrl(opts.server))?.enterprise?.hello_engram_id
    learnMayHaveRun = true
    result.hello = await runHello({ launches, personalScope, serverUrl: opts.server, previousId: previous,
      statement: helloStatement({ username: me.username, deviceName: name, tools: launches.map(t => TOOL_LABEL[t.tool]), version: expected, date: (deps.clock ?? (() => new Date()))().toISOString().slice(0, 10) }),
    })
    for (const tool of result.tools) tool.proven = tool.status === 'wired' && tool.version?.ok === true && result.hello.saved.ok && result.hello.perTool.some(p => p.tool === tool.tool && p.recalled)
    if (!result.hello.saved.ok) {
      learnMayHaveRun = !result.hello.saved.notAttempted
      if (connected.discovery.status === 'not_synced') result.hello.saved.reason = 'not_synced'
      undoRegistration()
      return scrub(result, token)
    }
    await plur.registerEnterpriseServer(opts.server, { token, personalScope, enterprise: { hello_engram_id: result.hello.saved.id, device_name: name, mode: 'full', installed_version: expected } })
    const cleanup = cleanupLegacy({ tools: result.tools.filter(t => t.proven).map(t => t.tool), backupDir: result.backupDir, plurDir, home, env, platform })
    if (cleanup.some(entry => entry.status === 'refused')) throw new InitFailure('Legacy configuration was kept because cleanup could not be completed safely. The accepted save and key were kept. Check init.log in the backup directory, install any missing editor, and resolve its configuration before running the installer again.')
    if (!result.signIn.reused) result.flushed = await plur.flushOutbox({ force: true })
    if (connected.discovery.status !== 'ok') throw new InitFailure('Team scope discovery was not verified. The accepted save and key were kept; run the installer again.')
    const scopes = [...new Set(connected.discovery.scopes)]
    result.writeCheck = await writeChecks(opts.server, token, scopes.filter(s => /^(group|project):/.test(s)), fetcher)
    result.writeCheckState = 'complete'
    result.uploadCandidates = await countUploadCandidates(plur, scopes)
    result.ok = result.tools.some(t => t.proven) && result.tools.every(t => t.proven || t.status === 'other-side')
    return scrub(result, token)
  } catch (err) {
    // Config/parser and tool failures can quote secrets. Only fixed diagnostics
    // cross this boundary; detailed core errors are never serialized as JSON.
    let message = err instanceof PersonalScopeTakenError ? storeRefusalLines(err, opts.server, configPath, { reused: result.signIn.reused }).join('\n')
      : err instanceof InitFailure ? err.message
      : step === 'hello' ? 'The connection or server write check could not be completed. Run the installer again.' : `The ${step} step could not be completed. Check the configuration and run the installer again.`
    try { undoRegistration() } catch (restore) { message += ` ${String((restore as Error).message)}` }
    result.failure = { step, message }
    return scrub(result, token)
  } finally { undoConsole?.(); plur?.close() }
}

function scrub(result: EnterpriseInitResult, token: string): EnterpriseInitResult {
  return JSON.parse(redactToken(JSON.stringify(result), token)) as EnterpriseInitResult
}
