import { describe, it, expect } from 'vitest'
import { buildPlurHooks, applyPlurHooks } from '../src/index.js'
// @plur-ai/mcp cannot depend on @plur-ai/cli, so the hook definitions are
// mirrored. This import is test-only: it pins the mirror to the source.
import { buildInjectionHooks } from '../../cli/src/commands/init.js'

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
