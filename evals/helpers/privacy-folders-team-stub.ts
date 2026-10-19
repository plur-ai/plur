// Team-store fixtures for the privacy, folders and team evals (slice
// privacy-folders-team). A real in-process HTTP stub (no fetch mocking) that
// counts every request it receives, and a throwaway PLUR store that has it
// mounted as a team store.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../../packages/core/src/index.js'
import { _resetRemoteHostBreaker } from '../../packages/core/src/store/remote-store.js'
import { setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'
import { StubServer } from '../../packages/core/test/helpers/stub-server.js'

export const TEAM_TOKEN = 'eval-team-token'
/** A team (shared) scope in org `acme`. */
export const TEAM_SCOPE = 'group:acme/engineering'

export interface TeamStub {
  stub: StubServer
  url: string
  /** Every request received, as "METHOD /path?query", in arrival order. */
  hits: string[]
  stop(): Promise<void>
}

/** Start the stub team server and record every request it receives. */
export async function startTeamStub(): Promise<TeamStub> {
  const stub = new StubServer(TEAM_TOKEN)
  const { url } = await stub.start()
  const hits: string[] = []
  const original = (stub as any).handleRequest.bind(stub)
  ;(stub as any).handleRequest = (req: any, res: any) => { hits.push(`${req.method} ${req.url}`); original(req, res) }
  stub.setMe({ username: 'eval-user', org_id: 'acme', role: 'developer', scopes: [TEAM_SCOPE] })
  return { stub, url, hits, stop: () => stub.stop() }
}

/** Clear the stub's data and counters between tests (keeps the same port). */
export function resetTeamStub(t: TeamStub): void {
  t.stub.reset()
  t.stub.setMe({ username: 'eval-user', org_id: 'acme', role: 'developer', scopes: [TEAM_SCOPE] })
  t.hits.length = 0
}

export interface TeamStore {
  plur: Plur
  dir: string
  cleanup(): void
}

/**
 * A fresh store with one team store mounted at `url` (scope TEAM_SCOPE),
 * embeddings off, no auto-discovery. Resets the process-wide host breaker so
 * an earlier test's "server down" does not leak into this one.
 */
export async function teamStore(url: string, opts: { scope?: string; extraConfig?: string } = {}): Promise<TeamStore> {
  _resetRemoteHostBreaker()
  setEmbeddingsEnabled(false, 'eval: embeddings off')
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-team-'))
  writeFileSync(
    join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TEAM_TOKEN}"\n    scope: "${opts.scope ?? TEAM_SCOPE}"\n` +
      (opts.extraConfig ?? ''),
  )
  const plur = new Plur({ path: dir, autoDiscover: false })
  await plur.ready()
  return { plur, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Run with live remote recall switched on (setup.ts turns it off by default). */
export async function withRemoteRecall<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PLUR_REMOTE_RECALL
  process.env.PLUR_REMOTE_RECALL = 'on'
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.PLUR_REMOTE_RECALL
    else process.env.PLUR_REMOTE_RECALL = prev
  }
}

/** Poll until `cond` holds or `ms` passes; returns whether it held. */
export async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return cond()
}
