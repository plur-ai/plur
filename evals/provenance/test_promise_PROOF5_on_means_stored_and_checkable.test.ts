// PROOF-5: When I turn Swarm storage on, ending a session stores that session's list on
// Swarm, and with the reference anyone can fetch it, check the notary's signature and
// that the list is unchanged, and check each memory against a store that holds it.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur, SwarmGatewayStore } from '../../packages/core/src/index.js'
import { checkNotarySignature } from '../../packages/cli/src/lib/notary.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { startGatewayStub, type GatewayStub } from '../helpers/provenance-gateway-stub.js'
import { createHash } from 'node:crypto'

describe('PROOF-5 with Swarm storage on, the session list is stored and checkable by reference', () => {
  let s: McpSession | undefined
  let gw: GatewayStub | undefined
  let copy: string | undefined
  afterEach(async () => { await s?.close(); await gw?.stop(); if (copy) rmSync(copy, { recursive: true, force: true }) })

  it('stored at session end; fetched by reference it checks out, and a later edit is caught', async () => {
    gw = await startGatewayStub()
    s = await mcpSession({ config: `backend: yaml\nreceipts:\n  store: swarm\n  gateway_url: ${gw.url}\n` })
    const start = await s.call('plur_session_start', { task: 'prepare the release notes' })
    const session_id = start.json?.session_id
    expect(session_id, 'precondition: a session started').toBeTruthy()
    const learned = await s.call('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id, rationale: 'customers read them' })
    const id = learned.json?.id
    expect(id, `precondition: the memory was saved (${learned.text})`).toBeTruthy()
    const end = await s.call('plur_session_end', { summary: 'Wrote release notes.', engram_suggestions: [], session_id })
    expect(end.isError, `session end failed: ${end.text}`).toBe(false)

    const anchor = end.json?.anchor
    expect(anchor?.error, `the upload failed: ${anchor?.error}`).toBeUndefined()
    expect(anchor?.reference, 'session end did not report where the list was stored').toMatch(/^[0-9a-f]{64}$/)
    expect(gw.docs.has(anchor.reference), 'the reported reference is not what the gateway stored').toBe(true)

    // Anyone, by reference: fetch, check bytes and signature.
    const store = new SwarmGatewayStore(gw.url)
    const doc = await store.document(anchor.reference)
    const bytes = Buffer.from(String(doc.data), 'base64')
    expect(createHash('sha256').update(bytes).digest('hex'), 'the stored list does not match its own content hash').toBe(doc.content_hash)
    const notary = checkNotarySignature(doc.signatures![0], doc)
    expect(notary.signature_ok, `the notary signature does not check (${JSON.stringify(notary)})`).toBe(true)
    expect(notary.recovered?.toLowerCase(), 'the signature was not made by the gateway notary').toBe(gw.notary.toLowerCase())

    const manifest = JSON.parse(bytes.toString('utf8'))
    expect(manifest.session_id, 'the stored list is for another session').toBe(session_id)
    expect(manifest.engrams.map((e: any) => e.id), 'the memory saved in the session is not on the stored list').toContain(id)
    expect(bytes.toString('utf8').includes('Release notes are written'), 'the stored list carries memory text').toBe(false)

    // Another machine holding the same memories: matches; after an edit: changed.
    copy = mkdtempSync(join(tmpdir(), 'plur-eval-proof5-'))
    cpSync(s.dir, copy, { recursive: true })
    const other = new Plur({ path: copy, autoDiscover: false })
    await other.ready()
    const ok = await other.verifyManifest(manifest)
    expect(ok.results.find(r => r.id === id)?.status, 'a copy of the same memory does not match the stored list').toBe('MATCH')
    const row = await other.getById(id)
    expect(row, 'precondition: the copy holds the memory').toBeTruthy()
    await other.updateEngram({ ...row!, rationale: 'customers skim them' })
    const after = await new Plur({ path: copy, autoDiscover: false }).verifyManifest(manifest)
    expect(after.results.find(r => r.id === id)?.status, 'an edit made after the session was not caught').toBe('CHANGED')
  })

  it('a failed upload is reported and does not fail the session end', async () => {
    s = await mcpSession({ config: 'backend: yaml\nreceipts:\n  store: swarm\n  gateway_url: http://127.0.0.1:9\n' })
    const start = await s.call('plur_session_start', { task: 'prepare the release notes' })
    const session_id = start.json?.session_id
    await s.call('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id })
    const end = await s.call('plur_session_end', { summary: 'Wrote release notes.', engram_suggestions: [], session_id })
    expect(end.isError, 'an unreachable gateway made session end fail').toBe(false)
    expect(typeof end.json?.anchor?.error, 'an upload that could not happen was not reported').toBe('string')
  })
})
