// TEAM-5: With no internet at all, I can still save and find memories, and PLUR makes no network calls.
//
// The network is blocked for the whole run: `fetch`, raw sockets and DNS
// lookups all record the attempt and fail. No offline switch is set (the hub's
// and PLUR's own are cleared): with no internet, nobody tells PLUR so. A personal store (no team server) then saves, searches (keyword and
// hybrid, a hit and a miss) and injects. Every one must work, and the
// recorders must be empty at the end.
//
// Not covered: the shipped embedding model (this eval uses embeddings off and
// a deterministic stub, by the slice rules), so a model download attempt on a
// fresh install is not exercised here.
import dns from 'node:dns'
import net from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { callTool, connectMcp, writeFolderMap } from '../helpers/privacy-folders-team-mcp.js'

describe('TEAM-5 with no internet, saving and finding memories works and makes no network calls', () => {
  let s: TempStore | undefined
  const attempts: string[] = []
  const saved: { fetch: typeof globalThis.fetch; connect: typeof net.Socket.prototype.connect; lookup: typeof dns.lookup; env: Record<string, string | undefined> } = {} as any

  beforeEach(() => {
    attempts.length = 0
    saved.fetch = globalThis.fetch
    saved.connect = net.Socket.prototype.connect
    saved.lookup = dns.lookup
    // No offline hint of any kind: a user with no internet sets none of these, so
    // PLUR must make no call without being told (fourth-audit follow-up: an eval
    // that sets the hub's offline switch hands the product a signal to read).
    const HINTS = ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'PLUR_OFFLINE', 'PLUR_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER']
    saved.env = Object.fromEntries(HINTS.map(k => [k, process.env[k]]))
    for (const k of HINTS) delete process.env[k]
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(`fetch ${String((input as { url?: string })?.url ?? input)}`)
      throw new TypeError('fetch failed: the network is blocked in this eval')
    }) as typeof globalThis.fetch
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      attempts.push(`socket connect ${JSON.stringify(args[0])}`)
      throw new Error('connect blocked: the network is blocked in this eval')
    } as typeof net.Socket.prototype.connect
    ;(dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
      attempts.push(`dns lookup ${host}`)
      const cb = rest.find(r => typeof r === 'function') as ((e: Error) => void) | undefined
      cb?.(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }))
    }
  })

  afterEach(() => {
    globalThis.fetch = saved.fetch
    net.Socket.prototype.connect = saved.connect
    ;(dns as { lookup: unknown }).lookup = saved.lookup
    for (const [k, v] of Object.entries(saved.env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.restoreAllMocks()
    s?.cleanup(); s = undefined
  })

  for (const embedder of ['off', 'bag-of-words'] as const) {
    it(`save, search, inject (embedder: ${embedder})`, async () => {
      s = await tempStore({ embedder })
      const a = await s.plur.learn('the backup job runs at two in the morning', { scope: 'global' })
      const b = await s.plur.learnRouted('restore drills happen on the first Friday of each quarter', { scope: 'project:ops' })

      const keyword = (await s.plur.recall('backup job morning')).map(e => e.id)
      const hybrid = (await s.plur.recallHybrid('restore drills quarter', { scope: 'project:ops' })).map(e => e.id)
      // A search that finds nothing useful (the path that could report a miss).
      await s.plur.recallHybrid('zzqx unrelated nonsense words')
      const injected = await s.plur.inject('when do the backup job and restore drills run', { scope: 'project:ops', budget: 2000 })
      const injectedHybrid = await s.plur.injectHybrid('when do the backup job and restore drills run', { scope: 'project:ops', budget: 2000 })
      // Let any fire-and-forget background work start before checking.
      await new Promise(r => setTimeout(r, 200))

      expect(keyword, 'keyword search should find the saved memory with no internet').toContain(a.id)
      expect(hybrid, 'hybrid search should find the saved memory with no internet').toContain(b.id)
      expect(injected.injected_ids, 'inject should give the saved memories with no internet').toEqual(expect.arrayContaining([a.id, b.id]))
      expect(injectedHybrid.injected_ids, 'hybrid inject should give the saved memories with no internet').toEqual(expect.arrayContaining([a.id, b.id]))
      expect(attempts, `expected PLUR to make no network calls; it tried: ${JSON.stringify(attempts)}`).toEqual([])
    })
  }

  it('through the MCP server, as an editor uses PLUR', async () => {
    s = await tempStore({ embedder: 'off' })
    // The editor's folder is one where I turned memory on.
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-team5-work-')))
    writeFolderMap(s.dir, [{ path: work, plur: 'on' }])
    vi.spyOn(process, 'cwd').mockReturnValue(work)
    const conn = await connectMcp(s.plur)
    try {
      const learned = await callTool(conn.client, 'plur_learn', { statement: 'the backup job runs at two in the morning', scope: 'global' })
      expect(learned.raw.isError, `plur_learn should work with no internet; got ${learned.text.slice(0, 300)}`).not.toBe(true)
      const found = await callTool(conn.client, 'plur_recall_hybrid', { query: 'backup job morning' })
      expect(found.text, 'plur_recall_hybrid should find the saved memory with no internet').toContain('backup job runs at two')
      const injected = await callTool(conn.client, 'plur_inject_hybrid', { task: 'backup job runs at two in the morning' })
      expect(injected.json?.count, `plur_inject_hybrid should give the saved memory with no internet; got ${injected.text.slice(0, 300)}`).toBeGreaterThan(0)
      await new Promise(r => setTimeout(r, 200))
    } finally { await conn.close(); rmSync(work, { recursive: true, force: true }) }
    expect(attempts, `expected PLUR to make no network calls; it tried: ${JSON.stringify(attempts)}`).toEqual([])
  })
})
