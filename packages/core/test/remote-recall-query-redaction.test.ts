// security audit 2026-11-06: a recall query carrying a secret is never sent to a team host.
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

  it('recallHybrid and injectHybrid withhold a query with a pasted secret; a clean query is sent as is', async () => {
    const plur = new Plur({ path: dir })
    const q = `why does ci fail, token ${GHP} key ${AWS}`
    await plur.recallHybrid(q, { scope: SCOPE } as any)
    await plur.injectHybrid(q, { scope: SCOPE, source: 'hook' } as any)
    expect(recallPosts()).toEqual([])
    await plur.recallHybrid('how do we tag releases', { scope: SCOPE } as any)
    expect(recallPosts().map(p => p.body.query)).toEqual(['how do we tag releases'])
  })
})
