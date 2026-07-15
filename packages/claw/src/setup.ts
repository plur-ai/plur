import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
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
        allow: [PLUGIN_ID],
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

function mergeEnable(cfg: OpenclawConfig, openclawHome?: string): MergeResult {
  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? { ...plugins.entries }
      : {}

  // Item 1 (#51 / D-2): We intentionally do NOT prune foreign plugin entries.
  // A previous version deleted any entry whose extensions/<id> directory was
  // absent — but that directory is transiently absent during any install or
  // upgrade, so pruning silently destroyed third-party plugins' config INCLUDING
  // their API keys. The config is the user's source of truth, not a mirror of the
  // extensions dir. setup only ever adds/updates its own (plur-claw) entry; it
  // never removes anyone else's.

  const existing = entries[PLUGIN_ID]
  const enableAlready = !!(existing && existing.enabled === true)
  // Item 4 (#51 / D-4): allowConversationAccess is required for the agent_end
  // hook — without it OpenClaw silently blocks the learning hook and PLUR can
  // inject but never learn. But only SEED it when the user hasn't expressed a
  // value. Spreading `allowConversationAccess: true` after the user's hooks would
  // override an explicit `false`, re-granting a privacy permission the user
  // revoked. Preserve an explicit true OR false; add true only when absent.
  const existingHooks = ((existing as any)?.hooks ?? {}) as Record<string, unknown>
  const hooksChanged = existingHooks.allowConversationAccess === undefined
  const nextHooks = hooksChanged
    ? { ...existingHooks, allowConversationAccess: true }
    : { ...existingHooks }
  const nextEntry = {
    ...(existing ?? {}),
    enabled: true,
    config: (existing as any)?.config ?? { auto_learn: true, auto_capture: true, injection_budget: 2000 },
    hooks: nextHooks,
  }
  const enableChanged = !existing || existing.enabled !== true
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

  // Item 2 (#51 / D-3): In OpenClaw an ABSENT plugins.allow means "allow ALL
  // plugins". Seeding it with a one-element ['plur-claw'] list would silently
  // GATE OFF every other plugin the user has installed. So when allow is absent
  // (or null), leave it absent — do not create it.
  //
  // When plugins.allow is an empty array [], the user explicitly cleared it —
  // honour that untouched (doctor surfaces a warning separately).
  //
  // When plugins.allow is a non-empty array, the user is explicitly gating; append
  // plur-claw if missing so it isn't excluded.
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
    // Atomic write: serialize to a unique temp file then rename over the target.
    // A crash mid-write can never leave the user's openclaw.json truncated or
    // corrupt (mirrors atomicWriteJson in telemetry-counters.ts).
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
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
  | 'allow_gated'
  | 'orphaned_entries'
  | 'reload_required'
  | 'runtime_registered'
  | 'telemetry_optin'
export type SetupStatus = 'ok' | 'skip' | 'fail' | 'pending' | 'warn'
export type SetupReport = {
  path: string
  steps: { step: SetupStep; status: SetupStatus; detail?: string }[]
  fallbackBlock?: string
}

function discoveryStep(openclawHome?: string): { step: SetupStep; status: SetupStatus; detail?: string } {
  const home = openclawHome ?? resolveOpenclawHome()
  const extPath = join(home, 'extensions', PLUGIN_ID)
  if (existsSync(extPath)) {
    return { step: 'plugin_discovered', status: 'ok', detail: extPath }
  }
  return {
    step: 'plugin_discovered',
    status: 'fail',
    detail: `extensions dir missing: ${extPath} — run \`openclaw plugins install @plur-ai/claw\``,
  }
}

function runtimeRegistrationStep(openclawHome?: string): { step: SetupStep; status: SetupStatus; detail?: string } {
  const home = openclawHome ?? resolveOpenclawHome()
  const entrypoint = join(home, 'extensions', PLUGIN_ID, 'dist', 'index.js')
  if (existsSync(entrypoint)) {
    return { step: 'runtime_registered', status: 'ok', detail: 'plugin entrypoint verified' }
  }
  return {
    step: 'runtime_registered',
    status: 'pending',
    detail: 'run `openclaw plugins install @plur-ai/claw` then restart OpenClaw',
  }
}

// Non-destructive replacement for the removed #51 / D-2 prune. That prune
// DELETED any plugins.entries[<id>] whose extensions/<id> directory was absent —
// destroying third-party config INCLUDING embedded API keys. Its fatal flaw was
// the false positive: extensions/<id> is transiently absent during any
// install/upgrade, and the prune ran unattended from postinstall (via
// mergeEnable), i.e. exactly in that window. #566 removed it entirely, leaving no
// detection at all — genuinely-orphaned entries (and their credentials) now
// linger forever (#583).
//
// This restores DETECTION without the danger, by inverting all three risk axes:
//   1. NON-DESTRUCTIVE: it only warns. It never deletes or mutates config.
//   2. USER-INVOKED, NOT AUTOMATIC: it runs only inside runDoctor (the `doctor`
//      command a user runs deliberately), never from the postinstall setup path
//      that fires mid-install. This structurally avoids the prune's timing bug.
//   3. CONSERVATIVE GATE + HONEST MESSAGE: if the extensions/ dir itself is
//      absent we cannot distinguish "no plugins installed" from "tree not yet
//      populated mid-install", so we stay silent (skip). When we do warn, the
//      message states plainly that it is advisory, may be a false positive during
//      an in-progress upgrade, and that the user — not claw — must remove anything.
// It intentionally includes plur-claw's OWN entry (unlike the old prune, which
// skipped it): a lingering plur-claw entry with no extension is equally orphaned.
function orphanedEntriesStep(
  cfg: OpenclawConfig,
  configPath: string,
  openclawHome?: string,
): { step: SetupStep; status: SetupStatus; detail?: string } {
  const plugins = (cfg.plugins && typeof cfg.plugins === 'object' && !Array.isArray(cfg.plugins)
    ? cfg.plugins
    : {}) as NonNullable<OpenclawConfig['plugins']>
  const entries =
    plugins.entries && typeof plugins.entries === 'object' && !Array.isArray(plugins.entries)
      ? plugins.entries
      : {}

  const home = openclawHome ?? resolveOpenclawHome()
  const extensionsDir = join(home, 'extensions')

  // Conservative gate: an absent extensions/ dir is ambiguous (fresh install with
  // no plugins yet, OR a partially-populated tree mid-install). Either way we
  // cannot reliably tell orphaned from transiently-absent, so say nothing.
  if (!existsSync(extensionsDir)) {
    return {
      step: 'orphaned_entries',
      status: 'skip',
      detail: `extensions dir absent (${extensionsDir}) — cannot assess orphaned entries`,
    }
  }

  const orphaned = Object.keys(entries).filter((id) => !existsSync(join(extensionsDir, id)))
  if (orphaned.length === 0) {
    return { step: 'orphaned_entries', status: 'ok', detail: 'every plugins.entries id has a backing extension' }
  }

  const noun = orphaned.length === 1 ? 'entry has' : 'entries have'
  return {
    step: 'orphaned_entries',
    status: 'warn',
    detail:
      `${orphaned.length} plugins.entries ${noun} no backing extension: ${orphaned.join(', ')}. ` +
      `ADVISORY ONLY — nothing was changed. This may be a genuinely-orphaned entry (the plugin was ` +
      `uninstalled but its config, including any embedded API keys, still lingers), OR a false positive if ` +
      `the extension is transiently absent during an in-progress install/upgrade. claw never deletes foreign ` +
      `config; if you have confirmed the plugin is uninstalled, remove the entry by hand from ${configPath}.`,
  }
}

export function runSetup(opts: { configPath?: string; openclawHome?: string } = {}): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()
  const report: SetupReport = {
    path,
    steps: [{ step: 'package_present', status: 'ok' }, discoveryStep(opts.openclawHome)],
  }

  const tailPending = () => {
    report.steps.push({
      step: 'reload_required',
      status: 'pending',
      detail: 'restart the OpenClaw gateway so the plugin loader re-reads config',
    })
    report.steps.push(runtimeRegistrationStep(opts.openclawHome))
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

  const merged = mergeEnable(readRes.data, opts.openclawHome)
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
    s === 'ok' ? '✓' : s === 'skip' ? '·' : s === 'pending' ? '…' : s === 'warn' ? '⚠' : '✗'
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
  opts: { configPath?: string; openclawHome?: string; env?: NodeJS.ProcessEnv; telemetryConfigPath?: string } = {},
): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()
  const report: SetupReport = {
    path,
    steps: [{ step: 'package_present', status: 'ok' }, discoveryStep(opts.openclawHome)],
  }

  const tailPending = () => {
    report.steps.push({
      step: 'reload_required',
      status: 'pending',
      detail: 'cannot verify OpenClaw gateway reload state from here',
    })
    report.steps.push(runtimeRegistrationStep(opts.openclawHome))
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

  // Item 2 (Option B) + Item 4: Check plugins.allow.
  // An empty allow array means OpenClaw gates ALL plugins — including plur-claw —
  // which causes the "no active memory plugin" false negative (#51 item 4).
  // Surface this as a warning so users know to re-run setup or add plur-claw.
  const allowList = (plugins as any).allow
  if (Array.isArray(allowList) && allowList.length === 0) {
    report.steps.push({
      step: 'allow_gated',
      status: 'fail',
      detail: `plugins.allow is empty — all plugins are gated; run \`npx @plur-ai/claw setup\` to add ${PLUGIN_ID}`,
    })
  } else if (Array.isArray(allowList) && allowList.length > 0 && !allowList.includes(PLUGIN_ID)) {
    report.steps.push({
      step: 'allow_gated',
      status: 'fail',
      detail: `${PLUGIN_ID} is not in plugins.allow (${allowList.join(', ')}) — run \`npx @plur-ai/claw setup\` to add it`,
    })
  } else {
    // allow is undefined (no gating) or plur-claw is already listed — ok.
    report.steps.push({ step: 'allow_gated', status: 'ok' })
  }

  // #583: non-destructively flag config entries with no backing extension.
  report.steps.push(orphanedEntriesStep(cfg, path, opts.openclawHome))

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

export function runRepair(opts: { configPath?: string; openclawHome?: string } = {}): SetupReport {
  const path = opts.configPath ?? resolveConfigPath()

  // Diagnose first — repair only acts on steps doctor reports as failing.
  const pre = runDoctor({ configPath: path, openclawHome: opts.openclawHome })
  const enableFailed = pre.steps.find((s) => s.step === 'plugin_enabled')!.status === 'fail'
  const slotFailed = pre.steps.find((s) => s.step === 'slot_selected')!.status === 'fail'

  // Also check if hooks.allowConversationAccess is missing — without it the
  // learning hook is silently blocked by OpenClaw (issue #51). Only "missing"
  // means undefined: an explicit `false` is the user's choice and repair must
  // preserve it (#51 / D-4), never re-grant it.
  let hooksMissing = false
  if (existsSync(path)) {
    const peek = readConfig(path)
    if (peek.ok) {
      const entry = peek.data.plugins?.entries?.[PLUGIN_ID]
      hooksMissing = entry?.hooks?.allowConversationAccess === undefined
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
      const existingHooks = ((existing as any)?.hooks ?? {}) as Record<string, unknown>
      const hooks =
        existingHooks.allowConversationAccess === undefined
          ? { ...existingHooks, allowConversationAccess: true }
          : { ...existingHooks }
      entries[PLUGIN_ID] = { ...existing, enabled: true, hooks }
      changed = true
    }
    plugins.entries = entries
  }

  // Ensure hooks.allowConversationAccess is set even if plugin was already
  // enabled — but only when it is ABSENT. An explicit `false` is preserved
  // (#51 / D-4); repair must never re-grant a permission the user revoked.
  const currentEntry = entries[PLUGIN_ID]
  if (currentEntry && (currentEntry as any)?.hooks?.allowConversationAccess === undefined) {
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

  return runDoctor({ configPath: path, openclawHome: opts.openclawHome })
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
