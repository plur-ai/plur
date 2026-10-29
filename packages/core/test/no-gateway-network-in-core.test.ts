/**
 * @plur-ai/core holds no provenance-gateway client and gains no new network
 * code (0.23 code review, finding 10; owner decision 2026-10-28: PLUR speaks
 * only HTTP to the provenance gateway, from the CLI and MCP layers, and no
 * PLUR repo carries a Swarm or Bee client).
 *
 * The files below already made network calls before 0.23 (remote stores, the
 * optional OpenAI embedder, the version check, pack downloads, remote recall,
 * opt-in telemetry). They are
 * pinned so that a new network call anywhere else in core fails here, and so
 * that removing one shrinks the list on purpose.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const PRE_EXISTING_NETWORK = new Set([
  'version-check.ts',
  'embedders/openai.ts',
  'packs.ts',
  'store/remote-store.ts',
  'remote-recall.ts',
  'telemetry-flush.ts',
  'telemetry-miss-signal.ts',
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

const NETWORK = /\bfetch\s*\(|\?\?\s*fetch\b|(?<![=!<>])=\s*fetch\b|globalThis\.fetch\b|from ['"](?:node:)?https?['"]|require\(['"](?:node:)?https?['"]\)|from ['"](?:node:)?net['"]/
const GATEWAY = /provenance-gateway|\/api\/v1\/data\b|\/api\/v1\/pool\b|\/api\/v1\/notary\b|bee-js|@ethersphere/

describe('core carries no provenance-gateway client', () => {
  it('no core source file references the gateway or a Swarm/Bee library', () => {
    const hits = files(SRC).filter(f => GATEWAY.test(readFileSync(f, 'utf8'))).map(f => relative(SRC, f))
    expect(hits, `gateway code in core: ${hits.join(', ')}`).toEqual([])
  })

  it('no new network call in core beyond the pinned pre-0.23 files', () => {
    const hits = files(SRC).filter(f => NETWORK.test(readFileSync(f, 'utf8'))).map(f => relative(SRC, f))
    expect(hits.filter(h => !PRE_EXISTING_NETWORK.has(h)), 'network code added to core').toEqual([])
  })
})
