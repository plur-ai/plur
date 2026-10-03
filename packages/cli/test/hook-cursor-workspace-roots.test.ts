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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { pathToFileURL } from 'url'
import yaml from 'js-yaml'
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

/**
 * afterAgentResponse with auto-capture on, for `roots`. Returns undefined when
 * the learned line did not reach the store, else the scope it was stored
 * under (null for none: `global`, the local store).
 */
function captureScope(statement: string, roots: string[] = [ws]): string | null | undefined {
  const tmp = join(base, 'tmp')
  mkdirSync(tmp, { recursive: true })
  const reply = `Done.\n\n---\n🧠 I learned:\n- ${statement}\n---\n`
  hook(['hook-auto-rate', 'cursor'], payload('afterAgentResponse', roots, { text: reply }), plugin,
    { TMPDIR: tmp, PLUR_AUTO_CAPTURE: '1', PLUR_HOOK_HYBRID_DEADLINE_MS: '1' })
  const queue = join(tmp, 'plur-auto-rate')
  const t0 = Date.now()
  while (existsSync(queue) && readdirSync(queue).some(f => /\.(queue|worker)/.test(f)) && Date.now() - t0 < 60_000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  const file = join(store, 'engrams.yaml')
  if (!existsSync(file)) return undefined
  const doc = yaml.load(readFileSync(file, 'utf8')) as unknown
  const list = (Array.isArray(doc) ? doc : (doc as { engrams?: unknown[] } | null)?.engrams ?? []) as Array<Record<string, unknown>>
  const hit = list.find(e => e?.statement === statement)
  if (!hit) return undefined
  // learn() without a scope stores `global`: the local store, no team scope.
  return typeof hit.scope === 'string' && hit.scope !== 'global' ? hit.scope : null
}

function captured(statement: string): boolean {
  return captureScope(statement) !== undefined
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

  it('two roots: one off → off, even when the other is on (and the hook process folder is on)', () => {
    // The plugin folder is ON, so a hook that still decides for its own
    // folder gates the session here and fails (audit L5 of #1583).
    map([[ws, '    plur: on\n'], [ws2, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws, ws2], { tool_name: 'Shell' }))).toBe('')
    expect(hook('hook-cursor-session-start', payload('sessionStart', [ws, ws2]))).toBe('')
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

  it('no cwd and no workspace_roots → the hook process folder, as before', () => {
    map([[plugin, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', { conversation_id: conv, hook_event_name: 'sessionStart' })
    expect(out).toContain('session started')
    expect(existsSync(rule(plugin))).toBe(true)
  })
})

/**
 * The audit of #1583 (2026-10-04): every Cursor hook reaches the MCP server's
 * decision for the same workspace (workspaceWriteScope and the folder gate),
 * and fails closed when in doubt.
 */
describe('Cursor hooks reach the MCP decision for the workspace (audit of #1583)', () => {
  // M1: end-of-turn capture uses the scope decided for the workspace.
  it('M1: auto-capture, roots alpha + beta → stored with no scope', () => {
    map([[ws, '    plur: on\n    scope: "project:alpha"\n'], [ws2, '    plur: on\n    scope: "project:beta"\n']])
    expect(captureScope('Probe M1 statement about two disagreeing roots', [ws, ws2])).toBeNull()
  })

  it('M1: auto-capture, roots alpha + an unscoped on root → stored with no scope', () => {
    map([[ws, '    plur: on\n    scope: "project:alpha"\n'], [ws2, '    plur: on\n']])
    expect(captureScope('Probe M1 statement about scoped plus personal roots', [ws, ws2])).toBeNull()
  })

  it('M1: auto-capture, a single alpha root → stored in alpha', () => {
    map([[ws, '    plur: on\n    scope: "project:alpha"\n']])
    expect(captureScope('Probe M1 statement about one scoped root', [ws])).toBe('project:alpha')
  })

  // L1: any root off is off for every hook; cwd never overrides it.
  it('L1: roots [on, off], preToolUse cwd on the on root → the guard does not block', () => {
    map([[ws, '    plur: on\n'], [ws2, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws, ws2], { tool_name: 'Shell', cwd: ws }))).toBe('')
  })

  it('L1: roots [on, off], postToolUse cwd on the on root → the session is not marked started', () => {
    map([[ws, '    plur: on\n'], [ws2, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-post-tool', payload('postToolUse', [ws, ws2], { tool_name: 'plur_session_start', cwd: ws }))).toBe('')
    expect(existsSync(join(SESSIONS_DIR, `${conv}.marker`)), 'post-tool acted in an off workspace').toBe(false)
    expect(existsSync(join(ws, '.cursor'))).toBe(false)
  })

  it('L1: a payload cwd that is off turns the workspace off', () => {
    map([[ws, '    plur: on\n'], [ws2, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws], { tool_name: 'Shell', cwd: ws2 }))).toBe('')
  })

  it('L1: a payload cwd only picks the root it is in; output goes to that root, never the cwd itself', () => {
    map([[ws, '    plur: on\n'], [ws2, '    plur: on\n']])
    const sub = join(ws2, 'sub')
    mkdirSync(sub)
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws, ws2], { cwd: sub }))
    expect(out).toContain('session started')
    expect(existsSync(rule(ws2))).toBe(true)
    expect(existsSync(rule(ws))).toBe(false)
    expect(existsSync(rule(sub))).toBe(false)
  })

  // L2: roots present but unusable fail closed; no fall-back to the process folder.
  for (const [name, roots] of [
    ['relative path', ['workspace']],
    ['non-array value', 'WS'],
    ['empty list', []],
    ['a URI that is not a local file', ['vscode-remote://ssh-remote+box/home/x']],
  ] as Array<[string, unknown]>) {
    it(`L2: workspace_roots ${name}, hook process folder on → silent (no memory, no question)`, () => {
      map([[plugin, '    plur: on\n']])
      const r = roots === 'WS' ? ws : roots
      expect(hook('hook-cursor-session-start', { conversation_id: conv, hook_event_name: 'sessionStart', workspace_roots: r }, base)).toBe('')
      expect(hook('hook-cursor-session-start', { conversation_id: conv, hook_event_name: 'sessionStart', workspace_roots: r })).toBe('')
      expect(hook('hook-cursor-guard', { conversation_id: conv, hook_event_name: 'preToolUse', workspace_roots: r, tool_name: 'Shell' })).toBe('')
      expect(existsSync(rule(plugin))).toBe(false)
    })
  }

  it('L2: a file:// root is read as the folder it names (on → memory, rule file there)', () => {
    map([[ws, '    plur: on\n'], [plugin, '    plur: off\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [pathToFileURL(ws).href]))
    expect(out).toContain('session started')
    expect(existsSync(rule(ws))).toBe(true)
  })

  it('L2: a file:// root of an off workspace, hook process folder on → silent', () => {
    map([[ws, '    plur: off\n'], [plugin, '    plur: on\n']])
    expect(hook('hook-cursor-session-start', payload('sessionStart', [pathToFileURL(ws).href]))).toBe('')
  })

  // L3: a root that does not exist is still checked for off.
  it('L3: roots [on, missing folder mapped off] → off', () => {
    const gone = join(base, 'not-mounted')
    map([[ws, '    plur: on\n'], [gone, '    plur: off\n']])
    expect(hook('hook-cursor-session-start', payload('sessionStart', [ws, gone]))).toBe('')
    expect(hook('hook-cursor-guard', payload('preToolUse', [ws, gone], { tool_name: 'Shell' }))).toBe('')
  })

  it('L3: roots [alpha, missing folder with no entry] → on, and no scope (the missing root breaks agreement)', () => {
    const gone = join(base, 'not-mounted')
    map([[ws, '    plur: on\n    scope: "project:alpha"\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws, gone]))
    expect(out).toContain('session started')
    expect(out).not.toContain('Project scope:')
  })

  // L4: the home folder is never asked about and never gives a scope.
  it('L4: a single home-folder root, undecided → no question', () => {
    const out = hook('hook-cursor-session-start', payload('sessionStart', [home]))
    expect(out).not.toContain('no decision for this folder yet')
    expect(existsSync(rule(home))).toBe(false)
  })

  it('L4: a single home-folder root mapped on with a scope → memory, but no scope', () => {
    map([[home, '    plur: on\n    scope: "project:alpha"\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [home]))
    expect(out).toContain('session started')
    expect(out).not.toContain('Project scope:')
  })

  it('L4: roots [home, undecided workspace] → the question is about the workspace', () => {
    const out = hook('hook-cursor-session-start', payload('sessionStart', [home, ws]))
    expect(out).toContain('no decision for this folder yet')
    expect(out).toContain(ws)
    expect(existsSync(rule(home))).toBe(false)
  })

  // L5: which undecided root is asked about.
  it('L5: roots [on, undecided] → the question is about the undecided root', () => {
    map([[ws, '    plur: on\n'], [plugin, '    plur: on\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws, ws2]))
    expect(out).toContain('no decision for this folder yet')
    expect(out).toContain(ws2)
    expect(existsSync(rule(ws2))).toBe(true)
    expect(existsSync(rule(ws))).toBe(false)
  })

  it('L5: roots [undecided, undecided] → the first root is asked about', () => {
    const out = hook('hook-cursor-session-start', payload('sessionStart', [ws2, ws]))
    expect(out).toContain('no decision for this folder yet')
    expect(existsSync(rule(ws2))).toBe(true)
    expect(existsSync(rule(ws))).toBe(false)
  })

  // L7: each root is realpath-resolved before .plur.yaml and folders.yaml are read.
  it('L7: a symlinked root takes the decision of the folder it points at, not of the link\'s parent', () => {
    const real = join(base, 'real', 'proj')
    const linkParent = join(base, 'linkparent')
    mkdirSync(real, { recursive: true })
    mkdirSync(linkParent)
    const link = join(linkParent, 'proj')
    symlinkSync(real, link, 'dir')
    // A trusted .plur.yaml above the LINK (not above the target) asks for a scope.
    writeFileSync(join(linkParent, '.plur.yaml'), 'scope: "project:wrong"\n')
    map([[real, '    plur: on\n'], [linkParent, '    plur: on\n    trusted: true\n']])
    const out = hook('hook-cursor-session-start', payload('sessionStart', [link]))
    expect(out).toContain('session started')
    expect(out).not.toContain('project:wrong')
    expect(existsSync(rule(real))).toBe(true)
  })
})
