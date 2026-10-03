/**
 * Cursor hooks decide for the workspace, not for the hook's working folder
 * (finding G1 of the 0.21.1 Codex/Cursor pre-release check).
 *
 * Cursor's hook payload carries no `cwd`, only `workspace_roots`, e.g.
 *   {"conversation_id":"…","hook_event_name":"sessionStart","workspace_roots":["…/und"],"transcript_path":null}
 * The hooks used `payloadDir(input)` = `input.cwd`, else `process.cwd()`. With
 * the hooks loaded from a plugin, the hook process ran in the plugin folder,
 * so PLUR asked about the plugin folder, recorded the user's Yes for it, and
 * wrote `.cursor/rules/plur-context.mdc` there; the workspace stayed
 * undecided. The folder is now `cwd` when the payload has one, else the
 * workspace roots (all of them: any `off` root means off, any undecided root
 * is asked about, and a scope applies only when every root agrees), else the
 * process folder.
 *
 * Each test runs the hook with its working folder set to a "plugin" folder
 * that holds the OPPOSITE decision from the workspace, so a hook that still
 * decides for its own working folder fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { clearFolderAsk } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SESSIONS_DIR = join(tmpdir(), 'plur-cursor-sessions')

let base: string
let home: string
let store: string
let ws: string
let ws2: string
let plugin: string
let conv: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-cursor-roots-')))
  home = join(base, 'home')
  store = join(base, 'store')
  ws = join(base, 'workspace')
  ws2 = join(base, 'workspace2')
  plugin = join(base, 'plugin')
  for (const d of [home, store, ws, ws2, plugin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  conv = `cursor-roots-${randomUUID()}`
})

afterEach(() => {
  for (const suffix of ['.marker', '.reminded', '.stopcount', '.marker.guard-count']) {
    rmSync(join(SESSIONS_DIR, `${conv}${suffix}`), { force: true })
  }
  clearFolderAsk(conv)
  rmSync(base, { recursive: true, force: true })
})

function map(entries: Array<[string, string]>): void {
  writeFileSync(join(store, 'folders.yaml'),
    `version: 1\nfolders:\n${entries.map(([p, m]) => `  - path: "${p}"\n${m}`).join('')}`)
}

/** A recorded Cursor payload shape: no cwd, workspace_roots only. */
function payload(event: string, roots: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversation_id: conv, hook_event_name: event, workspace_roots: roots, transcript_path: null, ...extra }
}

function hook(name: string | string[], input: Record<string, unknown>, cwd = plugin, extraEnv: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [CLI, ...(Array.isArray(name) ? name : [name])], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1', ...extraEnv },
    timeout: 30_000,
  })
  return r.stdout ?? ''
}

/** afterAgentResponse with auto-capture on; true when the learned line reached the store. */
function captured(statement: string): boolean {
  const tmp = join(base, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const reply = `Done.\n\n---\n🧠 I learned:\n- ${statement}\n---\n`
  hook(['hook-auto-rate', 'cursor'], payload('afterAgentResponse', [ws], { text: reply }), plugin,
    { TMPDIR: tmp, PLUR_AUTO_CAPTURE: '1', PLUR_HOOK_HYBRID_DEADLINE_MS: '1' })
  const queue = join(tmp, 'plur-auto-rate')
  const t0 = Date.now()
  while (existsSync(queue) && readdirSync(queue).some(f => /\.(queue|worker)/.test(f)) && Date.now() - t0 < 60_000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  const file = join(store, 'engrams.yaml')
  return existsSync(file) && readFileSync(file, 'utf8').includes(statement)
}

const rule = (dir: string) => join(dir, '.cursor', 'rules', 'plur-context.mdc')

describe('Cursor hooks use workspace_roots, not the hook process folder (G1)', () => {
  it('sessionStart: workspace on, plugin folder undecided → memories, rule file in the workspace only', () => {
    map([[ws, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws]))
    expect(out).toContain('session started')
    expect(out).not.toContain('no decision for this folder yet')
    expect(existsSync(rule(ws))).toBe(true)
    expect(existsSync(rule(plugin)), 'wrote the rule into the plugin folder').toBe(false)
  })

  it('sessionStart: workspace undecided, plugin folder on → the question is about the workspace', () => {
    map([[plugin, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws]))
    expect(out).toContain('no decision for this folder yet')
    expect(out).toContain(ws)
    expect(out).not.toContain(plugin)
    expect(readFileSync(rule(ws), 'utf8')).toContain('no decision for this folder yet')
    expect(existsSync(rule(plugin))).toBe(false)
  })

  it('preToolUse guard: workspace off, plugin folder on → silent', () => {
    map([[ws, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws], { tool_name: 'Shell' }))).toBe('')
  })

  it('preToolUse guard: workspace on, plugin folder off → gates the session', () => {
    map([[ws, '    plur: on\n'], [plugin, '    plur: off\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws], { tool_name: 'Shell' }))).toContain('plur_session_start')
  })

  it('stop: workspace off, plugin folder on → no nudge (3rd completed stop)', () => {
    map([[ws, '    plur: off\n'], [plugin, '    plur: on\n']])
    let out = ''
    for (let i = 0; i < 3; i++) out += hook('hook-cursor-stop', payload('stop', [ws], { status: 'completed' }))
    expect(out).toBe('')
  })

  it('postToolUse: the reminder rule is written in the workspace, not the plugin folder', () => {
    map([[ws, '    plur: on\n'], [plugin, '    plur: on\n']])
    hook('hook-cursor-session-start', payload('sessionStart', [ws]))
    hook('hook-cursor-post-tool', payload('postToolUse', [ws], { tool_name: 'Shell' }))
    expect(existsSync(join(plugin, '.cursor')), 'wrote into the plugin folder').toBe(false)
    expect(existsSync(join(ws, '.cursor', 'rules'))).toBe(true)
  })

  it('afterAgentResponse (auto-rate/capture): workspace off, plugin folder on → nothing captured', () => {
    map([[ws, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(captured('Release candidates in the off workspace are tagged by sprint')).toBe(false)
  })

  it('afterAgentResponse (auto-rate/capture): workspace on, plugin folder off → captured', () => {
    map([[ws, '    plur: on\n'], [plugin, '    plur: off\n']])
    expect(captured('Release candidates in the on workspace are tagged by sprint')).toBe(true)
  })

  it('two roots: one off → off, even when the other is on', () => {
    map([[ws, '    plur: on\n'], [ws2, '    plur: off\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws, ws2], { tool_name: 'Shell' }))).toBe('')
  })

  it('two roots, both on with different scopes → on, and no scope is applied', () => {
    map([[ws, '    plur: on\n    scope: "project:alpha"\n'], [ws2, '    plur: on\n    scope: "project:beta"\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws, ws2]))
    expect(out).toContain('session started')
    expect(out).not.toContain('Project scope:')
  })

  it('two roots, both on with one scope → that scope', () => {
    map([[ws, '    plur: on\n    scope: "project:alpha"\n'], [ws2, '    plur: on\n    scope: "project:alpha"\n']])
    expect(hook('hook-cursor-session-start', payload('sessionStart', [ws, ws2]))).toContain('Project scope: project:alpha')
  })

  it('a payload cwd still wins over workspace_roots', () => {
    map([[ws, '    plur: off\n'], [ws2, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws], { cwd: ws2 }))
    expect(out).toContain('session started')
    expect(existsSync(rule(ws2))).toBe(true)
  })

  it('no cwd and no workspace_roots → the hook process folder, as before', () => {
    map([[plugin, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', { conversation_id: conv, hook_event_name: 'sessionStart' })
    expect(out).toContain('session started')
    expect(existsSync(rule(plugin))).toBe(true)
  })
})
