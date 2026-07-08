import { spawn } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { join, extname } from 'path'
import { homedir, platform } from 'os'
import { createPlur, type GlobalFlags } from '../plur.js'
import { outputText, outputJson, shouldOutputJson } from '../output.js'
import {
  type ConfigFile,
  buildMcpServerEntry,
  hasDatacoreMcp,
  hasPlurMcp,
  knownConfigFiles,
  readConfig,
} from '../mcp-config.js'
import { hasPlurCursorHooks, readCursorHooksConfig } from '../cursor-hooks.js'

/**
 * plur doctor — diagnose a Claude Code / Claude Desktop / Cursor installation.
 *
 * Checks:
 *   1. Hooks installed in any settings.json (UserPromptSubmit etc.) or, for
 *      Cursor, its separate flat-shaped `.cursor/hooks.json`.
 *   2. `plur` MCP server registered in any of the known config files
 *   3. Whether `datacore` MCP server is also present (collision warning)
 *   4. Live MCP handshake — spawns the configured server command and
 *      sends an `initialize` JSON-RPC request to verify it actually starts,
 *      then a `tools/list` request to report the live tool count. Probed
 *      twice — once with the default env, once forcing
 *      `PLUR_TOOL_PROFILE=cursor` — so a Cursor user can see whether their
 *      setup is actually using the reduced tool profile.
 *
 * Exits 0 if everything is healthy, 1 if any check fails.
 */

interface ConfigFileReport {
  label: string
  path: string
  exists: boolean
  hasPlurMcp: boolean
  hasDatacoreMcp: boolean
  hasPlurHooks: boolean
}

interface HookShimReport {
  valid: boolean
  shimPath: string
  error?: string
}

interface DoctorReport {
  configs: ConfigFileReport[]
  hooksInstalled: boolean
  mcpRegistered: boolean
  datacoreCollision: boolean
  staleNpxHooks: boolean
  staleNpxMcp: boolean
  hookShim: HookShimReport
  mcpShim: HookShimReport
  handshake: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string }
  /**
   * Second handshake, forcing `PLUR_TOOL_PROFILE=cursor`, so the report can show
   * both tool counts side by side rather than guessing which profile a given
   * config file's env is actually wired to. `null` when the default handshake
   * itself failed or was skipped (--no-handshake) — no point probing a second
   * profile if the server doesn't even come up once.
   */
  cursorHandshake: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string } | null
  embedder: { available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean; disabled: boolean; disabledReason: string | null }
  overall: 'ok' | 'fail'
}

function hasAnyPlurHook(config: Record<string, unknown>): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command && (h.command.includes('@plur-ai/cli') || h.command.includes('.plur/bin/plur-hook'))) return true
      }
    }
  }
  return false
}

function hasStaleNpxHooks(config: Record<string, unknown>): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command && h.command.includes('npx') && h.command.includes('@plur-ai/cli')) return true
      }
    }
  }
  return false
}

/**
 * Detect stale npx-based MCP server registration (#234). Returns true if
 * the plur MCP entry uses npx instead of the local shim.
 *
 * The args[] check catches both layouts we ship: `cmd.exe /c npx ...` on
 * Windows and `/bin/sh -lc 'exec npx -y @plur-ai/mcp@latest'` on unix.
 */
function hasStaleNpxMcp(config: Record<string, unknown>): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, { command?: string; args?: string[] }>
  const plur = servers.plur
  if (!plur) return false
  if (plur.command && plur.command.includes('npx')) return true
  const argsBlob = (plur.args ?? []).join(' ')
  return argsBlob.includes('npx') && argsBlob.includes('@plur-ai/mcp')
}

/** Mirror of validateHookShim() for the MCP shim (#234). */
function validateMcpShim(): HookShimReport {
  const name = platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp'
  const path = join(homedir(), '.plur', 'bin', name)

  if (!existsSync(path)) {
    return { valid: false, shimPath: path, error: 'shim not found — run `plur init` to create it (requires @plur-ai/mcp installed alongside CLI)' }
  }

  const content = readFileSync(path, 'utf-8')
  const match = content.match(/"([^"]+index\.js)"/)
  if (!match) {
    return { valid: false, shimPath: path, error: 'shim has unexpected format' }
  }

  if (!existsSync(match[1])) {
    return { valid: false, shimPath: path, error: `entrypoint missing: ${match[1]} — run \`plur init\` to fix` }
  }

  return { valid: true, shimPath: path }
}

function validateHookShim(): HookShimReport {
  const name = platform() === 'win32' ? 'plur-hook.cmd' : 'plur-hook'
  const path = join(homedir(), '.plur', 'bin', name)

  if (!existsSync(path)) {
    return { valid: false, shimPath: path, error: 'shim not found — run `plur init` to create it' }
  }

  const content = readFileSync(path, 'utf-8')
  const match = content.match(/"([^"]+index\.js)"/)
  if (!match) {
    return { valid: false, shimPath: path, error: 'shim has unexpected format' }
  }

  if (!existsSync(match[1])) {
    return { valid: false, shimPath: path, error: `entrypoint missing: ${match[1]} — run \`plur init\` to fix` }
  }

  return { valid: true, shimPath: path }
}

function inspectConfigs(): ConfigFileReport[] {
  return knownConfigFiles().map((cf: ConfigFile) => {
    if (!cf.exists) {
      return {
        label: cf.label,
        path: cf.path,
        exists: false,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: false,
      }
    }
    if (cf.kind === 'cursor-hooks') {
      // Cursor's hooks.json is a flat { event: [{command, ...}] } shape, not
      // Claude Code's nested { matcher, hooks: [...] } wrapper — hasAnyPlurHook
      // would silently read it as "no hooks installed" even when they are.
      const hooksConfig = readCursorHooksConfig(cf.path)
      return {
        label: cf.label,
        path: cf.path,
        exists: true,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: hasPlurCursorHooks(hooksConfig),
      }
    }
    const config = readConfig(cf.path)
    return {
      label: cf.label,
      path: cf.path,
      exists: true,
      hasPlurMcp: hasPlurMcp(config),
      hasDatacoreMcp: hasDatacoreMcp(config),
      hasPlurHooks: hasAnyPlurHook(config),
    }
  })
}

/**
 * Spawn the configured plur MCP server, send an `initialize` JSON-RPC
 * request, then — once that succeeds — a `tools/list` request to count the
 * live tool surface. Resolves with the server's name, version, and tool
 * count on success, or an error on timeout / crash / invalid response.
 *
 * `envOverride` lets the caller force env vars (e.g. `PLUR_TOOL_PROFILE:
 * 'cursor'`) onto the spawned process without touching `process.env` itself —
 * used to probe the cursor tool profile alongside the default one, since
 * parsing each config file's configured env to guess which profile is
 * "active" would be fragile (a hand-edited config could have anything).
 *
 * Times out after 20 seconds — first-run npx fetches the @plur-ai/mcp package
 * (and its native deps), which can take 10-15s. Subsequent runs respond in ~1s.
 */
async function mcpHandshake(
  timeoutMs = 20000,
  envOverride?: Record<string, string>,
): Promise<{ ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string }> {
  const entry = buildMcpServerEntry()
  const spawnEnv = envOverride ? { ...process.env, ...envOverride } : undefined

  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string }) => {
      if (resolved) return
      resolved = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(entry.command, entry.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(spawnEnv ? { env: spawnEnv } : {}),
      })
    } catch (err: unknown) {
      finish({ ok: false, error: `spawn failed: ${(err as Error).message}` })
      return
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms — server did not respond to initialize` })
    }, timeoutMs)

    let buffer = ''
    let serverInfo: { name?: string; version?: string } | null = null
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result) {
            serverInfo = msg.result.serverInfo ?? {}
            proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
            continue
          }
          if (msg.id === 1 && msg.error) {
            clearTimeout(timeout)
            finish({ ok: false, error: `server error: ${msg.error.message ?? JSON.stringify(msg.error)}` })
            return
          }
          if (msg.id === 2 && msg.result) {
            clearTimeout(timeout)
            finish({
              ok: true,
              serverName: serverInfo?.name,
              serverVersion: serverInfo?.version,
              toolCount: Array.isArray(msg.result.tools) ? msg.result.tools.length : undefined,
            })
            return
          }
          if (msg.id === 2 && msg.error) {
            // tools/list failed but initialize succeeded — still report as healthy, just without a count.
            clearTimeout(timeout)
            finish({ ok: true, serverName: serverInfo?.name, serverVersion: serverInfo?.version })
            return
          }
        } catch {
          // Not a JSON-RPC frame — likely a startup banner. Ignore.
        }
      }
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      finish({ ok: false, error: `spawn error: ${err.message}` })
    })

    proc.on('exit', (code: number | null) => {
      if (!resolved) {
        clearTimeout(timeout)
        finish({ ok: false, error: `server exited (code=${code}) before responding` })
      }
    })

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'plur-doctor', version: '0.8.1' },
      },
    }
    proc.stdin?.write(JSON.stringify(initRequest) + '\n')
  })
}

/**
 * Resolve the CLI's JavaScript entry path for subprocess spawning.
 *
 * `process.argv[1]` is the script Node was told to run, but:
 *   - npx/global installs route through bin shims (often symlinks)
 *   - pkg/bun/nexe compile the entire CLI into a single binary — no .js file exists
 *
 * Strategy: realpath the argv[1] symlink chain, then check the extension.
 * If the resolved path is not a Node-executable script, return null and let
 * the caller fall back gracefully.
 */
function resolveCliJsEntry(): string | null {
  const argv1 = process.argv[1]
  if (!argv1) return null
  let resolved: string
  try {
    resolved = realpathSync(argv1)
  } catch {
    return null
  }
  const ext = extname(resolved).toLowerCase()
  if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') return null
  return resolved
}

/**
 * Probe the embedder in an isolated subprocess (issue #197).
 *
 * Why subprocess: onnxruntime-node has a known SIGABRT crash on macOS during
 * thread pool cleanup on process exit. Running the probe in-process makes
 * `plur doctor` itself exit with code 134 even when everything is healthy.
 * Subprocess isolation contains the crash — if the probe dies, parent reports
 * embedder as degraded and continues with the rest of the doctor checks.
 *
 * Timeout: 60s default (#273). Cold model downloads (130MB for bge-small,
 * 325MB for embedding-gemma) need 60-300s on slow connections. Override via
 * PLUR_DOCTOR_TIMEOUT env var (in seconds) if 60s is still too short.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000

/**
 * Resolve the probe timeout from PLUR_DOCTOR_TIMEOUT (seconds). Invalid values
 * (garbage, empty string, zero, negative) fall back to the 60s default — a NaN
 * delay would make setTimeout fire after 1ms, instantly failing the probe with
 * the very "probe timeout" symptom #273 fixes. Exported for tests.
 */
export function resolveProbeTimeoutMs(envValue = process.env.PLUR_DOCTOR_TIMEOUT): number {
  const parsed = Number.parseInt(envValue ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_PROBE_TIMEOUT_MS
}

async function checkEmbedder(_flags: GlobalFlags, timeoutMs = resolveProbeTimeoutMs()): Promise<{ available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean; disabled: boolean; disabledReason: string | null }> {
  return new Promise((resolve) => {
    const fallback = (lastError: string) => ({
      available: false,
      loaded: false,
      lastError,
      modelLoaded: false,
      disabled: false,
      disabledReason: null,
    })

    const cliEntry = resolveCliJsEntry()
    if (!cliEntry) {
      // Compiled binary, missing entry, or unresolvable symlink. We can't spawn
      // a subprocess that re-enters the CLI. Report skipped — the user will
      // see this in the doctor output and know to investigate manually.
      resolve(fallback('embedder probe skipped: CLI entry is not a JS file (compiled binary?)'))
      return
    }

    let resolved = false
    const finish = (result: ReturnType<typeof fallback>) => {
      if (resolved) return
      resolved = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(process.execPath, [cliEntry, '_embedder-probe'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Mark the subprocess as the parent-spawned probe — the probe checks
        // this and refuses to run if invoked directly by a curious user.
        env: { ...process.env, PLUR_INTERNAL_PROBE: '1' },
      })
    } catch (err: unknown) {
      finish(fallback(`spawn failed: ${(err as Error).message}`))
      return
    }

    const timeout = setTimeout(() => {
      finish(fallback(`probe timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdoutBuf = ''
    let stderrBuf = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8') })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      finish(fallback(`probe spawn error: ${err.message}`))
    })

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout)
      // Parse the LAST line starting with `{` — defends against any stdout
      // pollution (logs, warnings) that might precede the result line.
      const lines = stdoutBuf.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
      const resultLine = lines[lines.length - 1]
      if (resultLine) {
        try {
          const parsed = JSON.parse(resultLine)
          finish({
            available: !!parsed.available,
            loaded: !!parsed.loaded,
            lastError: parsed.lastError ?? null,
            modelLoaded: !!parsed.modelLoaded,
            disabled: !!parsed.disabled,
            disabledReason: parsed.disabledReason ?? null,
          })
          return
        } catch { /* fall through */ }
      }
      // No parseable output — crash or timeout. Report degraded with diagnostics.
      const detail = signal ? `signal ${signal}` : `exit ${code}`
      const stderrTrim = stderrBuf.trim().slice(0, 200)
      finish(fallback(`embedder probe failed (${detail})${stderrTrim ? `: ${stderrTrim}` : ''}`))
    })
  })
}

function buildReport(skipHandshake: boolean, flags: GlobalFlags): Promise<DoctorReport> {
  const configs = inspectConfigs()
  const hooksInstalled = configs.some((c) => c.hasPlurHooks)
  const mcpRegistered = configs.some((c) => c.hasPlurMcp)
  const datacoreCollision = configs.some((c) => c.hasDatacoreMcp)

  // Check for stale npx hooks across all existing configs (#178)
  const staleNpxHooks = configs.some((c) => {
    if (!c.exists) return false
    const config = readConfig(c.path)
    return hasStaleNpxHooks(config)
  })

  // Check for stale npx-based MCP server registration (#234)
  const staleNpxMcp = configs.some((c) => {
    if (!c.exists) return false
    const config = readConfig(c.path)
    return hasStaleNpxMcp(config)
  })

  const hookShim = validateHookShim()
  const mcpShim = validateMcpShim()

  const handshakePromise = skipHandshake
    ? Promise.resolve({ ok: false, error: 'skipped (--no-handshake)' })
    : mcpHandshake()

  return Promise.all([handshakePromise, checkEmbedder(flags)]).then(async ([handshake, embedder]) => {
    // Probe the cursor tool profile too, so the report shows both tool
    // counts side by side instead of guessing which one a given config
    // file's env is actually wired to (see mcpHandshake's doc comment).
    // Only worth a second spawn if the default handshake actually came up —
    // no point probing a profile variant of a server that doesn't start.
    const cursorHandshake = handshake.ok ? await mcpHandshake(20000, { PLUR_TOOL_PROFILE: 'cursor' }) : null

    // Wiring overall: hooks + MCP + handshake. Embedder status is reported
    // separately as a warning — a degraded embedder doesn't fail the overall
    // doctor check (BM25 still works); it just signals semantic recall is
    // disabled until the model loads.
    const overall: 'ok' | 'fail' =
      hooksInstalled && mcpRegistered && (skipHandshake || handshake.ok) ? 'ok' : 'fail'
    return { configs, hooksInstalled, mcpRegistered, datacoreCollision, staleNpxHooks, staleNpxMcp, hookShim, mcpShim, handshake, cursorHandshake, embedder, overall }
  })
}

function printText(report: DoctorReport): void {
  const tick = (b: boolean) => (b ? '✓' : '✗')

  outputText('plur doctor — Claude Code / Claude Desktop / Cursor diagnostic')
  outputText('')
  outputText('Config files:')
  for (const c of report.configs) {
    if (!c.exists) {
      outputText(`  - ${c.label}: not present (${c.path})`)
      continue
    }
    const flags: string[] = []
    if (c.hasPlurMcp) flags.push('plur MCP')
    if (c.hasPlurHooks) flags.push('plur hooks')
    if (c.hasDatacoreMcp) flags.push('datacore MCP')
    outputText(`  ${tick(c.hasPlurMcp || c.hasPlurHooks)} ${c.label}: ${flags.length ? flags.join(', ') : '(empty)'}`)
    outputText(`     ${c.path}`)
  }

  outputText('')
  outputText(`${tick(report.hooksInstalled)} Hooks installed`)
  outputText(`${tick(report.mcpRegistered)} plur MCP server registered`)

  if (report.datacoreCollision) {
    outputText('')
    outputText('⚠  datacore MCP server detected alongside plur.')
    outputText('   plur and datacore are SEPARATE MCP servers with separate tool namespaces.')
    outputText('   plur tools are prefixed plur_* (plur_learn, plur_recall_hybrid, etc.).')
    outputText('   datacore tools are prefixed datacore_*. They do NOT share memory.')
    outputText('   If your agent confuses them, this is the cause.')
  }

  // Hook shim status (#178)
  outputText('')
  if (report.hookShim.valid) {
    outputText(`✓ Hook shim: ${report.hookShim.shimPath}`)
  } else {
    outputText(`✗ Hook shim: ${report.hookShim.error}`)
  }

  if (report.staleNpxHooks) {
    outputText('')
    outputText('⚠  Hooks still use npx — slow (200-2000ms per hook) and vulnerable to cache corruption.')
    outputText('   Fix: run `plur init` to migrate to the local hook binary (<5ms per hook).')
  }

  // MCP shim status (#234) — same problem on MCP launch, same fix pattern
  if (report.mcpShim.valid) {
    outputText(`✓ MCP shim:  ${report.mcpShim.shimPath}`)
  } else {
    outputText(`✗ MCP shim:  ${report.mcpShim.error}`)
  }

  if (report.staleNpxMcp) {
    outputText('')
    outputText('⚠  plur MCP still launched via npx — vulnerable to ENOTEMPTY cache corruption on version bumps (#234).')
    outputText('   This is the same bug class as #178 (which fixed hooks). Symptom: Claude Code')
    outputText('   sessions silently lose PLUR memory after a new @plur-ai/mcp publish.')
    outputText('   Fix: run `plur init` to migrate to the local MCP binary (no npx, no race).')
  }

  outputText('')
  if (report.handshake.ok) {
    outputText(`✓ MCP handshake: ${report.handshake.serverName} v${report.handshake.serverVersion}`)
  } else {
    outputText(`✗ MCP handshake failed: ${report.handshake.error}`)
    outputText('  Likely causes:')
    outputText('    - npx not on PATH (Claude Desktop launches GUI without your shell PATH)')
    outputText('    - @plur-ai/mcp not yet downloaded — first run can take a few seconds')
    outputText('    - Network blocked — try `npx -y @plur-ai/mcp` manually')
  }

  // Live tool-budget report — both profiles side by side (Cursor caps a
  // workspace at ~40 MCP tools total across every server). Printing both
  // counts, rather than trying to infer which profile a config file's env
  // actually activates, sidesteps guessing at hand-edited/partially-migrated
  // configs: the user can just compare the two numbers themselves.
  if (report.handshake.ok && report.handshake.toolCount !== undefined) {
    outputText(`MCP tools exposed (default/full profile): ${report.handshake.toolCount}`)
  }
  if (report.cursorHandshake?.ok && report.cursorHandshake.toolCount !== undefined) {
    outputText(`MCP tools exposed (PLUR_TOOL_PROFILE=cursor): ${report.cursorHandshake.toolCount}`)
  }
  if (report.handshake.ok && report.handshake.toolCount !== undefined && report.handshake.toolCount > 15) {
    outputText(
      `  Cursor caps a workspace at ~40 MCP tools total across every server. If .cursor/mcp.json's ` +
      `plur entry doesn't set PLUR_TOOL_PROFILE=cursor in its env, Cursor is getting the full ` +
      `${report.handshake.toolCount}-tool surface above, not the ~9-tool one. Run \`plur init --cursor\` to fix, ` +
      `or set the env var directly if you registered the server by hand.`,
    )
  }

  outputText('')
  if (report.embedder.disabled) {
    outputText(`○ Embedding layer DISABLED — ${report.embedder.disabledReason ?? 'embeddings disabled'}`)
    outputText('  Hybrid recall is running in BM25-only mode (this is intentional).')
    outputText('  Re-enable: unset PLUR_DISABLE_EMBEDDINGS or set embeddings.enabled: true in ~/.plur/config.yaml')
  } else if (report.embedder.modelLoaded) {
    outputText('✓ Embedding model loaded — hybrid search is fully operational')
  } else {
    outputText('✗ Embedding model NOT loaded — hybrid search will silently degrade to BM25-only')
    if (report.embedder.lastError) {
      outputText(`  Last error: ${report.embedder.lastError}`)
    }
    outputText('  Likely causes:')
    outputText('    - First-run download not completed (try again in a few seconds)')
    outputText('    - Network blocked HuggingFace Hub — check huggingface.co connectivity')
    outputText('    - @huggingface/transformers package failed to load (ONNX runtime issue)')
    outputText('    - pnpm hoisting: onnxruntime-node not findable from transformers package root')
    outputText('  To opt out (run BM25-only intentionally): set PLUR_DISABLE_EMBEDDINGS=1')
    outputText('    or write `embeddings: { enabled: false }` to ~/.plur/config.yaml')
  }

  outputText('')
  if (report.overall === 'ok') {
    outputText('✓ Healthy. plur is ready to use in Claude Code.')
  } else {
    outputText('✗ Issues detected.')
    if (!report.hooksInstalled || !report.mcpRegistered) {
      outputText('  Fix: run `npx @plur-ai/cli init`')
    }
    if (report.hooksInstalled && report.mcpRegistered && !report.handshake.ok) {
      outputText('  Fix: ensure `npx` is reachable from Claude Desktop')
      outputText('       — try launching Claude from your terminal once,')
      outputText('       — or replace the plur entry command with an absolute path to your shell.')
    }
    if (!report.embedder.modelLoaded && !report.embedder.disabled) {
      outputText('  Fix: from the @plur-ai/core package directory, run a script that imports')
      outputText('       @huggingface/transformers and calls pipeline() once to trigger the')
      outputText('       BGE-small-en-v1.5 download (~130MB).')
    }
  }
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const skipHandshake = args.includes('--no-handshake')
  const report = await buildReport(skipHandshake, flags)

  if (shouldOutputJson(flags)) {
    outputJson(report)
  } else {
    printText(report)
  }

  process.exit(report.overall === 'ok' ? 0 : 1)
}
