// Runs before every eval file. Three jobs:
//  1. Isolation: no eval may read or write the real ~/.plur. Hooks and some
//     loggers use homedir() and ignore PLUR_PATH, so HOME is moved too.
//  2. No network and no operator settings: the MCP server checks npm for updates
//     on start, and an operator's PLUR_REMOTE_RECALL / PLUR_EMBEDDER / PLUR_RERANKER
//     would change what an eval measures (independent audit 2026-10-17). fetch to
//     anything but this machine fails here; an eval that needs a remote opts in
//     with the in-process stub server on 127.0.0.1.
//  3. A clean process state between tests: the embedder cache is process-wide.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach } from 'vitest'
import { resetEmbedder, setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'

const home = mkdtempSync(join(tmpdir(), 'plur-evals-home-'))
const realHome = process.env.HOME
process.env.HOME = home
process.env.USERPROFILE = home
process.env.PLUR_PATH = join(home, '.plur')
// Remote recall is opt-in per eval (team evals use the in-process stub server).
process.env.PLUR_REMOTE_RECALL = 'off'
for (const k of ['PLUR_EMBEDDER', 'PLUR_RERANKER', 'PLUR_RECALL_DEADLINE_MS']) delete process.env[k]

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!LOCAL.has(url.hostname)) {
    return Promise.reject(new Error(`eval network guard: a request to ${url.host} was blocked (evals never reach the network)`))
  }
  return realFetch(input, init)
}) as typeof fetch

afterEach(() => {
  resetEmbedder()
  setEmbeddingsEnabled(true)
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})
