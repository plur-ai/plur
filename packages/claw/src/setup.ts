import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveTelemetry } from './telemetry.js'

type OpenclawConfig = {
  plugins?: {
    entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown>; hooks?: Record<string, unknown> }>
    [k: string]: unknown
  }
  [k: string]: unknown
}

const PLUGIN_ID = 'plur-claw'

function resolveOpenclawHome(): string {
  const envHome = process.env.OPENCLAW_HOME
  return envHome && envHome.trim().length > 0 ? envHome : join(homedir(), '.openclaw')
}

function resolveConfigPath(): string {
  return join(resolveOpenclawHome(), 'openclaw.json')
}

function resolveExtensionPath(): string {
  return join(resolveOpenclawHome(), 'extensions', PLUGIN_ID)
}

function canonicalBlock(): string {
  return JSON.stringify(
    {
      plugins: {
        entries: {
          [PLUGIN_ID]: { enabled: true },
        },
        slots: { memory: PLUGIN_ID },
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

type MergeResult = {
  cfg: OpenclawConfig
  anyChanged: boolean
  enableChanged: boolean
  enableAlready: boolean
  slotChanged: boolean
  slotAlready: boolean
}

function mergeEnable(cfg: OpenclawConfig): MergeResult {
  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {}
  const existing = entries[PLUGIN_ID]
  const enableAlready = !!(existing && existing.enabled === true)
  const nextEntry = {
    ...(existing ?? {}),
    enabled: true,
    config: (existing as any)?.config ?? { auto_learn: true, auto_capture: true, injection_budget: 2000 },
    // Required for agent_end hook — without this, OpenClaw silently blocks
    // the learning hook and PLUR can inject but never learn from conversations.
    hooks: { ...((existing as any)?.hooks ?? {}), allowConversationAccess: true },
  }
  const enableChanged = !existing || existing.enabled !== true
  const hooksChanged = !existing?.hooks?.allowConversationAccess
  entries[PLUGIN_ID] = nextEntry
  plugins.entries = entries

  // Set memory slot
  const slots = (plugins as any).slots && typeof (plugins as any).slots === 'object'
    ? (plugins as any).slots : {}
  const slotAlready = slots.memory === PLUGIN_ID
  const slotChanged = !slotAlready
  if (slotChanged) {
    slots.memory = PLUGIN_ID
  }
  ;(plugins as any).slots = slots

  // Append to plugins.allow only when the user is already gating via a non-empty
  // allowlist — matching OpenClaw's buildPluginsAllowPatch semantics. Creating an
  // allowlist where none existed would silently gate other plugins the user had.
  const allowCurrent = (plugins as any).allow
  let allowChanged = false
  if (Array.isArray(allowCurrent) && allowCurrent.length > 0 && !allowCurrent.includes(PLUGIN_ID)) {
    ;(plugins as any).allow = [...allowCurrent, PLUGIN_ID]
    allowChanged = true
  }

  cfg.plugins = plugins

  // Configure MCP server for agent-callable tools
  const mcp = (cfg as any).mcp && typeof (cfg as any).mcp === 'object' ? (cfg as any).mcp : {}
  const servers = mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {}
  let mcpChanged = false
  if (!servers.plur) {
    const plurPath = process.env.PLUR_PATH || join(homedir(), '.plur')
    servers.plur = { command: 'npx', args: ['-y', '@plur-ai/mcp'], env: { PLUR_PATH: plurPath } }
    mcpChanged = true
  }
  mcp.servers = servers
  ;(cfg as any).mcp = mcp

  return {
    cfg,
    anyChanged: enableChanged || slotChanged || allowChanged || mcpChanged || hooksChanged,
    enableChanged,
    enableAlready,
    slotChanged,
    slotAlready,
  }
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

export type SetupStep =
  | 'package_present'
  | 'plugin_discovered'
  | 'plugin_enabled'
  | 'slot_selected'
  | 'reload_required'
  | 'runtime_registered'
  | 'telemetry_optin'
export type SetupStatus = 'ok' | 'skip' | 'fail' | 'pending'
export type SetupReport = {
  path: string
  steps: { step: SetupStep; status: SetupStatus; detail?: string }[]
  fallbackBlock?: string
}

function discoveryStep(): { step: SetupStep; status: SetupStatus; detail?: string } {
  const extPath = resolveExtensionPath()
  if (existsSync(extPath)) {
    return { step: 'plugin_discovered', status: 'ok', detail: extPath }
  }
  return {
    step: 'plugin_discovered',
    status: 'fail',
    detail: `extensions dir missing: ${extPath} — run \`openclaw plugins install @plur-ai/claw\``,
  }
}

export function runSetup(opts: { configPath?: string } = {}): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()
  const report: SetupReport = {
    path,
    steps: [{ step: 'package_present', status: 'ok' }, discoveryStep()],
  }

  const tailPending = () => {
    report.steps.push({
      step: 'reload_required',
      status: 'pending',
      detail: 'restart the OpenClaw gateway so the plugin loader re-reads config',
    })
    report.steps.push({
      step: 'runtime_registered',
      status: 'pending',
      detail: 'automatic verification not yet implemented (tracked in #39)',
    })
  }

  if (!existsSync(path)) {
    report.steps.push({ step: 'plugin_enabled', status: 'fail', detail: `config file not found: ${path}` })
    report.steps.push({ step: 'slot_selected', status: 'fail', detail: 'config file missing' })
    report.fallbackBlock = canonicalBlock()
    tailPending()
    return report
  }

  const readRes = readConfig(path)
  if (!readRes.ok) {
    report.steps.push({ step: 'plugin_enabled', status: 'fail', detail: readRes.reason })
    report.steps.push({ step: 'slot_selected', status: 'fail', detail: 'config unreadable' })
    report.fallbackBlock = canonicalBlock()
    tailPending()
    return report
  }

  const merged = mergeEnable(readRes.data)
  if (!merged.anyChanged) {
    report.steps.push({
      step: 'plugin_enabled',
      status: merged.enableAlready ? 'skip' : 'ok',
      detail: merged.enableAlready ? 'already enabled' : undefined,
    })
    report.steps.push({
      step: 'slot_selected',
      status: merged.slotAlready ? 'skip' : 'ok',
      detail: merged.slotAlready ? `already set to ${PLUGIN_ID}` : undefined,
    })
    tailPending()
    return report
  }

  const w = writeConfig(path, merged.cfg)
  if (!w.ok) {
    report.steps.push({ step: 'plugin_enabled', status: 'fail', detail: w.reason })
    report.steps.push({ step: 'slot_selected', status: 'fail', detail: 'write failed' })
    report.fallbackBlock = canonicalBlock()
    tailPending()
    return report
  }

  report.steps.push({
    step: 'plugin_enabled',
    status: merged.enableChanged ? 'ok' : 'skip',
    detail: merged.enableChanged ? undefined : 'already enabled',
  })
  report.steps.push({
    step: 'slot_selected',
    status: merged.slotChanged ? 'ok' : 'skip',
    detail: merged.slotChanged ? undefined : `already set to ${PLUGIN_ID}`,
  })
  tailPending()
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

export function runDoctor(
  opts: { configPath?: string; env?: NodeJS.ProcessEnv; telemetryConfigPath?: string } = {},
): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()
  const report: SetupReport = {
    path,
    steps: [{ step: 'package_present', status: 'ok' }, discoveryStep()],
  }

  const tailPending = () => {
    report.steps.push({
      step: 'reload_required',
      status: 'pending',
      detail: 'cannot verify OpenClaw gateway reload state from here',
    })
    report.steps.push({
      step: 'runtime_registered',
      status: 'pending',
      detail: 'automatic verification not yet implemented (tracked in #39)',
    })
    report.steps.push(telemetryStep(opts))
  }

  if (!existsSync(path)) {
    report.steps.push({
      step: 'plugin_enabled',
      status: 'fail',
      detail: `config file not found: ${path} — run \`npx @plur-ai/claw setup\``,
    })
    report.steps.push({ step: 'slot_selected', status: 'fail', detail: 'config file missing' })
    tailPending()
    return report
  }

  const readRes = readConfig(path)
  if (!readRes.ok) {
    report.steps.push({ step: 'plugin_enabled', status: 'fail', detail: readRes.reason })
    report.steps.push({ step: 'slot_selected', status: 'fail', detail: 'config unreadable' })
    tailPending()
    return report
  }

  const cfg = readRes.data
  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {}
  const entry = entries[PLUGIN_ID]
  if (!entry) {
    report.steps.push({
      step: 'plugin_enabled',
      status: 'fail',
      detail: `no entry for ${PLUGIN_ID} in plugins.entries — run \`npx @plur-ai/claw setup\``,
    })
  } else if (entry.enabled !== true) {
    report.steps.push({
      step: 'plugin_enabled',
      status: 'fail',
      detail: `plugins.entries.${PLUGIN_ID}.enabled is not true`,
    })
  } else {
    report.steps.push({ step: 'plugin_enabled', status: 'ok' })
  }

  const slots =
    (plugins as any).slots && typeof (plugins as any).slots === 'object' ? (plugins as any).slots : {}
  if (slots.memory === PLUGIN_ID) {
    report.steps.push({ step: 'slot_selected', status: 'ok', detail: `memory → ${PLUGIN_ID}` })
  } else if (!slots.memory) {
    report.steps.push({
      step: 'slot_selected',
      status: 'fail',
      detail: 'plugins.slots.memory not set — run `npx @plur-ai/claw setup`',
    })
  } else {
    report.steps.push({
      step: 'slot_selected',
      status: 'fail',
      detail: `plugins.slots.memory is ${slots.memory}, expected ${PLUGIN_ID}`,
    })
  }

  tailPending()
  return report
}

function telemetryStep(opts: { env?: NodeJS.ProcessEnv; telemetryConfigPath?: string }): {
  step: SetupStep
  status: SetupStatus
  detail?: string
} {
  const r = resolveTelemetry({ env: opts.env, configPath: opts.telemetryConfigPath })
  const sourceLabel =
    r.source === 'env' ? 'PLUR_TELEMETRY env' : r.source === 'config' ? r.configPath : 'default (off)'
  if (r.state === 'on') return { step: 'telemetry_optin', status: 'ok', detail: `on — ${sourceLabel}` }
  return { step: 'telemetry_optin', status: 'skip', detail: `off — ${sourceLabel}` }
}

export function runDoctorCli(): number {
  const report = runDoctor()
  process.stdout.write(formatReport(report) + '\n')
  const failed = report.steps.some((s) => s.status === 'fail')
  return failed ? 1 : 0
}

export function runRepair(opts: { configPath?: string } = {}): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()

  // Diagnose first — repair only acts on steps doctor reports as failing.
  const pre = runDoctor({ configPath: path })
  const enableFailed = pre.steps.find((s) => s.step === 'plugin_enabled')!.status === 'fail'
  const slotFailed = pre.steps.find((s) => s.step === 'slot_selected')!.status === 'fail'

  // Also check if hooks.allowConversationAccess is missing — without it the
  // learning hook is silently blocked by OpenClaw (issue #51).
  let hooksMissing = false
  if (existsSync(path)) {
    const peek = readConfig(path)
    if (peek.ok) {
      const entry = peek.data.plugins?.entries?.[PLUGIN_ID]
      hooksMissing = !entry?.hooks?.allowConversationAccess
    }
  }

  if (!enableFailed && !slotFailed && !hooksMissing) return pre

  // Slot conflicts (memory slot taken by a different plugin) are preserved — repair
  // does not overturn a human judgment call on which plugin owns the memory slot.
  let cfg: OpenclawConfig = {}
  if (existsSync(path)) {
    const readRes = readConfig(path)
    if (!readRes.ok) return pre
    cfg = readRes.data
  }

  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {}
  let changed = false

  if (enableFailed) {
    const existing = entries[PLUGIN_ID]
    if (!existing) {
      entries[PLUGIN_ID] = {
        enabled: true,
        config: { auto_learn: true, auto_capture: true, injection_budget: 2000 },
        hooks: { allowConversationAccess: true },
      }
      changed = true
    } else if (existing.enabled !== true) {
      entries[PLUGIN_ID] = { ...existing, enabled: true, hooks: { ...(existing as any)?.hooks, allowConversationAccess: true } }
      changed = true
    }
    plugins.entries = entries
  }

  // Ensure hooks.allowConversationAccess is set even if plugin was already enabled
  const currentEntry = entries[PLUGIN_ID]
  if (currentEntry && !(currentEntry as any)?.hooks?.allowConversationAccess) {
    ;(currentEntry as any).hooks = { ...((currentEntry as any)?.hooks ?? {}), allowConversationAccess: true }
    changed = true
  }

  const slots =
    (plugins as any).slots && typeof (plugins as any).slots === 'object'
      ? (plugins as any).slots
      : {}
  if (slotFailed && !slots.memory) {
    slots.memory = PLUGIN_ID
    ;(plugins as any).slots = slots
    changed = true
  }

  cfg.plugins = plugins

  if (changed) {
    const w = writeConfig(path, cfg)
    if (!w.ok) return pre
  }

  return runDoctor({ configPath: path })
}

export function runRepairCli(): number {
  const report = runRepair()
  const rendered = formatReport(report).replace(/^PLUR setup →/, 'PLUR repair →')
  process.stdout.write(rendered + '\n')
  const failed = report.steps.some((s) => s.status === 'fail')
  return failed ? 1 : 0
}

// Auto-run when executed directly (postinstall)
const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('setup.js')
if (isMain) {
  process.exit(runSetupCli())
}
