import { spawn } from 'child_process'
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

/**
 * plur doctor — diagnose a Claude Code / Claude Desktop installation.
 *
 * Checks:
 *   1. Hooks installed in any settings.json (UserPromptSubmit etc.)
 *   2. `plur` MCP server registered in any of the known config files
 *   3. Whether `datacore` MCP server is also present (collision warning)
 *   4. Live MCP handshake — spawns the configured server command and
 *      sends an `initialize` JSON-RPC request to verify it actually starts.
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

interface DoctorReport {
  configs: ConfigFileReport[]
  hooksInstalled: boolean
  mcpRegistered: boolean
  datacoreCollision: boolean
  handshake: { ok: boolean; serverName?: string; serverVersion?: string; error?: string }
  embedder: { available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean }
  overall: 'ok' | 'fail'
}

function hasAnyPlurHook(config: Record<string, unknown>): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command && h.command.includes('@plur-ai/cli')) return true
      }
    }
  }
  return false
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
 * Spawn the configured plur MCP server and send an `initialize` JSON-RPC
 * request. Resolves with the server's name and version on success, or an
 * error on timeout / crash / invalid response.
 *
 * Times out after 20 seconds — first-run npx fetches the @plur-ai/mcp package
 * (and its native deps), which can take 10-15s. Subsequent runs respond in ~1s.
 */
async function mcpHandshake(timeoutMs = 20000): Promise<{ ok: boolean; serverName?: string; serverVersion?: string; error?: string }> {
  const entry = buildMcpServerEntry()

  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: { ok: boolean; serverName?: string; serverVersion?: string; error?: string }) => {
      if (resolved) return
      resolved = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err: unknown) {
      finish({ ok: false, error: `spawn failed: ${(err as Error).message}` })
      return
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms — server did not respond to initialize` })
    }, timeoutMs)

    let buffer = ''
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
            clearTimeout(timeout)
            const info = msg.result.serverInfo ?? {}
            finish({ ok: true, serverName: info.name, serverVersion: info.version })
            return
          }
          if (msg.id === 1 && msg.error) {
            clearTimeout(timeout)
            finish({ ok: false, error: `server error: ${msg.error.message ?? JSON.stringify(msg.error)}` })
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

async function checkEmbedder(flags: GlobalFlags): Promise<{ available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean }> {
  try {
    const plur = createPlur(flags)
    // Force a probe so we get a real load attempt rather than just the cached state
    plur.resetEmbedder()
    try {
      await plur.recallSemantic('plur doctor probe', { limit: 1 })
    } catch {
      // best effort
    }
    const status = plur.embedderStatus()
    return {
      available: status.available,
      loaded: status.loaded,
      lastError: status.lastError,
      modelLoaded: status.available && status.loaded,
    }
  } catch (err) {
    return {
      available: false,
      loaded: false,
      lastError: err instanceof Error ? err.message : String(err),
      modelLoaded: false,
    }
  }
}

function buildReport(skipHandshake: boolean, flags: GlobalFlags): Promise<DoctorReport> {
  const configs = inspectConfigs()
  const hooksInstalled = configs.some((c) => c.hasPlurHooks)
  const mcpRegistered = configs.some((c) => c.hasPlurMcp)
  const datacoreCollision = configs.some((c) => c.hasDatacoreMcp)

  const handshakePromise = skipHandshake
    ? Promise.resolve({ ok: false, error: 'skipped (--no-handshake)' })
    : mcpHandshake()

  return Promise.all([handshakePromise, checkEmbedder(flags)]).then(([handshake, embedder]) => {
    // Wiring overall: hooks + MCP + handshake. Embedder status is reported
    // separately as a warning — a degraded embedder doesn't fail the overall
    // doctor check (BM25 still works); it just signals semantic recall is
    // disabled until the model loads.
    const overall: 'ok' | 'fail' =
      hooksInstalled && mcpRegistered && (skipHandshake || handshake.ok) ? 'ok' : 'fail'
    return { configs, hooksInstalled, mcpRegistered, datacoreCollision, handshake, embedder, overall }
  })
}

function printText(report: DoctorReport): void {
  const tick = (b: boolean) => (b ? '✓' : '✗')

  outputText('plur doctor — Claude Code / Claude Desktop diagnostic')
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

  outputText('')
  if (report.embedder.modelLoaded) {
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
    if (!report.embedder.modelLoaded) {
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
