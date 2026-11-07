/**
 * Security audit 2026-11-06: the remote recall leg (recallHybrid /
 * injectHybrid, including the UserPromptSubmit hook) POSTed the raw query to
 * the team store host, secrets included, although learn() refuses the same
 * text for the same scope. The query now passes the write leg's content gate
 * first: spans flagged by detectSecrets, or by the dialed scopes' sensitivity
 * policy, are replaced with "[redacted]".
 *
 * In-process `globalThis.fetch` stub only — dummy keys, no sockets.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const SCOPE = 'group:dummyorg/team'
const AWS = 'AKIAIOSFODNN7EXAMPLE'
const GHP = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123'

describe('remote recall query redaction (security audit 2026-11-06)', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined
  let prevPlurPath: string | undefined
  let originalFetch: typeof globalThis.fetch
  let sent: { url: string; body: any }[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-recall-redact-'))
    prevHome = process.env.HOME
    prevPlurPath = process.env.PLUR_PATH
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    process.env.PLUR_PATH = dir
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nindex: false\nstores:\n  - url: "https://teamstore.example.invalid"\n    token: "dummy-v46-token"\n    scope: "${SCOPE}"\n`)
    originalFetch = globalThis.fetch
    sent = []
    globalThis.fetch = (async (url: any, init: any) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env.HOME = prevHome
    if (prevPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = prevPlurPath
    rmSync(root, { recursive: true, force: true })
  })

  const recallPosts = () => sent.filter(s => s.url.includes('/recall') && s.body)

  it('recallHybrid and injectHybrid never send a pasted secret to the team host', async () => {
    const plur = new Plur({ path: dir })
    const q = `why does ci fail, token ${GHP} key ${AWS}`
    await plur.recallHybrid(q, { scope: SCOPE } as any)
    await plur.injectHybrid(q, { scope: SCOPE, source: 'hook' } as any)
    const posts = recallPosts()
    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) {
      const sentQuery = String(p.body.query)
      expect(sentQuery).not.toContain(AWS)
      expect(sentQuery).not.toContain(GHP)
      expect(sentQuery).toContain('[redacted]')
      expect(sentQuery).toContain('why does ci fail')
    }
  })

  it('leaves a clean query untouched', async () => {
    const plur = new Plur({ path: dir })
    await plur.recallHybrid('how do we tag releases', { scope: SCOPE } as any)
    const posts = recallPosts()
    expect(posts.length).toBeGreaterThan(0)
    expect(posts[0].body.query).toBe('how do we tag releases')
  })
})
