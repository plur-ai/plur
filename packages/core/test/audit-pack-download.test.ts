/** Invariant: untrusted archives have bounded network, expansion, file and
 * entry work, are validated before extraction, and failures clean up. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { gzipSync } from 'node:zlib'
import { downloadAndExtractPack, MAX_PACK_ARCHIVE_BYTES, MAX_PACK_DOWNLOAD_BYTES } from '../src/packs.js'

afterEach(() => vi.unstubAllGlobals())
it('rejects excessive declared body size before consuming it', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), {
    headers: { 'content-length': String(MAX_PACK_DOWNLOAD_BYTES + 1) },
  })))
  await expect(downloadAndExtractPack('https://audit.example/signed-secret')).rejects.toThrow(/size limit/)
  expect(cancel).toHaveBeenCalled()
})
it('bounds decompression even when the compressed download is tiny', async () => {
  const before = readdirSync(tmpdir()).filter(f => f.startsWith('plur-pack-dl-'))
  const bomb = gzipSync(Buffer.alloc(MAX_PACK_ARCHIVE_BYTES + 1))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bomb)))
  await expect(downloadAndExtractPack('https://audit.example/signed-secret')).rejects.toThrow()
  expect(readdirSync(tmpdir()).filter(f => f.startsWith('plur-pack-dl-'))).toEqual(before)
})
it('rejects link entries before unpacking any file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plur-pack-link-'))
  try {
    writeFileSync(join(root, 'outside'), 'unchanged')
    symlinkSync('outside', join(root, 'linked'))
    const file = join(root, 'test.tar.gz')
    tar.create({ file, cwd: root, gzip: true, sync: true }, ['linked'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(readFileSync(file))))
    await expect(downloadAndExtractPack('https://audit.example/signed-secret')).rejects.toThrow(/link/)
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('unchanged')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('never echoes a signed URL on an HTTP error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  await expect(downloadAndExtractPack('https://audit.example/secret?token=private')).rejects.toThrow('HTTP 404')
  try { await downloadAndExtractPack('https://audit.example/secret?token=private') } catch (err) {
    expect(String(err)).not.toContain('private')
    expect(String(err)).not.toContain('/secret')
  }
})
