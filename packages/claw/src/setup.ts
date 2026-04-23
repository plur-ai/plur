import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

type OpenclawConfig = {
  plugins?: {
    entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
    [k: string]: unknown
  }
  [k: string]: unknown
}

const PLUGIN_ID = 'plur-claw'

function resolveConfigPath(): string {
  const envHome = process.env.OPENCLAW_HOME
  const root = envHome && envHome.trim().length > 0 ? envHome : join(homedir(), '.openclaw')
  return join(root, 'openclaw.json')
}

function canonicalBlock(): string {
  return JSON.stringify(
    {
      plugins: {
        entries: {
          [PLUGIN_ID]: { enabled: true },
        },
      },
    },
    null,
    2,
  )
}

function readConfig(path: string): { ok: true; data: OpenclawConfig } | { ok: false; reason: string } {
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim().length === 0) return { ok: true, data: {} }
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'config root is not a JSON object' }
    }
    return { ok: true, data: parsed as OpenclawConfig }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

function mergeEnable(cfg: OpenclawConfig): { cfg: OpenclawConfig; changed: boolean; alreadyEnabled: boolean } {
  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {}
  const existing = entries[PLUGIN_ID]
  const alreadyEnabled = !!(existing && existing.enabled === true)
  const nextEntry = {
    ...(existing ?? {}),
    enabled: true,
    config: (existing as any)?.config ?? { auto_learn: true, auto_capture: true, injection_budget: 2000 },
  }
  let changed = !existing || existing.enabled !== true
  entries[PLUGIN_ID] = nextEntry
  plugins.entries = entries

  // Set memory slot
  const slots = (plugins as any).slots && typeof (plugins as any).slots === 'object'
    ? (plugins as any).slots : {}
  if (slots.memory !== PLUGIN_ID) {
    slots.memory = PLUGIN_ID
    changed = true
  }
  ;(plugins as any).slots = slots

  cfg.plugins = plugins

  // Configure MCP server for agent-callable tools
  const mcp = (cfg as any).mcp && typeof (cfg as any).mcp === 'object' ? (cfg as any).mcp : {}
  const servers = mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {}
  if (!servers.plur) {
    const plurPath = process.env.PLUR_PATH || join(homedir(), '.plur')
    servers.plur = { command: 'npx', args: ['-y', '@plur-ai/mcp'], env: { PLUR_PATH: plurPath } }
    changed = true
  }
  mcp.servers = servers
  ;(cfg as any).mcp = mcp

  return { cfg, changed, alreadyEnabled }
}

function writeConfig(path: string, cfg: OpenclawConfig): { ok: true } | { ok: false; reason: string } {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

export type SetupStep = 'package_present' | 'config_enabled' | 'reload_required' | 'runtime_confirmed'
export type SetupStatus = 'ok' | 'skip' | 'fail' | 'pending'
export type SetupReport = {
  path: string
  steps: { step: SetupStep; status: SetupStatus; detail?: string }[]
  fallbackBlock?: string
}

export function runSetup(opts: { configPath?: string } = {}): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()
  const report: SetupReport = { path, steps: [{ step: 'package_present', status: 'ok' }] }

  if (!existsSync(path)) {
    report.steps.push({
      step: 'config_enabled',
      status: 'fail',
      detail: `config file not found: ${path}`,
    })
    report.fallbackBlock = canonicalBlock()
    report.steps.push({ step: 'reload_required', status: 'pending', detail: 'restart OpenClaw gateway after editing config' })
    report.steps.push({ step: 'runtime_confirmed', status: 'pending' })
    return report
  }

  const readRes = readConfig(path)
  if (!readRes.ok) {
    report.steps.push({ step: 'config_enabled', status: 'fail', detail: readRes.reason })
    report.fallbackBlock = canonicalBlock()
    report.steps.push({ step: 'reload_required', status: 'pending' })
    report.steps.push({ step: 'runtime_confirmed', status: 'pending' })
    return report
  }

  const merged = mergeEnable(readRes.data)
  if (merged.alreadyEnabled && !merged.changed) {
    report.steps.push({ step: 'config_enabled', status: 'skip', detail: 'already enabled' })
  } else {
    const w = writeConfig(path, merged.cfg)
    if (!w.ok) {
      report.steps.push({ step: 'config_enabled', status: 'fail', detail: w.reason })
      report.fallbackBlock = canonicalBlock()
      report.steps.push({ step: 'reload_required', status: 'pending' })
      report.steps.push({ step: 'runtime_confirmed', status: 'pending' })
      return report
    }
    report.steps.push({ step: 'config_enabled', status: 'ok' })
  }

  report.steps.push({
    step: 'reload_required',
    status: 'pending',
    detail: 'restart the OpenClaw gateway so the plugin loader re-reads config',
  })
  report.steps.push({
    step: 'runtime_confirmed',
    status: 'pending',
    detail: 'automatic verification not yet implemented (tracked in #39)',
  })
  return report
}

export function formatReport(r: SetupReport): string {
  const symbol = (s: SetupStatus) =>
    s === 'ok' ? '✓' : s === 'skip' ? '·' : s === 'pending' ? '…' : '✗'
  const lines = [`PLUR setup → ${r.path}`]
  for (const s of r.steps) {
    const tag = s.step.replace(/_/g, ' ')
    lines.push(`  ${symbol(s.status)} ${tag}${s.detail ? `  — ${s.detail}` : ''}`)
  }
  if (r.fallbackBlock) {
    lines.push('')
    lines.push('Could not write config automatically. Add this block manually:')
    lines.push(r.fallbackBlock)
  }
  return lines.join('\n')
}

export function runSetupCli(): number {
  const report = runSetup()
  process.stdout.write(formatReport(report) + '\n')
  const failed = report.steps.some((s) => s.status === 'fail')
  return failed ? 1 : 0
}

// Auto-run when executed directly (postinstall)
const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('setup.js')
if (isMain) {
  process.exit(runSetupCli())
}
