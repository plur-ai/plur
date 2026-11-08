import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
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

  it('installs no hooks', () => {
    expect(existsSync(join(PLUGIN, 'hooks'))).toBe(false)
    expect(manifest().hooks).toBeUndefined()
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
  })
})
