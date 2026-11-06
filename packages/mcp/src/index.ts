#!/usr/bin/env node
export {}

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'

import { VERSION } from './version.js'
import { buildClaudeHooks, isPlurHookSpec, type HookEntry } from '@plur-ai/gateway/harness'

const HELP = `plur-mcp v${VERSION} — persistent memory for AI agents

Usage:
  plur-mcp                           Start the MCP server (stdio transport)
  plur-mcp init                      Set up PLUR: storage + MCP config + hooks + CLAUDE.md
  plur-mcp packs install <path>      Install a knowledge pack from a local directory
  plur-mcp packs list                List installed knowledge packs
  plur-mcp packs uninstall <name>    Uninstall a knowledge pack by name
  plur-mcp --help                    Show this help message
  plur-mcp --version                 Show version

Environment:
  PLUR_PATH             Storage location (default: ~/.plur/)

Quick start:
  npx @plur-ai/mcp init

Docs: https://plur.ai · https://github.com/plur-ai/plur
`

// --- Constants (must be before any await that uses them) ---

// The local MCP shim `plur init` installs (~/.plur/bin/plur-mcp, which runs
// the installed @plur-ai/mcp with node). Preferred when present: a global
// upgrade replaces the package at the same path, so the entry follows it
// without a re-pin. Not on Windows, where current Node cannot spawn the
// `.cmd` shim.
const MCP_SHIM = join(homedir(), '.plur', 'bin', 'plur-mcp')

// Otherwise npx, pinned to THIS build's version, never @latest: an @latest
// entry makes npx rewrite its cached native binaries on every publish, and
// macOS SIGKILLs (CODESIGNING Invalid Page) any process that pages one in
// mid-rewrite. Upgrades re-run init, which re-pins.
function mcpServerConfig(): { command: string; args: string[] } {
  if (platform() !== 'win32' && existsSync(MCP_SHIM)) return { command: MCP_SHIM, args: [] }
  return { command: 'npx', args: ['-y', `@plur-ai/mcp@${VERSION}`] }
}

// --- Pack-upgrade helpers ---

/**
 * Compare two semver strings: negative if a < b, 0 if equal, positive if a > b.
 * Missing patch counts as 0; prerelease/build suffixes are stripped (so "1.0.0-rc1"
 * equals "1.0.0"). Non-numeric segments parse as 0 rather than throwing. Calendar
 * versions would compare as far-future and never upgrade — packs ship semver.
 */
export function compareSemver(a: string, b: string): number {
  const stripPrerelease = (v: string): string => v.split('-')[0].split('+')[0]
  const stripV = (v: string): string => v.replace(/^v/i, '')
  const parse = (v: string): number[] =>
    stripV(stripPrerelease(v))
      .split('.')
      .map(n => {
        const parsed = parseInt(n, 10)
        return Number.isNaN(parsed) ? 0 : parsed
      })
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (ai !== bi) return ai - bi
  }
  return 0
}

/**
 * Extract the `version` field from a pack's SKILL.md frontmatter without
 * loading the whole pack. Returns null when SKILL.md is missing, the
 * frontmatter has no version, or the version is nested under another key.
 *
 * Accepts both quoted (`version: "1.0.0"`) and unquoted (`version: 1.0.0`)
 * forms. Rejects nested keys (`metadata:\n  version: 1.0.0`) — the regex
 * anchors to start-of-line so a leading space breaks the match.
 */
export function extractManifestVersion(skillMdPath: string): string | null {
  try {
    const content = readFileSync(skillMdPath, 'utf8')
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/m)
    if (!fmMatch) return null
    const versionMatch = fmMatch[1].match(/^version:\s*"?([^"\n]+)"?\s*$/m)
    return versionMatch ? versionMatch[1].trim() : null
  } catch {
    return null
  }
}

// Prefer local hook shim if available (installed by `plur init`).
// Fall back to npx for first-time users who haven't run `plur init` yet,
// pinned like the MCP entry: a bare `npx @plur-ai/cli` resolves latest on
// every publish and races the npx cache rewrite. The CLI is released in
// lockstep with this package, so the same version exists.
const _shimName = platform() === 'win32' ? 'plur-hook.cmd' : 'plur-hook'
const _shimCandidate = join(homedir(), '.plur', 'bin', _shimName)
const CLI = existsSync(_shimCandidate) ? _shimCandidate : `npx -y @plur-ai/cli@${VERSION}`

/** Hook set for `plur-mcp init`: the shared set `plur init` installs too. */
export function buildPlurHooks(cli: string): Record<string, HookEntry[]> {
  return buildClaudeHooks(cli)
}

const PLUR_HOOKS = buildPlurHooks(CLI)

// --- Types ---

interface McpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

export interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

export type { HookEntry }

/**
 * Closes the CLAUDE.md section. Same as PLUR_INSTRUCTIONS_MARKER in
 * packages/cli/src/commands/init.ts — when the section text changes, run
 * scripts/extract-plur-section-history.mjs first, then bump both together.
 */
const PLUR_INSTRUCTIONS_MARKER = '<!-- plur-instructions-v4 -->'

/** The memory line — verbatim the same rule as `plur init` and the server instructions. */
const MEMORY_FOOTER_RULE =
  'End every reply with one short line: ' +
  '`Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…` ' +
  '(recalled as a count; used and written as ids only, no statements), or `Memory — none`. ' +
  'Only count/list ids you actually saw this turn; never invent an id. ' +
  'Give details only if the user asks.'

const CLAUDE_MD_SECTION = `## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (\`~/.plur/\`), available in every project. You do NOT need per-project installation. Multi-project scoping uses \`domain\` and \`scope\` fields on engrams, not separate stores.

Hooks inject engrams automatically on every first message — you do not need to call \`plur_session_start\` manually (though you can for explicit session tracking).

### Session Workflow

1. **Automatic**: Hooks inject relevant engrams on first message — no action needed
2. **Learn**: When corrected or discovering something new, call \`plur_learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur_recall\` — check memory first
4. **Feedback**: Rate injected engrams with \`plur_feedback\` (positive/negative) — trains relevance
5. **End**: Call \`plur_session_end\` with summary + engram_suggestions — a SessionEnd hook auto-closes the lifecycle if you forget, but calling it yourself captures higher-quality learnings

Do not ask permission to use these tools — they are your memory system.

### Memory line on every reply

${MEMORY_FOOTER_RULE}

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call \`plur_learn\` immediately — before continuing the task
2. Call \`plur_feedback\` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach

${PLUR_INSTRUCTIONS_MARKER}
`

// --- Functions ---

function defaultClaudeMdPath(): string {
  // Check project CLAUDE.md first, then global
  const projectClaudeMd = join(process.cwd(), 'CLAUDE.md')
  const globalClaudeMd = join(homedir(), 'CLAUDE.md')
  return existsSync(projectClaudeMd) ? projectClaudeMd : existsSync(globalClaudeMd) ? globalClaudeMd : projectClaudeMd
}

/**
 * Write the PLUR section into CLAUDE.md with core's `upsertInstructionSection`
 * — the same logic as `plur init`: only a section PLUR shipped is replaced,
 * one the user wrote or edited is kept and the new one added beside it, and a
 * timestamped backup precedes any change to an existing file.
 */
export async function installClaudeMd(claudeMdPath: string = defaultClaudeMdPath()): Promise<string> {
  // Loaded lazily, like every other core use in this entry point, so
  // `plur-mcp --help` / `--version` do not pay for loading core.
  const { upsertInstructionSection, writeWithBackup, SHIPPED_PLUR_SECTIONS } = await import('@plur-ai/core')
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : null
  const r = upsertInstructionSection(existing, {
    section: CLAUDE_MD_SECTION, title: '# CLAUDE.md', heading: '## PLUR Memory',
    marker: PLUR_INSTRUCTIONS_MARKER, shipped: SHIPPED_PLUR_SECTIONS,
  })
  if (r.status === 'skipped') return `not written to ${claudeMdPath}: ${r.skipReason}`
  let backup: string | null
  try {
    backup = r.status === 'already' ? null : writeWithBackup(claudeMdPath, r.content, existing)
  } catch (err) {
    // A write PLUR declined (a dangling symlink, an edit made meanwhile): say
    // so and let the rest of the install carry on.
    if ((err as { code?: string }).code === 'PLUR_REFUSED') return `not written to ${claudeMdPath}: ${(err as Error).message}`
    throw err
  }
  const head = {
    created: `created ${claudeMdPath}`,
    added: `added to ${claudeMdPath}`,
    upgraded: `upgraded in ${claudeMdPath}`,
    already: `already in ${claudeMdPath}`,
  }[r.status]
  const notes: string[] = []
  if (backup) notes.push(`backup: ${backup}`)
  if (r.keptSections > 0) {
    notes.push(
      `left ${r.keptSections} older "## PLUR Memory" section${r.keptSections === 1 ? '' : 's'} untouched because ` +
      `${r.keptSections === 1 ? 'it has' : 'they have'} text PLUR did not write — remove it yourself once you have kept what you need`,
    )
  }
  if (r.closedOpenBlock) {
    notes.push(`closed the ${r.closedOpenBlock === 'fence' ? 'code block' : 'HTML comment'} left open at the end of the file before adding the section`)
  }
  return notes.length ? `${head} (${notes.join('; ')})` : head
}


/**
 * Read a config file this function intends to WRITE BACK. Same rule as
 * @plur-ai/cli's readConfigForWrite (this package cannot import the CLI): a
 * file that exists but does not parse to a JSON object is the user's
 * damaged-but-recoverable data — reading it as {} and writing the merge back
 * would destroy every other entry they had.
 */
function readJsonObjectForWrite(path: string): { data: Record<string, unknown>; ok: boolean } {
  if (!existsSync(path)) return { data: {}, ok: true }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, ok: true }
    }
  } catch { /* fall through */ }
  return { data: {}, ok: false }
}

/**
 * Move the npx entry THIS command's releases wrote to what it writes today:
 * the @latest/bare shape (the npx cache-rewrite race described at
 * mcpServerConfig), and a pin older than or equal to this build, so a global
 * upgrade reaches the config on the next init. A newer pin, another package or
 * a custom command is the user's and is kept. Other fields are kept. Returns
 * the status line, or null when nothing changed.
 */
function healOwnNpxEntry(servers: Record<string, unknown>): string | null {
  const existing = servers.plur as { command?: string; args?: string[] } | undefined
  if (!existing || typeof existing !== 'object') return null
  if (existing.command !== 'npx') return null
  // Only the exact argv this command writes, `npx [-y|--yes] <spec>`: an
  // extra argument, `-p <pkg> <bin>` or `--package` makes it a custom entry
  // whose arguments a rewrite would drop.
  const args = existing.args ?? []
  const spec = args.length === 1 ? args[0]
    : args.length === 2 && (args[0] === '-y' || args[0] === '--yes') ? args[1] : ''
  const m = /^@plur-ai\/mcp(?:@(.+))?$/.exec(spec)
  if (!m) return null
  const tag = m[1]
  const racey = tag === undefined || tag === 'latest'
  const oldPin = !racey && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) && compareSemver(tag, VERSION) <= 0 ? tag : null
  if (!racey && !oldPin) return null
  const healed = { ...existing, ...mcpServerConfig() }
  if (JSON.stringify(healed) === JSON.stringify(existing)) return null
  servers.plur = healed
  if (racey) return 'upgraded stale npx entry'
  return healed.command === 'npx' ? `updated the npx pin ${oldPin} → ${VERSION}` : `replaced the pinned npx entry (${oldPin}) with the installed MCP server`
}

/**
 * Register the server for Claude Code at user scope, in `~/.claude.json` — the
 * file `claude mcp add --scope user` writes and the only user-level place
 * Claude Code reads MCP servers (it never reads `~/.claude/mcp.json`). Same
 * rules as `plur init`: an old `~/.claude/mcp.json` entry is
 * moved (env and extra keys kept) unless `~/.claude.json` already has one,
 * which wins; every change to an existing file is preceded by a backup
 * (writeWithBackup, which also refuses a file edited meanwhile); a run with
 * nothing to change writes nothing; an unparseable `~/.claude.json` is
 * refused and neither file is touched.
 */
async function installClaudeUserMcp(): Promise<{ ok: boolean; status: string }> {
  const { writeWithBackup, registerClaudeUserMcp } = await import('@plur-ai/core')
  const legacyPath = join(homedir(), '.claude', 'mcp.json')
  const legacyRaw = existsSync(legacyPath) ? readFileSync(legacyPath, 'utf8') : null
  const legacy = readJsonObjectForWrite(legacyPath)
  const oldServers = legacy.ok ? legacy.data.mcpServers : undefined
  const oldEntry = oldServers && typeof oldServers === 'object' && !Array.isArray(oldServers)
    ? (oldServers as Record<string, unknown>).plur
    : undefined

  // The same implementation `plur init` uses.
  const r = registerClaudeUserMcp({
    userPath: join(homedir(), '.claude.json'),
    entry: () => mcpServerConfig(),
    heal: (config) => healOwnNpxEntry(config.mcpServers as Record<string, unknown>),
    legacyEntry: oldEntry,
    legacyPath,
    rerunCommand: 'plur-mcp init',
  })
  if (!r.ok || oldEntry === undefined) return { ok: r.ok, status: r.message }

  let status = r.message
  const next: Record<string, unknown> = { ...legacy.data }
  const rest = { ...(oldServers as Record<string, unknown>) }
  delete rest.plur
  if (Object.keys(rest).length > 0) next.mcpServers = rest
  else delete next.mcpServers
  try {
    const backup = writeWithBackup(legacyPath, JSON.stringify(next, null, 2) + '\n', legacyRaw)
    status += `; removed the unused entry from ${legacyPath}${backup ? ` (backup: ${backup})` : ''}`
  } catch (err) {
    status += `; could not remove the unused entry from ${legacyPath} (${(err as Error).message}) — Claude Code ignores it, remove it by hand`
  }
  return { ok: true, status }
}

/**
 * Is this one hook PLUR's? The same spec-level check `plur init` uses
 * (isPlurHookSpec): a shell string is matched by isPlurHookCommand, and on
 * Windows the exec form `plur init` writes (node + the recorded CLI js entry
 * + hook-*, or cmd.exe /c + npx) counts too, so `plur-mcp init` after
 * `plur init` does not add a second set. Claude Code also has
 * `type: "prompt"` and `type: "agent"` hooks, which carry no `command`. They
 * are never PLUR's and must not make init throw.
 */
function isPlurCommandHook(h: { command?: unknown; args?: unknown }): boolean {
  return typeof h.command === 'string' && isPlurHookSpec({ command: h.command, args: h.args })
}

function isPlurHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(isPlurCommandHook)
}

/** Same normalisation as isPlurHookCommand: backslashes to `/`, any case. */
const REHYDRATE = /(?:^|\s)hook-inject\s+--rehydrate(?:\s|$)/

/** The whole launch line: the command, then the exec-form `args` if any. */
function launchLine(h: { command?: unknown; args?: unknown }): string {
  const args = Array.isArray(h.args) ? h.args.filter((a): a is string => typeof a === 'string') : []
  return [h.command as string, ...args].join(' ')
}

function isPlurRehydrateHook(h: { command?: unknown; args?: unknown }): boolean {
  return isPlurCommandHook(h) &&
    REHYDRATE.test(launchLine(h).replace(/\\/g, '/').toLowerCase())
}

function isPlurRehydrate(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(isPlurRehydrateHook)
}

/** A PLUR hook running `subcommand` (same normalisation as isPlurHookCommand). */
function hasPlurSubcommand(entries: HookEntry[] | undefined, subcommand: string): boolean {
  const re = new RegExp(`(?:^|\\s)${subcommand}(?:\\s|$)`)
  return (entries ?? []).some(e => (e.hooks ?? []).some(h =>
    isPlurCommandHook(h) && re.test((h.command as string).replace(/\\/g, '/').toLowerCase())))
}

const isResumeEntry = (e: HookEntry): boolean => e.matcher === 'resume'

/**
 * Remove PLUR's hooks from a list of entries, one hook at a time. An entry
 * is dropped only when nothing is left in it; an entry without a PLUR hook
 * comes back as the same object. A user's hook is never removed.
 */
function stripPlurHooks(entries: HookEntry[]): HookEntry[] {
  const kept: HookEntry[] = []
  for (const entry of entries) {
    if (!isPlurHook(entry)) {
      kept.push(entry)
      continue
    }
    const rest = entry.hooks.filter(h => !isPlurCommandHook(h))
    if (rest.length > 0) kept.push({ ...entry, hooks: rest })
  }
  return kept
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Where a settings file's `hooks` departs from the shape Claude Code reads
 * (event → list of entries → `hooks` list of hook objects), as the first
 * offending path, or null when it can be merged. A hand-edited file that
 * breaks the structure made init throw midway (#1352). A malformed section is
 * refused: installHooks skips the step, names the path, and never writes the
 * file. Absent or null levels are fine (nothing to merge into), and a hook's
 * own fields are not checked: a command-less hook is a prompt/agent hook,
 * which isPlurCommandHook already handles (#1279).
 */
export function hooksShapeProblem(hooks: unknown): string | null {
  if (hooks === undefined || hooks === null) return null
  if (!isObject(hooks)) return '`hooks` is not an object'
  for (const [event, entries] of Object.entries(hooks)) {
    if (entries === null) continue
    if (!Array.isArray(entries)) return `hooks.${event} is not a list`
    for (const [i, entry] of entries.entries()) {
      if (!isObject(entry)) return `hooks.${event}[${i}] is not an object`
      if (entry.hooks === undefined) continue
      if (!Array.isArray(entry.hooks)) return `hooks.${event}[${i}].hooks is not a list`
      const bad = entry.hooks.findIndex(h => !isObject(h))
      if (bad !== -1) return `hooks.${event}[${i}].hooks[${bad}] is not an object`
    }
  }
  return null
}

/**
 * Merge PLUR hooks into Claude Code settings (only I/O: reading plur-hook.meta.json).
 * Expects a `hooks` section hooksShapeProblem accepts.
 * A hook is PLUR's only when isPlurHookSpec says so.
 * - No PLUR hook: append the full set ('installed').
 * - PLUR hooks present: remove PLUR's PostCompact hooks (dropping emptied entries) and,
 *   if a rehydrate was among them, add SessionStart(compact) unless present ('healed').
 *   Nothing else changes, so a fuller `plur init` install is never replaced.
 * - Otherwise 'already', settings unchanged.
 * User hooks are never removed or reordered, even when sharing an entry with PLUR's.
 */
export function applyPlurHooks(
  settings: Settings,
  hooksMap: Record<string, HookEntry[]>,
): { settings: Settings; status: 'installed' | 'healed' | 'already' } {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) }
  const installed = Object.values(hooks).some(entries => (entries ?? []).some(isPlurHook))

  if (!installed) {
    for (const [event, entries] of Object.entries(hooksMap)) {
      hooks[event] = [...(hooks[event] ?? []), ...entries]
    }
    return { settings: { ...settings, hooks }, status: 'installed' }
  }

  let changed = false
  let movedRehydrate = false
  if (hooks.PostCompact?.some(isPlurHook)) {
    movedRehydrate = hooks.PostCompact.some(isPlurRehydrate)
    const kept = stripPlurHooks(hooks.PostCompact)
    if (kept.length > 0) hooks.PostCompact = kept
    else delete hooks.PostCompact
    changed = true
  }
  // Add SessionStart(compact) only in place of a PostCompact rehydrate just
  // removed from THIS file. `plur init --project` keeps the global file to
  // enforcement hooks and puts rehydrate in the project file; adding one to
  // the global file would run rehydrate twice per compaction there.
  if (movedRehydrate && !(hooks.SessionStart ?? []).some(isPlurRehydrate)) {
    hooks.SessionStart = [...(hooks.SessionStart ?? []), ...(hooksMap.SessionStart ?? []).filter(isPlurRehydrate)]
    changed = true
  }
  // SessionEnd deletes a session's folder-question nonces, so a file that
  // runs PLUR's SessionEnd also needs PLUR's SessionStart(resume), or a
  // resumed session is never asked again. Added to an install that lacks
  // it; a file without SessionEnd gets none.
  if (hasPlurSubcommand(hooks.SessionEnd, 'hook-session-end') && !hasPlurSubcommand(hooks.SessionStart, 'hook-session-resume')) {
    const resume = (hooksMap.SessionStart ?? []).filter(isResumeEntry)
    if (resume.length > 0) {
      hooks.SessionStart = [...(hooks.SessionStart ?? []), ...resume]
      changed = true
    }
  }
  return changed
    ? { settings: { ...settings, hooks }, status: 'healed' }
    : { settings, status: 'already' }
}

/**
 * Hooks go to user settings (~/.claude/settings.json), from any folder, as
 * `plur init` does: the folder map gates every hook, so a user-level hook is
 * safe everywhere, and writing to <cwd>/.claude/settings.json would put a
 * second PLUR set into a repo. plur-mcp init has no `--project`; use
 * `plur init --project` for a per-repo placement.
 */
function installHooks(): string {
  const settingsPath = join(homedir(), '.claude', 'settings.json')

  const settingsRead = readJsonObjectForWrite(settingsPath)
  if (!settingsRead.ok) {
    return `skipped — ${settingsPath} exists but is not a JSON object; writing would discard your other settings. Fix it by hand, then re-run \`plur-mcp init\``
  }
  const shapeProblem = hooksShapeProblem(settingsRead.data.hooks)
  if (shapeProblem) {
    return `skipped — in ${settingsPath}, ${shapeProblem}; Claude Code expects lists of hook objects there. Fix it by hand, then re-run \`plur-mcp init\``
  }
  const settings = settingsRead.data as Settings

  const { settings: next, status } = applyPlurHooks(settings, PLUR_HOOKS)
  if (status === 'already') return `already installed in ${settingsPath}`

  const dir = join(settingsPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n')
  return status === 'healed'
    ? `updated PLUR hooks (SessionStart compact/resume) in ${settingsPath}`
    : `installed in ${settingsPath}`
}

async function runInit() {
  const results: string[] = []

  // Step 1: Initialize storage
  const { detectPlurStorage } = await import('@plur-ai/core')
  const paths = detectPlurStorage()
  results.push(`Storage:  ${paths.root}`)

  let searchMode = 'BM25 keyword search'
  try {
    const mod = '@huggingface/' + 'transformers'
    await import(/* @vite-ignore */ mod)
    searchMode = 'hybrid (BM25 + embeddings)'
  } catch {}
  results.push(`Search:   ${searchMode}`)

  // Step 2: Write MCP config
  const mcp = await installClaudeUserMcp()
  const mcpStatus = mcp.status
  // Init did not do its main job; scripts must see it.
  if (!mcp.ok) process.exitCode = 1
  results.push(`MCP:      ${mcpStatus}`)

  // Step 3: Install Claude Code hooks
  const hooksStatus = installHooks()
  results.push(`Hooks:    ${hooksStatus}`)

  // Step 4: Add PLUR section to CLAUDE.md
  const claudeMdStatus = await installClaudeMd()
  results.push(`CLAUDE.md: ${claudeMdStatus}`)

  // Step 5: Install bundled knowledge packs.
  // Two cases: (1) pack not installed → install fresh. (2) pack installed at
  // an older version → reinstall to upgrade. We compare manifest versions
  // (semver, dotted ints) instead of just-presence so existing users running
  // `plur init` after an upgrade actually receive new content.
  const { Plur } = await import('@plur-ai/core')
  const plur = new Plur({ path: paths.root })
  const bundledPacksDir = join(fileURLToPath(import.meta.url), '..', '..', 'packs')
  let packsStatus = 'no bundled packs found'
  if (existsSync(bundledPacksDir)) {
    const installed = plur.listPacks()
    const installedByName = new Map(installed.map((p: { name: string; manifest?: { version?: string } }) => [p.name, p.manifest?.version]))
    const entries = readdirSync(bundledPacksDir).filter(e => statSync(join(bundledPacksDir, e)).isDirectory())
    const newPacks: string[] = []
    const upgradedPacks: string[] = []
    for (const entry of entries) {
      const bundledManifestPath = join(bundledPacksDir, entry, 'SKILL.md')
      const bundledVersion = existsSync(bundledManifestPath)
        ? extractManifestVersion(bundledManifestPath)
        : null
      const installedVersion = installedByName.get(entry)
      if (!installedByName.has(entry)) {
        try {
          await plur.installPack(join(bundledPacksDir, entry))
          newPacks.push(entry)
        } catch {}
      } else if (
        bundledVersion &&
        (!installedVersion || compareSemver(bundledVersion, installedVersion) > 0)
      ) {
        // Upgrade in place — installPack overwrites the pack directory and
        // re-registers integrity in the registry. The `!installedVersion`
        // case catches packs installed with a missing or unreadable manifest
        // version (older installs predating versioned manifests, or
        // hand-edited packs without a `version:` field). In that case we
        // can't do a comparison, so we upgrade unconditionally rather than
        // leave a versionless pack stale forever.
        try {
          await plur.installPack(join(bundledPacksDir, entry))
          upgradedPacks.push(
            `${entry} ${installedVersion ?? 'unknown'}→${bundledVersion}`,
          )
        } catch {}
      }
    }
    const segments: string[] = []
    if (newPacks.length > 0) segments.push(`installed ${newPacks.join(', ')}`)
    if (upgradedPacks.length > 0) segments.push(`upgraded ${upgradedPacks.join(', ')}`)
    if (segments.length === 0) segments.push(`${entries.length} pack(s) already up-to-date`)
    packsStatus = segments.join('; ')
  }
  results.push(`Packs:    ${packsStatus}`)

  process.stdout.write(`PLUR initialized.

  Architecture: PLUR is a global tool — one MCP server, one engram
  store (~/.plur/), available in every project. Multi-project scoping
  uses domain/scope fields on engrams, not separate installations.

  ${results.join('\n  ')}

`)

  if (mcpStatus.includes('added') || hooksStatus.includes('installed')) {
    process.stdout.write(`  Restart Claude Code to activate.\n\n`)
  } else {
    process.stdout.write(`  Everything is set up. Start a new conversation to use PLUR.\n\n`)
  }
}

// --- Packs subcommands ---

async function runPacks(): Promise<void> {
  const plurPath = process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const { Plur } = await import('@plur-ai/core')
  const { packsCommand } = await import('./packs-cli.js')
  const plur = new Plur({ path: plurPath })

  // The branch logic lives in `packs-cli.ts` so it can be tested without
  // spawning a process. This function's only job is streams and exit.
  const result = await packsCommand(process.argv.slice(3), plur)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

// --- Main execution ---

const arg = process.argv[2]

if (arg === '--help' || arg === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}

if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (arg === 'init') {
  await runInit()
  // Non-zero when the MCP registration did not happen.
  process.exit(process.exitCode ?? 0)
}

if (arg === 'packs') {
  await runPacks()
  process.exit(0)
}

if (arg === 'serve' || arg === undefined) {
  const { runStdio } = await import('./server.js')
  runStdio().catch(err => {
    console.error('Failed to start PLUR MCP server:', err)
    process.exit(1)
  })
} else {
  console.error(`Unknown command: ${arg}\nRun plur-mcp --help for usage.`)
  process.exit(1)
}
