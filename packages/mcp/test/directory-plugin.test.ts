import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { INSTRUCTIONS, NEUTRAL_INSTRUCTIONS, createServer, resolveInstructions } from '../src/server.js'

/**
 * Claude's directory lists a local MCP server only inside a plugin, and its
 * review rejects text that tells Claude how to behave. The directory build
 * runs the same server with neutral instructions and no automatic hooks:
 * memory is saved and recalled when the person asks.
 */

const REPO = join(__dirname, '..', '..', '..')
const PLUGIN = join(REPO, 'plugins', 'plur')
const MCP_VERSION: string = JSON.parse(readFileSync(join(REPO, 'packages', 'mcp', 'package.json'), 'utf-8')).version

const STEERING = [
  /do not ask permission/i,
  /end every reply/i,
  /every reply/i,
  /end your responses/i,
  /immediately/i,
  /\bnpx @plur-ai\/mcp init\b/,
  /Memory — recalled/,
]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

describe('neutral server instructions', () => {
  it('leaves the default instructions alone for existing users', () => {
    expect(resolveInstructions({} as NodeJS.ProcessEnv)).toBe(INSTRUCTIONS)
    expect(resolveInstructions({ PLUR_INSTRUCTIONS: 'nonsense' } as NodeJS.ProcessEnv)).toBe(INSTRUCTIONS)
  })

  it('selects the neutral text only when asked', () => {
    expect(resolveInstructions({ PLUR_INSTRUCTIONS: 'neutral' } as NodeJS.ProcessEnv)).toBe(NEUTRAL_INSTRUCTIONS)
  })

  it.each(STEERING)('neutral text contains no steering: %s', pattern => {
    expect(NEUTRAL_INSTRUCTIONS).not.toMatch(pattern)
  })

  it('names the tools a person would ask for', () => {
    for (const tool of ['plur_recall', 'plur_learn', 'plur_forget']) expect(NEUTRAL_INSTRUCTIONS).toContain(tool)
  })

  it('says when a note belongs to one project and when it follows the person', () => {
    // Measured: with no folder scope a project's convention reached every other
    // project (15/15), and a preference only followed the person when global.
    expect(NEUTRAL_INSTRUCTIONS).toMatch(/scope.{0,20}global/)
  })

  it('names lasting corrections, preferences and conventions as what plur_learn is for', () => {
    expect(NEUTRAL_INSTRUCTIONS).toMatch(/plur_learn saves .*correction.*preference.*convention/)
  })

  it('says how to answer the folder question when the plur command is not installed', () => {
    // The plugin installs the server, not the CLI, and a new folder starts
    // undecided: without this a plugin user cannot turn memory on at all.
    expect(NEUTRAL_INSTRUCTIONS).toContain(`npx -y @plur-ai/cli@${MCP_VERSION}`)
  })

  describe('wired into the server', () => {
    let dir = ''
    const before = process.env.PLUR_INSTRUCTIONS
    afterEach(() => {
      if (before === undefined) delete process.env.PLUR_INSTRUCTIONS
      else process.env.PLUR_INSTRUCTIONS = before
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('hands the neutral text to the client', async () => {
      process.env.PLUR_INSTRUCTIONS = 'neutral'
      dir = mkdtempSync(join(tmpdir(), 'plur-directory-'))
      const server = (await createServer(new Plur({ path: dir }))) as unknown as { _instructions?: string }
      expect(server._instructions).toBe(NEUTRAL_INSTRUCTIONS)
    })
  })
})

describe('plugins/plur meets the directory checks', () => {
  const manifest = () => JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf-8'))
  const mcp = () => JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf-8')).mcpServers.plur

  it('names itself and its listing links', () => {
    const m = manifest()
    expect(m.name).toBe('plur')
    expect(m.license).toBe('Apache-2.0')
    expect(m.privacyPolicyUrl).toMatch(/^https:\/\//)
    expect(m.documentationUrl).toMatch(/^https:\/\//)
    expect(m.supportUrl).toMatch(/^https:\/\//)
    expect(existsSync(join(PLUGIN, m.icon))).toBe(true)
  })

  it('moves in step with the MCP package', () => {
    expect(manifest().version).toBe(MCP_VERSION)
    expect(mcp().args).toEqual(['-y', `@plur-ai/mcp@${MCP_VERSION}`])
  })

  it('runs the server in neutral mode', () => {
    expect(mcp().command).toBe('npx')
    expect(mcp().env.PLUR_INSTRUCTIONS).toBe('neutral')
  })

  it('keeps each project\'s notes to that project, for both the server and the hooks', () => {
    expect(mcp().env.PLUR_FOLDER_SCOPE).toBe('project')
    expect(readFileSync(join(PLUGIN, 'scripts', 'run-hook.sh'), 'utf-8')).toContain('PLUR_FOLDER_SCOPE=project')
  })

  describe('automatic memory', () => {
    const SCRIPT = join(PLUGIN, 'scripts', 'run-hook.sh')
    const hooks = () => JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf-8')).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>
    const commands = () => Object.values(hooks()).flat().flatMap(g => g.hooks.map(h => h.command))

    it('ships the hooks that make memory automatic', () => {
      const all = commands().join('\n')
      expect(all).toContain('hook-inject')
      expect(all).toContain('hook-inject --rehydrate')
      expect(all).toContain('hook-session-end')
      expect(hooks().UserPromptSubmit).toBeDefined()
    })

    it('leaves out hooks that block or nudge other work', () => {
      const all = commands().join('\n')
      for (const h of ['hook-session-guard', 'hook-learn-check', 'hook-observe']) expect(all).not.toContain(h)
    })

    it('runs every hook through the bundled script', () => {
      for (const c of commands()) expect(c.startsWith('"${CLAUDE_PLUGIN_ROOT}"/scripts/run-hook.sh ')).toBe(true)
    })

    it('offers one switch, on by default', () => {
      const o = manifest().userConfig.automatic_memory
      expect(o.type).toBe('boolean')
      expect(o.default).toBe(true)
    })

    it('falls back to the same value as the manifest default', () => {
      // Claude Code leaves the variable empty for a setting at its default, so
      // flipping the default without the script would leave hooks running.
      const fallback = String(manifest().userConfig.automatic_memory.default)
      expect(readFileSync(SCRIPT, 'utf-8')).toContain(`AUTOMATIC_MEMORY:-${fallback}}`)
    })

    type Setup = (home: string) => Record<string, string> | void

    function run(env: Record<string, string>, setup?: Setup): string {
      dir = mkdtempSync(join(tmpdir(), 'plur-hook-'))
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const log = join(dir, 'called')
      writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" > "${log}"\n`, { mode: 0o755 })
      const extra = setup?.(dir) ?? {}
      execFileSync('sh', [SCRIPT, 'hook-inject'], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ...env, ...extra } })
      return existsSync(log) ? readFileSync(log, 'utf-8').trim() : ''
    }

    /** What `plur init` leaves behind whether or not its hooks are still there. */
    function leaveMarker(home: string): void {
      mkdirSync(join(home, '.plur', 'bin'), { recursive: true })
      writeFileSync(join(home, '.plur', 'bin', 'plur-hook.meta.json'), '{}')
    }

    function writeSettings(path: string, hook: object): void {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 20, ...hook }] }] } }))
    }

    const SHELL_FORM = { command: '/home/u/.plur/bin/plur-hook hook-inject' }
    const EXEC_FORM = { command: '/usr/bin/node', args: ['/opt/plur/dist/index.js', 'hook-inject'] }
    const OTHER_HOOK = { command: '/usr/local/bin/my-own-hook' }
    const ON = { CLAUDE_PLUGIN_OPTION_AUTOMATIC_MEMORY: 'true' }
    const PINNED = `-y @plur-ai/cli@${MCP_VERSION} hook-inject`
    let dir = ''
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

    it('runs the pinned CLI when the switch is on', () => {
      expect(run({ CLAUDE_PLUGIN_OPTION_AUTOMATIC_MEMORY: 'true' })).toBe(`-y @plur-ai/cli@${MCP_VERSION} hook-inject`)
    })

    it('does nothing when the switch is off', () => {
      expect(run({ CLAUDE_PLUGIN_OPTION_AUTOMATIC_MEMORY: 'false' })).toBe('')
    })

    it.each([['shell', SHELL_FORM], ['exec', EXEC_FORM]])('leaves it to hooks plur init installed in user settings (%s form)', (_, hook) => {
      expect(run(ON, h => { leaveMarker(h); writeSettings(join(h, '.claude', 'settings.json'), hook) })).toBe('')
    })

    it('leaves it to hooks installed for this project alone', () => {
      expect(run(ON, h => { writeSettings(join(h, 'repo', '.claude', 'settings.json'), SHELL_FORM); return { CLAUDE_PROJECT_DIR: join(h, 'repo') } })).toBe('')
    })

    it('leaves it to hooks in a project\'s local settings', () => {
      expect(run(ON, h => { writeSettings(join(h, 'repo', '.claude', 'settings.local.json'), SHELL_FORM); return { CLAUDE_PROJECT_DIR: join(h, 'repo') } })).toBe('')
    })

    it('looks in the settings Claude Code actually reads when the config folder moved', () => {
      expect(run(ON, h => { writeSettings(join(h, 'cfg', 'settings.json'), SHELL_FORM); return { CLAUDE_CONFIG_DIR: join(h, 'cfg') } })).toBe('')
      // ~/.claude is not read in that case, so hooks left there do not run.
      expect(run(ON, h => { writeSettings(join(h, '.claude', 'settings.json'), SHELL_FORM); return { CLAUDE_CONFIG_DIR: join(h, 'cfg'), CLAUDE_PROJECT_DIR: join(h, 'repo') } })).toBe(PINNED)
    })

    it('still runs when plur init\'s marker outlived its hooks', () => {
      expect(run(ON, leaveMarker)).toBe(PINNED)
      expect(run(ON, h => { leaveMarker(h); writeSettings(join(h, '.claude', 'settings.json'), OTHER_HOOK) })).toBe(PINNED)
    })

    it('still runs in a project other than the one holding project-only hooks', () => {
      expect(run(ON, h => { leaveMarker(h); writeSettings(join(h, 'other', '.claude', 'settings.json'), SHELL_FORM); mkdirSync(join(h, 'repo')); return { CLAUDE_PROJECT_DIR: join(h, 'repo') } })).toBe(PINNED)
    })

    it('tells the reader the switch exists', () => {
      expect(readFileSync(join(PLUGIN, 'README.md'), 'utf-8')).toContain('automatic_memory')
    })
  })

  it('has a README of at least 40 words outside code blocks, disclosing what it runs and sends', () => {
    const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf-8')
    expect(readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40)
    for (const word of ['npm', 'Hugging Face', 'PLUR_TELEMETRY', '~/.plur', 'Privacy']) expect(readme).toContain(word)
  })

  it('stays inside the validator file limits', () => {
    const files = walk(PLUGIN)
    expect(files.length).toBeLessThanOrEqual(512)
    for (const f of files) {
      expect(f.endsWith('.DS_Store'), relative(PLUGIN, f)).toBe(false)
      expect(statSync(f).size, relative(PLUGIN, f)).toBeLessThan(256 * 1024)
      expect(statSync(f).isSymbolicLink(), relative(PLUGIN, f)).toBe(false)
    }
    expect(existsSync(join(PLUGIN, 'LICENSE'))).toBe(true)
  })

  it.each(STEERING)('skills contain no steering: %s', pattern => {
    for (const f of walk(join(PLUGIN, 'skills'))) expect(readFileSync(f, 'utf-8'), relative(PLUGIN, f)).not.toMatch(pattern)
  })
})

describe('release script keeps the plugin pinned', () => {
  it('bumps the plugin manifest and its npx pin', () => {
    const release = readFileSync(join(REPO, 'scripts', 'release.sh'), 'utf-8')
    expect(release).toContain('plugins/plur/.claude-plugin/plugin.json')
    expect(release).toContain('plugins/plur/.mcp.json')
    expect(release).toContain('plugins/plur/scripts/run-hook.sh')
  })
})
