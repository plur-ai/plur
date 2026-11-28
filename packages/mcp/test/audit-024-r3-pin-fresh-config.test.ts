/**
 * 0.24 review, round 3 (MCP side): the MCP server is a long-lived process.
 * When the owner sets `pinning.agents: deny` in config.yaml while it runs,
 * the very next plur_pin is refused, not only the call after it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const tool = (name: string) => getToolDefinitions('full').find(t => t.name === name)!
const BASE = 'embeddings:\n  enabled: false\nindex: false\n'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('round 3: plur_pin follows config.yaml edited while the server runs', () => {
  it('deny set mid-process: the next plur_pin is refused and the engram stays unpinned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-r3-fresh-'))
    dirs.push(dir)
    const file = join(dir, 'config.yaml')
    writeFileSync(file, BASE)
    // The MCP server runs as an agent (server.ts sets the default actor).
    const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    const learned = await tool('plur_learn').handler({ statement: 'Use tabs for indentation in this repo', scope: 'global' }, plur) as any
    await tool('plur_recall').handler({ query: 'indentation' }, plur)
    const before = statSync(file).mtimeMs
    writeFileSync(file, `${BASE}pinning:\n  agents: deny\n`)
    const later = new Date(before + 5000)
    utimesSync(file, later, later)
    const res = await tool('plur_pin').handler({ id: learned.id, pinned: true }, plur) as any
    expect(res.error).toBe('pin_denied')
    expect(res.pinned).not.toBe(true)
    expect((await plur.getById(learned.id))?.pinned).not.toBe(true)
  })
})
