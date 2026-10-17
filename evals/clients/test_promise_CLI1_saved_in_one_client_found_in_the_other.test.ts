// CLI-1: A memory saved through one way of using PLUR (the CLI or the MCP
// server) is found through the other, and automatic loading picks it up
// without a manual recall.
//
// One PLUR home, used two ways, as on a real machine: the `plur` CLI run from
// source as its own process, and the MCP server (in-process, a real MCP client)
// on the same store. Then the Claude Code session-start hook (hook-inject, run
// from source as its own process, as evals/hooks drives it) for a new session.
// Keyword search only (embeddings off), deterministic.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'
import { hookHome, prompt, runSource, seed, type HookHome } from '../helpers/agent-tools-hooks-cli.js'
import { callTool, connectMcp, offlineFetch } from '../helpers/privacy-folders-team-mcp.js'

const VIA_CLI = 'Invoices for the Nordic region are approved by the finance lead on Fridays'
const VIA_MCP = 'Invoices above ten thousand euros need a second approver from legal'

describe('CLI-1 a memory saved through the CLI or the MCP server is found through the other, and loaded automatically', () => {
  let h: HookHome | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net?.restore(); net = undefined
    h?.cleanup(); h = undefined
  })

  it('CLI save -> MCP recall; MCP save -> CLI recall; the session-start hook loads both', async () => {
    h = hookHome()
    const store = h.env.PLUR_PATH!
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\n')

    // 1. Saved through the CLI.
    seed(h, VIA_CLI)

    // 2. Found through the MCP server on the same machine.
    setEmbeddingsEnabled(false, 'eval: keyword search only')
    net = offlineFetch()
    const plur = new Plur({ path: store, autoDiscover: false })
    vi.spyOn(process, 'cwd').mockReturnValue(h.home)
    const conn = await connectMcp(plur)
    closers.push(conn.close)
    const recalled = await callTool(conn.client, 'plur_recall', { query: 'Nordic invoices approved finance lead' })
    expect(recalled.json?.plur, `precondition: memory is on in this folder; got ${recalled.text.slice(0, 300)}`).toBeUndefined()
    expect(recalled.text, `expected the MCP server to find the memory saved through the CLI; got ${recalled.text.slice(0, 500)}`).toContain(VIA_CLI)

    // 3. Saved through the MCP server, found through the CLI.
    const learned = await callTool(conn.client, 'plur_learn', { statement: VIA_MCP, scope: 'global' })
    expect(learned.raw.isError, `plur_learn through MCP failed: ${learned.text}`).not.toBe(true)
    const cli = runSource('cli', ['recall', 'invoices second approver legal'], { env: h.env, cwd: h.home, timeoutMs: 90_000 })
    expect(cli.status, `plur recall failed: ${cli.stderr.slice(0, 400)}`).toBe(0)
    expect(cli.stdout, `expected plur recall to find the memory saved through the MCP server; it printed: ${cli.stdout.slice(0, 500)}`).toContain(VIA_MCP)

    // 4. Loaded automatically: a new session's first message carries both, unasked.
    const first = prompt(h, 'cli1-new-session', 'Who needs to approve the invoices for the Nordic region, and when is a second approver needed?')
    expect(first.status, `the session-start hook failed: ${first.stderr.slice(0, 400)}`).toBe(0)
    expect(first.context, `expected the first message to carry the memory saved through the MCP server; it got: "${first.context.slice(0, 800)}"`).toContain(VIA_MCP)
    expect(first.context, `expected the first message to carry the memory saved through the CLI; it got: "${first.context.slice(0, 800)}"`).toContain(VIA_CLI)
  }, 240_000)
})
