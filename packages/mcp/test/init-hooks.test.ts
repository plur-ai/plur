import { describe, it, expect } from 'vitest'
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
    expect(hooks.SessionStart).toEqual([
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
    expect(mcp.SessionStart).toEqual(cli.SessionStart)
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
      expect(settings.hooks!.SessionStart).toEqual([userSessionStart, ...hooks.SessionStart])
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
    expect(settings.hooks!.SessionStart).toEqual(plurHooks.SessionStart)
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
    expect(settings.hooks!.SessionStart).toEqual(plurHooks.SessionStart)
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
      expect(settings.hooks!.SessionStart).toEqual(hooks.SessionStart)
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
    expect(r.settings.hooks!.SessionStart).toHaveLength(1)
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
    expect(r.settings.hooks!.SessionStart).toEqual([prompt, ...hooks.SessionStart])
  })
})

type HookEntryT = NonNullable<Settings['hooks']>[string][number]
