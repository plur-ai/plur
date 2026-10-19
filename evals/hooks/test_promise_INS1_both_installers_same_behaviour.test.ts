// INS-1: Both ways of installing PLUR give my agent the same memory behaviour,
// and installing twice changes nothing the second time.
//
// The two installers are `plur init` (packages/cli) and `plur-mcp init`
// (packages/mcp), each run from source into its own empty HOME. What the
// agent's memory does in Claude Code is decided by the hooks they register in
// ~/.claude/settings.json: which PLUR hook command runs on which event (and
// for which tool matcher). Those are compared as sets; how a command is
// launched (shim path, npx) is not part of the behaviour and is stripped.
//
// Parity and idempotence are separate tests, so a red one says which half
// is broken.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookHome, runSource, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

// plur init would also configure Claude Desktop, Cursor, Codex, opencode and
// Antigravity when it finds them; plur-mcp init only knows Claude Code. Those
// legs are turned off so the comparison is Claude Code against Claude Code.
const CLI_INIT = ['init', '--global', '--no-prompt', '--no-desktop', '--no-cursor', '--no-codex', '--no-opencode', '--no-antigravity']
const MCP_INIT = ['init']

type Installer = 'plur init' | 'plur-mcp init'

function install(h: HookHome, which: Installer): void {
  const r = which === 'plur init'
    ? runSource('cli', CLI_INIT, { env: h.env, cwd: h.home, timeoutMs: 90_000 })
    : runSource('mcp', MCP_INIT, { env: h.env, cwd: h.home, timeoutMs: 90_000 })
  if (r.status !== 0) throw new Error(`${which} failed (exit ${r.status}): ${r.stderr.slice(0, 500)}`)
}

/** "<event> [<matcher>] <hook command and its flags>" for every PLUR hook in settings.json. */
function hookBehaviour(h: HookHome): string[] {
  const path = join(h.home, '.claude', 'settings.json')
  if (!existsSync(path)) throw new Error(`no ${path} was written`)
  const settings = JSON.parse(readFileSync(path, 'utf8'))
  const out = new Set<string>()
  for (const [event, entries] of Object.entries<any[]>(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const cmd = [hook.command, ...(hook.args ?? [])].join(' ')
        const m = cmd.match(/\b(hook-[a-z-]+(?:\s+[^"']*)?)/)
        if (m) out.add(`${event} [${entry.matcher ?? ''}] ${m[1].trim().replace(/\s+/g, ' ')}`)
      }
    }
  }
  return [...out].sort()
}

/** Every file outside the memory store itself, with its content: what an install leaves for the agent. */
function snapshot(h: HookHome): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const rel = relative(h.home, p)
      if (rel === '.plur' || rel === 'tmp') continue
      if (statSync(p).isDirectory()) walk(p)
      else out[rel] = readFileSync(p, 'utf8')
    }
  }
  walk(h.home)
  return out
}

describe('INS-1 both installers give the same memory behaviour; a second install changes nothing', () => {
  const homes: HookHome[] = []
  afterEach(() => { while (homes.length) homes.pop()!.cleanup() })
  const fresh = () => { const h = hookHome(); homes.push(h); return h }

  it('plur init and plur-mcp init register the same memory hooks', () => {
    const viaCli = fresh()
    const viaMcp = fresh()
    install(viaCli, 'plur init')
    install(viaMcp, 'plur-mcp init')
    const cli = hookBehaviour(viaCli)
    const mcp = hookBehaviour(viaMcp)
    expect(cli.length, 'precondition: plur init registered memory hooks').toBeGreaterThan(0)
    expect(mcp.length, 'precondition: plur-mcp init registered memory hooks').toBeGreaterThan(0)

    const onlyCli = cli.filter(x => !mcp.includes(x))
    const onlyMcp = mcp.filter(x => !cli.includes(x))
    expect({ onlyInPlurInit: onlyCli, onlyInPlurMcpInit: onlyMcp },
      'the two installers give the agent different memory hooks').toEqual({ onlyInPlurInit: [], onlyInPlurMcpInit: [] })
  }, 180_000)

  for (const which of ['plur init', 'plur-mcp init'] as const) {
    it(`${which} run twice: the second run changes nothing`, () => {
      const h = fresh()
      install(h, which)
      const once = snapshot(h)
      expect(hookBehaviour(h).length, `precondition: ${which} registered memory hooks`).toBeGreaterThan(0)
      install(h, which)
      const twice = snapshot(h)

      const added = Object.keys(twice).filter(k => !(k in once))
      const removed = Object.keys(once).filter(k => !(k in twice))
      const changed = Object.keys(once).filter(k => k in twice && once[k] !== twice[k])
      expect({ added, removed, changed }, `the second ${which} changed the install`)
        .toEqual({ added: [], removed: [], changed: [] })
    }, 180_000)
  }
})
