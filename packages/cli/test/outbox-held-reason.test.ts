/**
 * `plur outbox` says why a queued write is held on this machine (#1581 audit
 * L1): an entry whose push claim could not be recorded is `retrying`, and the
 * listing names the reason and what to check, instead of a bare network error.
 */
import { describe, it, expect } from 'vitest'
import { classifyOutboxFailure, OUTBOX_CLAIM_ERROR_PREFIX } from '@plur-ai/core'
import { formatOutboxText } from '../src/commands/outbox.js'

describe('plur outbox names why an entry is held', () => {
  it('a claim error is listed as held, with the reason and the next step', () => {
    const last_error = `${OUTBOX_CLAIM_ERROR_PREFIX}EACCES: permission denied, mkdir '/x/cache/outbox-claims'`
    const v = classifyOutboxFailure({ last_error, has_store: true, scope: 'group:test' })
    expect(v.state).toBe('retrying')
    const text = formatOutboxText([{
      id: 'ENG-2026-10-04-001', kind: 'push', target_scope: 'group:test', queued_at: new Date().toISOString(),
      attempt_count: 1, last_error, age_days: 0, ...v,
    } as any])
    expect(text).toContain('held: its push claim could not be recorded on this machine')
    expect(text).toContain('1 queued write(s) are held on this machine')
    expect(text).toContain('cache/outbox-claims')
  })

  it('a plain network error is not reported as held', () => {
    const v = classifyOutboxFailure({ last_error: 'Remote store append failed: 503 down', has_store: true, scope: 'group:test' })
    const text = formatOutboxText([{
      id: 'ENG-2026-10-04-002', kind: 'push', target_scope: 'group:test', queued_at: new Date().toISOString(),
      attempt_count: 1, last_error: 'Remote store append failed: 503 down', age_days: 0, ...v,
    } as any])
    expect(text).not.toContain('held')
  })
})
