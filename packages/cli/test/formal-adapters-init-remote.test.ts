/**
 * Formal-verification run (Adapters cluster, candidate 8b, cli#9): the
 * `.plur.yaml` rewrite `plur init-remote` performs is idempotent — running it
 * twice with the same inputs leaves the file as one run left it — and it only
 * ever replaces PLUR's own top-level remote keys.
 */
import { describe, it, expect } from 'vitest'
import { _buildConfigBody as build, _readRemoteFromContent as readRemote } from '../src/commands/init-remote.js'

describe('init-remote .plur.yaml rewrite (formal Adapters #8b)', () => {
  const base = 'scope: project:demo\ndomain: demo.app\n'

  it('is idempotent: a second and third run change nothing', () => {
    const once = build(base, 'https://plur.example', 'tok', ['group:acme/eng'])
    const twice = build(once, 'https://plur.example', 'tok', ['group:acme/eng'])
    expect(twice).toBe(once)
    expect(build(twice, 'https://plur.example', 'tok', ['group:acme/eng'])).toBe(once)
    expect(once.match(/PLUR Enterprise remote/g)).toHaveLength(1)
  })

  it('a re-run with new values replaces the old ones', () => {
    const once = build(base, 'https://old.example', 'old', ['group:acme/eng'])
    const again = build(once, 'https://new.example', 'new', undefined)
    expect(again).toBe(build(base, 'https://new.example', 'new', undefined))
  })

  it('keeps a user key that merely CONTAINS remote_url nested under another key', () => {
    const user = base + 'mirror:\n  remote_url: https://mirror.example\n'
    const out = build(user, 'https://plur.example', 'tok')
    expect(out).toContain('  remote_url: https://mirror.example')
  })

  it('reads a quoted remote_url / remote_token the way core project-config does', () => {
    expect(readRemote('remote_url: "https://q.example"\nremote_token: \'t0k\'\n'))
      .toEqual({ url: 'https://q.example', token: 't0k' })
  })
})
