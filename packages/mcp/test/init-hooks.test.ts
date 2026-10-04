import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildPlurHooks, applyPlurHooks, type Settings } from '../src/index.js'
// @plur-ai/mcp cannot depend on @plur-ai/cli, so the hook definitions are
// mirrored. This import is test-only: it pins the mirror to the source.
import { buildInjectionHooks, buildEnforcementHooks } from '../../cli/src/commands/init.js'

/**
 * #1279: `plur-mcp init` registered rehydrate on PostCompact, which Claude
 * Code cannot deliver context through (#1274). It must register the same
 * SessionStart(compact) entry as `plur init`, and re-running it must move a
 * stale PostCompact entry without touching the user's own hooks.
 */

const CMD = 'npx @plur-ai/cli'

describe('plur-mcp init hook definitions (#1279)', () => {
  it('registers rehydrate on SessionStart with matcher compact, not PostCompact', () => {
    const hooks = buildPlurHooks(CMD)
    expect(hooks.PostCompact).toBeUndefined()
    expect(compactOnly(hooks.SessionStart)).toEqual([
      {
        matcher: 'compact',
        hooks: [{ type: 'command', command: `${CMD} hook-inject --rehydrate`, timeout: 20 }],
      },
    ])
  })

  it('rehydrate entry matches `plur init` exactly (parity with the cli source)', () => {
    const mcp = buildPlurHooks(CMD)
    const cli = buildInjectionHooks(CMD)
    expect(cli.PostCompact).toBeUndefined()
    expect(compactOnly(mcp.SessionStart)).toEqual(cli.SessionStart)
  })

  it('registers the SessionStart(resume) hook next to SessionEnd, identical to `plur init` (#1347 option C)', () => {
    const mcp = buildPlurHooks(CMD)
    const cli = buildEnforcementHooks(CMD)
    const resume = (entries: Array<{ matcher?: string }>) => entries.filter(e => e.matcher === 'resume')
    expect(resume(mcp.SessionStart)).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: `${CMD} hook-session-resume`, timeout: 3 }] },
    ])
    expect(resume(mcp.SessionStart)).toEqual(resume(cli.SessionStart))
    expect(mcp.SessionEnd).toBeDefined()
  })
})

/** The SessionStart entries other than the resume one (#1347 option C). */
function compactOnly<T extends { matcher?: string }>(entries: T[]): T[] {
  return entries.filter(e => e.matcher !== 'resume')
}

describe('applyPlurHooks adds the resume hook to an install that has SessionEnd (#1347 option C)', () => {
  const hooks = buildPlurHooks(CMD)
  const withoutResume = () => ({
    hooks: {
      UserPromptSubmit: hooks.UserPromptSubmit,
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }, ...compactOnly(hooks.SessionStart)],
      SessionEnd: hooks.SessionEnd,
    },
  })

  it('an older install with SessionEnd but no resume hook gets it, once', () => {
    const first = applyPlurHooks(withoutResume(), hooks)
    expect(first.status).toBe('healed')
    const resume = first.settings.hooks!.SessionStart.filter(e => e.matcher === 'resume')
    expect(resume).toHaveLength(1)
    expect(resume[0].hooks[0].command).toBe(`${CMD} hook-session-resume`)
    // the user's own SessionStart hook is kept, in place
    expect(first.settings.hooks!.SessionStart[0]).toEqual({ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] })
    const second = applyPlurHooks(JSON.parse(JSON.stringify(first.settings)), hooks)
    expect(second.status).toBe('already')
  })

  it('a file with PLUR hooks but no SessionEnd gets no resume hook', () => {
    const old = { hooks: { UserPromptSubmit: hooks.UserPromptSubmit } }
    const { settings, status } = applyPlurHooks(old, hooks)
    expect(status).toBe('already')
    expect(settings.hooks!.SessionStart).toBeUndefined()
  })
})

describe('applyPlurHooks (#1279)', () => {
  const plurHooks = buildPlurHooks(CMD)
  const userStop = { matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }
  const userCompact = { matcher: 'auto', hooks: [{ type: 'command', command: 'echo compacted' }] }
  const userSessionStart = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }

  it('fresh install adds every plur hook next to existing user hooks', () => {
    const { settings, status } = applyPlurHooks({ hooks: { Stop: [userStop] } }, plurHooks)
    expect(status).toBe('installed')
    expect(settings.hooks!.Stop[0]).toEqual(userStop)
    expect(settings.hooks!.SessionStart).toEqual(plurHooks.SessionStart)
    expect(settings.hooks!.PostCompact).toBeUndefined()
  })

  for (const cli of ['npx @plur-ai/cli', '/home/u/.plur/bin/plur-hook']) {
    it(`re-run moves a stale PostCompact rehydrate to SessionStart(compact) — ${cli}`, () => {
      const hooks = buildPlurHooks(cli)
      const old = {
        hooks: {
          UserPromptSubmit: hooks.UserPromptSubmit,
          PostCompact: [
            { matcher: 'auto|manual', hooks: [{ type: 'command', command: `${cli} hook-inject --rehydrate`, timeout: 15 }] },
            userCompact,
          ],
          SessionStart: [userSessionStart],
          Stop: [userStop, ...hooks.Stop],
        },
      }
      const { settings, status } = applyPlurHooks(old, hooks)
      expect(status).toBe('healed')
      // user hooks untouched, in place
      expect(settings.hooks!.PostCompact).toEqual([userCompact])
      expect(settings.hooks!.SessionStart).toEqual([userSessionStart, ...compactOnly(hooks.SessionStart)])
      expect(settings.hooks!.Stop).toEqual([userStop, ...hooks.Stop])
      expect(settings.hooks!.UserPromptSubmit).toEqual(hooks.UserPromptSubmit)
    })
  }

  it('drops the PostCompact key when only the plur entry was there', () => {
    const old = {
      hooks: {
        UserPromptSubmit: plurHooks.UserPromptSubmit,
        PostCompact: [
          { matcher: 'auto|manual', hooks: [{ type: 'command', command: `${CMD} hook-inject --rehydrate`, timeout: 15 }] },
        ],
      },
    }
    const { settings } = applyPlurHooks(old, plurHooks)
    expect(settings.hooks!.PostCompact).toBeUndefined()
    expect(settings.hooks!.SessionStart).toEqual(compactOnly(plurHooks.SessionStart))
  })

  it('an up-to-date install is left alone', () => {
    const first = applyPlurHooks({ hooks: { Stop: [userStop] } }, plurHooks).settings
    const snapshot = JSON.parse(JSON.stringify(first))
    const { settings, status } = applyPlurHooks(first, plurHooks)
    expect(status).toBe('already')
    expect(settings).toEqual(snapshot)
  })
})

/**
 * Review of #1300: the PostCompact cleanup used a bare substring test and
 * dropped whole entries, so it deleted the user's own hooks, and on Windows it
 * never recognised the backslash shim path, so every re-run appended a second
 * full hook set (#1303). A hook is PLUR's only when it names PLUR's binary
 * followed by a subcommand init writes; PLUR hooks are removed one at a time.
 */
describe('applyPlurHooks only ever removes PLUR hooks (#1300 review, #1303)', () => {
  const plurHooks = buildPlurHooks(CMD)
  const legacyRehydrate = (cli: string) => ({
    type: 'command', command: `${cli} hook-inject --rehydrate`, timeout: 15,
  })
  const userHook = { type: 'command', command: 'echo compacted >> ~/compact.log' }

  it('a user hook sharing an entry with the legacy rehydrate hook is kept', () => {
    const old = {
      hooks: {
        UserPromptSubmit: plurHooks.UserPromptSubmit,
        PostCompact: [{ matcher: 'auto|manual', hooks: [legacyRehydrate(CMD), userHook] }],
      },
    }
    const { settings, status } = applyPlurHooks(old, plurHooks)
    expect(status).toBe('healed')
    expect(settings.hooks!.PostCompact).toEqual([{ matcher: 'auto|manual', hooks: [userHook] }])
    expect(settings.hooks!.SessionStart).toEqual(compactOnly(plurHooks.SessionStart))
  })

  it("a user's own `npx @plur-ai/cli doctor` PostCompact hook is kept", () => {
    const doctor = { matcher: 'auto', hooks: [{ type: 'command', command: 'npx @plur-ai/cli doctor >> ~/log' }] }
    const old = {
      hooks: {
        ...plurHooks,
        PostCompact: [doctor],
      },
    }
    const snapshot = JSON.parse(JSON.stringify(old))
    const { settings, status } = applyPlurHooks(old, plurHooks)
    expect(status).toBe('already')
    expect(settings).toEqual(snapshot)
  })

  const winShims = [
    // What `plur-mcp init` writes on Windows: the unquoted backslash path.
    'C:\\Users\\Test\\.plur\\bin\\plur-hook.cmd',
    // What `plur init` writes on Windows since #1267: the quoted path.
    '"C:\\Users\\Test User\\.plur\\bin\\plur-hook.cmd"',
  ]
  for (const shim of winShims) {
    it(`recognises the Windows shim form ${shim}: a re-run is 'already', no duplicate`, () => {
      const hooks = buildPlurHooks(shim)
      const first = applyPlurHooks({ hooks: { Stop: [userStop()] } }, hooks)
      expect(first.status).toBe('installed')
      const snapshot = JSON.parse(JSON.stringify(first.settings))
      const second = applyPlurHooks(first.settings, hooks)
      expect(second.status).toBe('already')
      expect(second.settings).toEqual(snapshot)
      expect(second.settings.hooks!.UserPromptSubmit).toHaveLength(1)
    })

    it(`heals a stale Windows PostCompact rehydrate hook — ${shim}`, () => {
      const hooks = buildPlurHooks(shim)
      const old = {
        hooks: {
          UserPromptSubmit: hooks.UserPromptSubmit,
          PostCompact: [{ matcher: 'auto|manual', hooks: [legacyRehydrate(shim)] }],
        },
      }
      const { settings, status } = applyPlurHooks(old, hooks)
      expect(status).toBe('healed')
      expect(settings.hooks!.PostCompact).toBeUndefined()
      expect(settings.hooks!.SessionStart).toEqual(compactOnly(hooks.SessionStart))
    })
  }

  it('#1303: running init twice with the shim form leaves the second run a no-op', () => {
    for (const shim of ['/home/u/.plur/bin/plur-hook', 'C:\\Users\\u\\.plur\\bin\\plur-hook.cmd']) {
      const hooks = buildPlurHooks(shim)
      let settings: Settings = {}
      const statuses: string[] = []
      for (let run = 0; run < 3; run++) {
        const r = applyPlurHooks(settings, hooks)
        statuses.push(r.status)
        settings = JSON.parse(JSON.stringify(r.settings))
      }
      expect(statuses).toEqual(['installed', 'already', 'already'])
      expect(settings).toEqual({ hooks })
    }
  })

  it('a user-only hook naming .plur/bin/plur-hook-backup.ps1 does not count as installed', () => {
    const backup = {
      matcher: 'auto',
      hooks: [{ type: 'command', command: 'pwsh ~/.plur/bin/plur-hook-backup.ps1 hook-inject' }],
    }
    const { settings, status } = applyPlurHooks({ hooks: { PostCompact: [backup] } }, plurHooks)
    expect(status).toBe('installed')
    expect(settings.hooks!.PostCompact).toEqual([backup])
    expect(settings.hooks!.UserPromptSubmit).toEqual(plurHooks.UserPromptSubmit)
  })

  function userStop() {
    return { matcher: '*', hooks: [{ type: 'command', command: 'say done' }] }
  }
})

describe('applyPlurHooks heal scope (#1300 review, second round)', () => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

  // `plur init` writes only the enforcement hooks to the global settings file
  // and the injection hooks (rehydrate included) to the project's. Running
  // `plur-mcp init` from a directory without .claude/ targets the global
  // file; adding rehydrate there would run it twice per compaction.
  for (const cmd of ['npx @plur-ai/cli', '/home/u/.plur/bin/plur-hook']) {
    it(`global settings holding only plur init enforcement hooks are left unchanged — ${cmd}`, () => {
      const global = { hooks: clone(buildEnforcementHooks(cmd)) }
      const snapshot = clone(global)
      const { settings, status } = applyPlurHooks(global, buildPlurHooks(cmd))
      expect(status).toBe('already')
      expect(settings).toEqual(snapshot)
    })
  }

  it('a Windows-cased backslash rehydrate on SessionStart counts as present', () => {
    const cmd = 'C:\\Users\\U\\.plur\\bin\\plur-hook.cmd'
    const hooks = buildPlurHooks(cmd)
    const settings = clone({ hooks }) as Settings
    settings.hooks!.SessionStart[0].hooks[0].command = `"${cmd}" HOOK-INJECT  --REHYDRATE`
    settings.hooks!.PostCompact = [
      { matcher: 'auto|manual', hooks: [{ type: 'command', command: `"${cmd}" hook-inject --rehydrate`, timeout: 15 }] },
    ]
    const r = applyPlurHooks(settings, hooks)
    expect(r.status).toBe('healed')
    expect(r.settings.hooks!.PostCompact).toBeUndefined()
    // the existing (differently cased) rehydrate is recognised: no second one
    expect(compactOnly(r.settings.hooks!.SessionStart)).toHaveLength(1)
  })

  it('hooks without a command (type prompt / agent) do not make init throw', () => {
    const prompt = { hooks: [{ type: 'prompt', prompt: 'be nice' }] } as unknown as HookEntryT
    const agent = { matcher: 'auto', hooks: [{ type: 'agent', agent: 'x' }] } as unknown as HookEntryT
    const hooks = buildPlurHooks('npx @plur-ai/cli')
    expect(() => applyPlurHooks({ hooks: { Stop: [prompt] } }, hooks)).not.toThrow()
    const old: Settings = {
      hooks: {
        UserPromptSubmit: clone(hooks.UserPromptSubmit),
        PostCompact: [agent, { matcher: 'auto|manual', hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject --rehydrate', timeout: 15 }] }],
        SessionStart: [prompt],
      },
    }
    const r = applyPlurHooks(old, hooks)
    expect(r.status).toBe('healed')
    expect(r.settings.hooks!.PostCompact).toEqual([agent])
    expect(r.settings.hooks!.SessionStart).toEqual([prompt, ...compactOnly(hooks.SessionStart)])
  })
})

type HookEntryT = NonNullable<Settings['hooks']>[string][number]

/**
 * #1270 merge: on Windows `plur init` writes Claude Code hooks in exec form
 * (node + the CLI js entry recorded in ~/.plur/bin/plur-hook.meta.json +
 * hook-*). `plur-mcp init` must see them as PLUR's (the spec-level check,
 * isPlurHookSpec), so it neither adds a second set nor leaves a stale exec-form
 * PostCompact rehydrate behind; a node hook running another script stays the
 * user's.
 */
describe('applyPlurHooks recognises the exec form plur init writes on Windows (#1270)', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const ENTRY = 'C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'
  const exec = (sub: string, ...extra: string[]) => ({ type: 'command', command: NODE, args: [ENTRY, sub, ...extra], timeout: 15 })
  const userNode = { type: 'command', command: NODE, args: ['C:\\scripts\\mine.js', 'hook-inject'] }
  let home = ''
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-mcp-exec-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
    writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), JSON.stringify({ entrypoints: [ENTRY] }))
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('an exec-form install counts as installed: nothing is added', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [exec('hook-inject')] }],
        SessionStart: [{ matcher: 'compact', hooks: [exec('hook-inject', '--rehydrate')] }],
        Stop: [{ matcher: '*', hooks: [exec('hook-learn-check')] }],
      },
    } as unknown as Settings
    const snapshot = JSON.parse(JSON.stringify(settings))
    const { settings: next, status } = applyPlurHooks(settings, buildPlurHooks('C:\\Users\\U\\.plur\\bin\\plur-hook.cmd'))
    expect(status).toBe('already')
    expect(next).toEqual(snapshot)
  })

  it('a stale exec-form PostCompact rehydrate is healed; a user node hook beside it is kept', () => {
    const hooks = buildPlurHooks('C:\\Users\\U\\.plur\\bin\\plur-hook.cmd')
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [exec('hook-inject')] }],
        PostCompact: [{ matcher: 'auto|manual', hooks: [exec('hook-inject', '--rehydrate'), userNode] }],
      },
    } as unknown as Settings
    const { settings: next, status } = applyPlurHooks(settings, hooks)
    expect(status).toBe('healed')
    expect(next.hooks!.PostCompact).toEqual([{ matcher: 'auto|manual', hooks: [userNode] }])
    // No PLUR SessionEnd in this file, so no resume entry either (#1347 option C).
    expect(next.hooks!.SessionStart).toEqual(compactOnly(hooks.SessionStart))
  })

  it('a node hook running another script is not an install', () => {
    const settings = { hooks: { UserPromptSubmit: [{ hooks: [userNode] }] } } as unknown as Settings
    const { status } = applyPlurHooks(settings, buildPlurHooks('npx @plur-ai/cli'))
    expect(status).toBe('installed')
  })
})
