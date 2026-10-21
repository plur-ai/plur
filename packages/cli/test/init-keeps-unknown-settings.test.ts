/**
 * `plur init` keeps every Claude Code setting it does not own, not only the
 * ones anyone thought to list. The keys, values and hook events below are
 * generated at run time, so the test cannot pass by preserving a known set.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const INIT = ['init', '--global', '--no-prompt', '--no-desktop', '--no-cursor', '--no-codex', '--no-opencode', '--no-antigravity']
const rnd = () => Math.random().toString(36).slice(2, 10)

function arbitrary(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < 4; i++) out[`k_${rnd()}`] = { list: [rnd(), i, { deep: rnd() }], flag: i % 2 === 0, text: rnd() }
  return out
}

describe('plur init keeps settings it does not know about', () => {
  const homes: string[] = []
  afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }) })

  it('arbitrary keys in ~/.claude.json and ~/.claude/settings.json, and user hooks on any event, survive two runs', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-init-unknown-'))
    homes.push(home)
    const claudeJson = { ...arbitrary(), mcpServers: { [`srv_${rnd()}`]: { command: `/opt/${rnd()}`, args: [rnd()], env: { [rnd().toUpperCase()]: rnd() } } } }
    const myHooks: Record<string, unknown[]> = {}
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop', `Event${rnd()}`]) {
      myHooks[event] = [{ matcher: rnd(), hooks: [{ type: 'command', command: `/opt/${rnd()} --flag ${rnd()}` }] }]
    }
    const settings = { ...arbitrary(), hooks: myHooks }
    writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson, null, 2))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))

    for (let run = 1; run <= 2; run++) {
      const r = spawnSync(process.execPath, [CLI, ...INIT], {
        cwd: home, encoding: 'utf8', timeout: 90_000,
        env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' },
      })
      expect(r.status, `plur init run ${run}: ${r.stderr.slice(0, 400)}`).toBe(0)

      const cj = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
      expect(cj.mcpServers?.plur, 'precondition: PLUR registered').toBeTruthy()
      for (const [k, v] of Object.entries(claudeJson)) {
        if (k === 'mcpServers') continue
        expect(cj[k], `~/.claude.json "${k}" after run ${run}`).toEqual(v)
      }
      for (const [name, server] of Object.entries(claudeJson.mcpServers)) {
        expect(cj.mcpServers[name], `MCP server "${name}" after run ${run}`).toEqual(server)
      }

      const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
      for (const [k, v] of Object.entries(settings)) {
        if (k === 'hooks') continue
        expect(s[k], `settings.json "${k}" after run ${run}`).toEqual(v)
      }
      for (const [event, entries] of Object.entries(myHooks)) {
        expect(s.hooks?.[event], `my ${event} hook after run ${run}`).toEqual(expect.arrayContaining(entries))
      }
    }
  }, 200_000)
})
