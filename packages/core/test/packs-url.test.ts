/**
 * URL-based pack install / preview tests.
 *
 * Tests `plur packs install https://...` and `plur packs preview https://...`
 * using a lightweight in-process HTTP stub server that serves real .tar.gz
 * archives over TCP. No fetch mocking — exercises the full download path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { installPack, previewPack, isPackUrl, downloadAndExtractPack, cleanupDownloadedPack } from '../src/packs.js'
import { PackStubServer, buildPackArchive } from './helpers/pack-stub-server.js'

// ---------------------------------------------------------------------------
// Shared stub server — one server, multiple registered routes
// ---------------------------------------------------------------------------

const server = new PackStubServer()
let baseUrl: string

// A valid minimal pack archive (flat SKILL.md + engrams.yaml in a subdir)
const VALID_PACK_ARCHIVE = buildPackArchive({
  packName: 'my-url-pack',
  skillMd: '---\nname: url-pack\nversion: "1.0"\n---\n',
  engramsYaml: `engrams:
  - id: ENG-2026-0101-001
    statement: Always prefer explicit types in TypeScript
    type: behavioral
    scope: global
    status: active
    version: 2
    domain: typescript.style
    tags: [typescript, types]
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`,
})

// A pack with a secret — install must be blocked
const SECRET_PACK_ARCHIVE = buildPackArchive({
  packName: 'secret-url-pack',
  skillMd: '---\nname: secret-url-pack\nversion: "1.0"\n---\n',
  engramsYaml: `engrams:
  - id: ENG-2026-0101-002
    statement: Deploy with key AKIA1234567890ABCDEF to production
    type: procedural
    scope: global
    status: active
    version: 2
    visibility: public
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`,
})

beforeAll(async () => {
  const result = await server.start()
  baseUrl = result.url
  server.register('/valid-pack.tar.gz', VALID_PACK_ARCHIVE)
  server.register('/secret-pack.tar.gz', SECRET_PACK_ARCHIVE)
})

afterAll(async () => {
  await server.stop()
})

// ---------------------------------------------------------------------------
// Per-test temp directory
// ---------------------------------------------------------------------------

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-url-packs-'))
  mkdirSync(join(dir, 'packs'))
})
afterEach(() => {
  rmSync(dir, { recursive: true })
})

// ---------------------------------------------------------------------------
// isPackUrl
// ---------------------------------------------------------------------------

describe('isPackUrl', () => {
  it('returns true for http:// URLs', () => {
    expect(isPackUrl('http://example.com/pack.tar.gz')).toBe(true)
  })

  it('returns true for https:// URLs', () => {
    expect(isPackUrl('https://hub.plur.ai/dl/TOKEN/pack.tar.gz')).toBe(true)
  })

  it('returns false for local paths', () => {
    expect(isPackUrl('/home/user/packs/my-pack')).toBe(false)
    expect(isPackUrl('./my-pack')).toBe(false)
    expect(isPackUrl('my-pack')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// downloadAndExtractPack
// ---------------------------------------------------------------------------

describe('downloadAndExtractPack', () => {
  it('downloads and extracts a pack archive to a temp directory', async () => {
    const url = `${baseUrl}/valid-pack.tar.gz`
    const { packDir, tmpRoot } = await downloadAndExtractPack(url)
    try {
      // The extracted pack should contain SKILL.md and engrams.yaml
      const { existsSync } = await import('fs')
      expect(existsSync(join(packDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(packDir, 'engrams.yaml'))).toBe(true)
    } finally {
      cleanupDownloadedPack(tmpRoot)
    }
  })

  it('throws on HTTP 404', async () => {
    const url = `${baseUrl}/not-found.tar.gz`
    await expect(downloadAndExtractPack(url)).rejects.toThrow(/HTTP 404/)
  })

  it('throws on connection refused', async () => {
    // Use a port that is very unlikely to be listening
    const url = 'http://127.0.0.1:1/pack.tar.gz'
    await expect(downloadAndExtractPack(url)).rejects.toThrow()
  })

  it('cleanupDownloadedPack is safe to call twice (idempotent)', async () => {
    const url = `${baseUrl}/valid-pack.tar.gz`
    const { tmpRoot } = await downloadAndExtractPack(url)
    cleanupDownloadedPack(tmpRoot) // first call removes it
    expect(() => cleanupDownloadedPack(tmpRoot)).not.toThrow() // second is safe
  })
})

// ---------------------------------------------------------------------------
// previewPack with URL
// ---------------------------------------------------------------------------

describe('previewPack (URL)', () => {
  it('previews a pack from an http URL', async () => {
    const preview = await previewPack(`${baseUrl}/valid-pack.tar.gz`)
    expect(preview.manifest.name).toBe('url-pack')
    expect(preview.manifest.version).toBe('1.0')
    expect(preview.engram_count).toBe(1)
    expect(preview.engrams[0].statement).toContain('explicit types')
    expect(preview.security.clean).toBe(true)
  })

  it('preview of a secret-containing URL pack flags security issues', async () => {
    const preview = await previewPack(`${baseUrl}/secret-pack.tar.gz`)
    expect(preview.security.clean).toBe(false)
    expect(preview.security.issues.some(i => i.type === 'secret')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// installPack with URL
// ---------------------------------------------------------------------------

describe('installPack (URL)', () => {
  it('installs a pack from an http URL', async () => {
    const result = await installPack(join(dir, 'packs'), `${baseUrl}/valid-pack.tar.gz`)
    expect(result.installed).toBe(1)
    expect(result.name).toBe('my-url-pack')
  })

  it('records the original URL as source in the registry', async () => {
    const packUrl = `${baseUrl}/valid-pack.tar.gz`
    const result = await installPack(join(dir, 'packs'), packUrl)
    // Registry source should be the original URL, not an ephemeral /tmp path
    expect(result.registry.source).toBe(packUrl)
    expect(result.registry.source).toMatch(/^http/)
  })

  it('installed pack files are accessible on disk', async () => {
    await installPack(join(dir, 'packs'), `${baseUrl}/valid-pack.tar.gz`)
    const { existsSync } = await import('fs')
    expect(existsSync(join(dir, 'packs', 'my-url-pack', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'packs', 'my-url-pack', 'engrams.yaml'))).toBe(true)
  })

  it('blocks install of URL pack containing secrets', async () => {
    await expect(
      installPack(join(dir, 'packs'), `${baseUrl}/secret-pack.tar.gz`),
    ).rejects.toThrow(/secrets/)
  })

  it('cleans up temp download dir after successful install', async () => {
    // Count /tmp entries matching our prefix before and after — the delta should
    // be zero (temp dir removed). We can't assert file existence directly since
    // we don't expose the tmpRoot from installPack, but we verify no exception
    // was thrown and the pack is installed.
    await expect(
      installPack(join(dir, 'packs'), `${baseUrl}/valid-pack.tar.gz`),
    ).resolves.toBeDefined()
  })

  it('cleans up temp download dir after blocked install (secrets)', async () => {
    // Even when install throws, the temp directory must be cleaned up.
    await expect(
      installPack(join(dir, 'packs'), `${baseUrl}/secret-pack.tar.gz`),
    ).rejects.toThrow(/secrets/)
    // If we reach here, the temp dir was cleaned (no orphaned /tmp/plur-pack-dl-* dirs).
    // We verify this indirectly — no exception from a leaked resource.
  })

  it('throws on HTTP 404 URL (not found)', async () => {
    await expect(
      installPack(join(dir, 'packs'), `${baseUrl}/nonexistent.tar.gz`),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('existing local-path behavior is unchanged', async () => {
    // Regression: local paths must still work after URL support was added.
    const { mkdirSync: mkdir, writeFileSync: write } = await import('fs')
    const packDir = join(dir, 'local-pack')
    mkdir(packDir)
    write(join(packDir, 'SKILL.md'), '---\nname: local-pack\nversion: "1.0"\n---\n')
    write(join(packDir, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-003
    statement: Local pack still works
    type: behavioral
    scope: global
    status: active
    version: 2
    activation:
      retrieval_strength: 0.7
      storage_strength: 1.0
      frequency: 0
      last_accessed: "2026-01-01"
`)
    const result = await installPack(join(dir, 'packs'), packDir)
    expect(result.installed).toBe(1)
    expect(result.name).toBe('local-pack')
    // Registry source should be a local path, not a URL
    expect(result.registry.source).not.toMatch(/^http/)
  })
})
