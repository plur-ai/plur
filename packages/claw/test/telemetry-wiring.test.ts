import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildHeartbeatPayload } from '@plur-ai/core'
import { CLAW_VERSION } from '../src/version.js'

/**
 * Claw uses core's telemetry modules — it must not carry copies (2026-09
 * audit). The copies had drifted: #562 pointed claw's heartbeat at
 * `heartbeat.plur-ai.org`, which does not resolve, while core (and so MCP
 * and the CLI) kept `plur.ai/v1/heartbeat`, which does. Every claw heartbeat
 * since then was lost. One module means one endpoint.
 */
describe('claw telemetry wiring', () => {
  const src = join(__dirname, '..', 'src')

  it('carries no telemetry module of its own', () => {
    const copies = readdirSync(src).filter(f => /^telemetry/.test(f))
    expect(copies).toEqual([])
    expect(existsSync(join(src, 'telemetry-flush.ts'))).toBe(false)
  })

  it('imports recordEvent / flushIfNeeded / registerFlushOnExit from @plur-ai/core', () => {
    for (const f of ['index.ts', 'context-engine.ts', 'setup.ts']) {
      const text = readFileSync(join(src, f), 'utf8')
      expect(text, f).not.toMatch(/from '\.\/telemetry/)
    }
    const index = readFileSync(join(src, 'index.ts'), 'utf8')
    expect(index).toMatch(/import \{[^}]*\bflushIfNeeded\b[^}]*\} from '@plur-ai\/core'/)
    expect(index).toMatch(/import \{[^}]*\bregisterFlushOnExit\b[^}]*\} from '@plur-ai\/core'/)
  })

  it('every flush call reports the claw version, not core\'s', () => {
    // A bare `flushIfNeeded({})` would make the heartbeat say it came from
    // @plur-ai/core at core's version.
    for (const f of ['index.ts', 'context-engine.ts']) {
      const text = readFileSync(join(src, f), 'utf8')
      const calls = text.match(/(?:flushIfNeeded|registerFlushOnExit)\(([^)]*)\)/g) ?? []
      expect(calls.length, `${f} should call the flush helpers`).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call, f).not.toMatch(/\(\s*\{\s*\}\s*\)/)
        expect(call, f).toMatch(/TELEMETRY|packageVersion: CLAW_VERSION/)
      }
    }
    const payload = buildHeartbeatPayload(
      { installId: 'i', date: '2026-09-03', learn: 1, recall: 2, session: 3 },
      { packageVersion: CLAW_VERSION },
    )
    expect(payload.version).toBe(CLAW_VERSION)
  })
})
