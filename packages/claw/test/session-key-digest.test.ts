/**
 * The OpenClaw session key (e.g. `user:john:agent:helper`) names a person; the
 * engram records a digest of it in sources[].session_id, never the key itself,
 * because learnRouted sends the engram to team stores (0.23 audit, finding 20).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PlurContextEngine } from '../src/context-engine.js'

describe('claw records a digest of the session key', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sources[].session_id is oc:<sha256 prefix>, not the raw key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-claw-digest-'))
    const engine = new PlurContextEngine({ path: dir })
    const spy = vi.spyOn(engine.plur, 'learnRouted')
    const key = 'user:john:agent:helper'
    await engine.ingest({ sessionId: 's1', sessionKey: key, message: { role: 'user' as const, content: 'No, always use snake_case for the API responses in this project' } })
    await engine.settle()
    expect(spy).toHaveBeenCalled()
    const ctx = spy.mock.calls[0][1] as { session_id?: string }
    expect(ctx.session_id).not.toContain('john')
    expect(ctx.session_id).toMatch(/^oc:[0-9a-f]{16}$/)
  })
})
