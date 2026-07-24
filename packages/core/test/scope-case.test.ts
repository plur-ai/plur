/**
 * Case-insensitive scope-family classification (scope-audit 2026-07-24).
 *
 * The /me scope grammar admits uppercase (`[\w:./-]+` in remote-store.ts), but
 * isSharedScope matched lowercase prefixes only — so `Group:x` silently
 * classified as personal-family: never offerable from discovery, and NOT
 * scanned by the write-time leak guard. The prefix test now lowercases its
 * INPUT before comparing; stored scope values are never mutated.
 */
import { describe, it, expect } from 'vitest'
import { isSharedScope, isPersonalScope } from '../src/scope-util.js'

describe('isSharedScope — case-insensitive prefixes (scope-audit 2026-07-24)', () => {
  it('classifies case-variant shared-family scopes as shared', () => {
    for (const s of [
      'Group:plur/engineering',
      'GROUP:PLUR/ENGINEERING',
      'Project:app',
      'PROJECT:app',
      'Space:x',
      'Team:x',
      'Org:x',
      'Public',
      'PUBLIC:roadmap',
      'Public/board',
    ]) {
      expect(isSharedScope(s), `${s} should be shared`).toBe(true)
      expect(isPersonalScope(s), `${s} should not be personal`).toBe(false)
    }
  })

  it('keeps lowercase behavior unchanged', () => {
    for (const s of ['group:plur/x', 'project:app', 'space:x', 'team:x', 'org:x', 'public', 'public:x', 'public/x']) {
      expect(isSharedScope(s)).toBe(true)
    }
    for (const s of ['local', 'global', 'user:alice', 'agent:bot']) {
      expect(isSharedScope(s)).toBe(false)
      expect(isPersonalScope(s)).toBe(true)
    }
  })

  it('personal-family scopes stay personal in any case', () => {
    for (const s of ['USER:alice', 'User:alice', 'Agent:bot', 'GLOBAL', 'Local']) {
      expect(isSharedScope(s), `${s} should stay personal`).toBe(false)
      expect(isPersonalScope(s)).toBe(true)
    }
  })

  it('the #403 public-prefix boundary holds case-insensitively', () => {
    // `public` must match exactly or on a real delimiter — `Public-roadmap`
    // is a personal scope in any case, exactly like `public-roadmap`.
    for (const s of ['public-roadmap', 'Public-roadmap', 'PUBLICfoobar', 'publicfoobar']) {
      expect(isSharedScope(s), `${s} should not be shared`).toBe(false)
    }
  })
})
