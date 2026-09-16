/**
 * #1198 — every adapter, not just Claude Code, reaches PLUR Enterprise.
 *
 * `hook-inject` was the ONLY consumer of `remote_project` in the codebase. The
 * codex, cursor and antigravity hooks read `.plur.yaml` for `scope` and dropped
 * the remote fields, so a customer following the documented `plur init-remote`
 * onboarding got team memory on Claude Code and silence everywhere else — with
 * no error to explain it.
 *
 * The trap: closing that by copying hook-inject's old block into each adapter
 * would have reproduced #1196 (a cloned repo naming its own host AND supplying
 * its own token) in four more places. So both halves are asserted here per
 * adapter — it dials when the directory is trusted, and refuses, loudly, when
 * it is not. A future adapter that gains the capability without the gate fails
 * the second half.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import { trustDirectory } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

interface Adapter {
  name: string
  hook: string
  input: (repo: string) => object
}

// Each adapter's minimal payload that reaches the injection path. agy needs
// invocationNum 0: a later invocation with no transcript is neither the first
// turn nor a new one, so it returns before injecting.
const ADAPTERS: Adapter[] = [
  { name: 'codex inject', hook: 'hook-codex-inject', input: () => ({ session_id: 's1', prompt: 'how do we deploy' }) },
  { name: 'codex session-start', hook: 'hook-codex-session-start', input: () => ({ session_id: 's1' }) },
  { name: 'antigravity', hook: 'hook-agy-pre-invocation', input: (repo) => ({ conversationId: 'c1', invocationNum: 0, workspacePaths: [repo] }) },
]

describe('adapters reach PLUR Enterprise, gated on directory trust (#1198)', () => {
  let dir: string
  let repo: string
  let server: Server
  let hits: string[]
  let port: number
  let tmpIdx = 0

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-adapter-'))
    repo = join(dir, 'project')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(dir, '.plur'), { recursive: true })

    hits = []
    server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        hits.push(req.url ?? '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"engrams":[]}')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    writeFileSync(join(repo, '.plur.yaml'), [
      'scope: project:acme/app',
      `remote_url: http://127.0.0.1:${port}`,
      'remote_token: enterprise-token',
      'remote_scopes:',
      '  - project:acme/app',
      '',
    ].join('\n'))
  })

  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
  })

  function run(hook: string, input: object): string {
    const tmp = join(dir, `tmp-${tmpIdx++}`)
    mkdirSync(tmp, { recursive: true })
    const r = runCli('node', [CLI, hook], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: tmp, PLUR_PATH: join(dir, '.plur') },
      cwd: repo,
    })
    return (r.stdout ?? '') + (r.stderr ?? '')
  }

  async function settle(): Promise<void> {
    // The dial is fired with a short timeout and can outlive the hook process,
    // so wait for the hit rather than asserting immediately.
    for (let i = 0; i < 40 && hits.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100))
    }
  }

  // Cursor is deliberately absent from ADAPTERS. Its only injecting hook is
  // bounded at 10s with no async option, so it stays BM25-only (PR #502), and
  // the remote leg rides inside injectHybrid — so Cursor cannot reach a remote
  // store today. Asserted below as the known gap rather than left to look like
  // an oversight. Tracked in #1200.
  it('cursor: does not dial, because its hook must stay BM25-only (#1200)', async () => {
    trustDirectory(repo, join(dir, '.plur'))
    run('hook-cursor-session-start', { conversation_id: 'c1' })
    await new Promise(r => setTimeout(r, 1500))
    expect(hits).toHaveLength(0)
  })

  for (const a of ADAPTERS) {
    it(`${a.name}: dials the enterprise host when the directory is trusted`, async () => {
      trustDirectory(repo, join(dir, '.plur'))
      run(a.hook, a.input(repo))
      await settle()
      expect(hits.length).toBeGreaterThan(0)
    })

    it(`${a.name}: refuses, and says so, when the directory is not trusted`, async () => {
      const out = run(a.hook, a.input(repo))
      await new Promise(r => setTimeout(r, 1500))
      expect(hits).toHaveLength(0)
      expect(out).toMatch(/Ignored remote memory settings|plur trust /)
    })
  }
})
