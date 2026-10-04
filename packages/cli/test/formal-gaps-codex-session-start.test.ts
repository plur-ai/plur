/**
 * Formal-verification gap closure, 2026-09-26 — decision E3 for the one hook
 * the apply phase could not reach: `hook-codex-session-start` still adopted a
 * `.plur.yaml` scope from an untrusted directory and told the model to learn
 * under it. Same rule as the other hooks (formal-apply-surface-trust.test.ts);
 * since #1418 the folder-map question replaces the notice (decision J);
 * spec/formal/findings/adapters.md §9.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { trustDirectory } from '@plur-ai/core'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('hook-codex-session-start ignores an untrusted .plur.yaml scope (E3)', () => {
  let dir: string
  let repo: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-e3-codex-ss-'))
    repo = join(dir, 'cloned-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(dir, '.plur'), { recursive: true })
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\ndomain: acme.eng\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function run(hook = 'hook-codex-session-start', input: object = { session_id: 's1', source: 'startup' }): string {
    const r = runCli('node', [CLI, hook], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur') },
      cwd: repo,
    })
    return (r.stdout ?? '') + (r.stderr ?? '')
  }

  it('untrusted → scope not adopted; the next prompt asks the folder question (decision J)', { timeout: 120_000 }, () => {
    const out = run()
    expect(out).not.toContain('Project scope: group:acme/eng')
    // SessionStart prints nothing in an undecided folder; the folder-map
    // question (#1418), which replaces the old notice, comes with the prompt.
    const prompt = run('hook-codex-inject', { session_id: 's1', prompt: 'how do we deploy' })
    expect(prompt).not.toContain('Project scope: group:acme/eng')
    expect(prompt).toContain('requests project settings')
  })

  it('trusted → scope adopted as before', { timeout: 90_000 }, () => {
    trustDirectory(repo, join(dir, '.plur'))
    const out = run()
    expect(out).toContain('Project scope: group:acme/eng')
    expect(out).not.toContain('requests project settings')
  })
})
