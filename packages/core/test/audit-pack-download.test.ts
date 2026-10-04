/** Invariant: untrusted archives have bounded network, expansion, file and
 * entry work, are validated before extraction, and failures clean up. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { gzipSync } from 'node:zlib'
import { downloadAndExtractPack, MAX_PACK_ARCHIVE_BYTES, MAX_PACK_DOWNLOAD_BYTES, PACK_DOWNLOAD_TIMEOUT_MS } from '../src/packs.js'

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
  // A structurally valid pack whose entries are each under the per-file cap,
  // so only the decompression bound can stop it.
  const filler = Buffer.alloc(15 * 1024 * 1024)
  const count = Math.ceil(MAX_PACK_ARCHIVE_BYTES / filler.length) + 1
  const bomb = rawTar([
    { path: 'SKILL.md', body: Buffer.from('# bomb\n') },
    ...Array.from({ length: count }, (_, i) => ({ path: `pad${i}.md`, body: filler })),
  ])
  expect(bomb.length).toBeLessThan(1024 * 1024)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bomb)))
  await expect(downloadAndExtractPack('https://audit.example/signed-secret')).rejects.toThrow(/Failed to fetch or extract pack/)
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

// Raw archives built header by header, so the tests can express entries that
// a well-behaved archiver would refuse to write (`..`, absolute names, a
// declared size larger than the body that follows).
function rawTar(entries: Array<{ path: string; type?: 'File' | 'Directory'; body?: Buffer; size?: number }>): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0)
    const header = Buffer.alloc(512)
    new tar.Header({ path: e.path, type: e.type ?? 'File', size: e.size ?? body.length, mode: 0o644, mtime: new Date(0) }).encode(header, 0)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function serve(archive: Buffer) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(archive)))
}

function tmpRootsNow(): string[] {
  return readdirSync(tmpdir()).filter(f => f.startsWith('plur-pack-dl-'))
}

it.each([
  ['a parent-directory segment', 'pack/../../escaped.md'],
  ['an absolute path', '/tmp/plur-escaped.md'],
  ['a Windows drive path', 'C:/escaped.md'],
  ['a backslash path', 'pack\\..\\escaped.md'],
])('rejects an entry whose name has %s, and cleans up', async (_label, name) => {
  const before = tmpRootsNow()
  serve(rawTar([{ path: 'pack/SKILL.md', body: Buffer.from('# ok\n') }, { path: name, body: Buffer.from('x') }]))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/escapes extraction directory/)
  expect(tmpRootsNow()).toEqual(before)
})

it('rejects an archive with more entries than the scan limit', async () => {
  // MAX_PACK_ENTRIES in packs.ts is 10,000.
  const entries = Array.from({ length: 10_001 }, (_, i) => ({ path: `pack/d${i}`, type: 'Directory' as const }))
  serve(rawTar(entries))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/entry limit/)
})

it('rejects an entry larger than the per-file limit before unpacking it', async () => {
  // MAX_PACK_FILE_BYTES in packs.ts is 16 MiB. The header alone declares the
  // size; the check must fire on the header, before any body is read.
  serve(rawTar([{ path: 'pack/huge.md', size: 16 * 1024 * 1024 + 1 }]))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/size or depth limit/)
})

it('rejects an entry nested deeper than the depth limit', async () => {
  const deep = Array.from({ length: 65 }, (_, i) => `d${i}`).join('/') + '/f.md'
  serve(rawTar([{ path: deep, body: Buffer.from('x') }]))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/size or depth limit/)
})

it('still extracts a well-formed archive, preferring root pack files over a lone subdirectory', async () => {
  serve(rawTar([
    { path: 'SKILL.md', body: Buffer.from('# root\n') },
    { path: 'references/', type: 'Directory' },
    { path: 'references/a.md', body: Buffer.from('a\n') },
  ]))
  const { packDir, tmpRoot } = await downloadAndExtractPack('https://audit.example/p.tgz')
  try {
    expect(readFileSync(join(packDir, 'SKILL.md'), 'utf8')).toBe('# root\n')
  } finally { rmSync(tmpRoot, { recursive: true, force: true }) }
})

it('aborts a download that stalls past the timeout, without echoing the URL', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    const pending = downloadAndExtractPack('https://audit.example/secret?token=private')
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(PACK_DOWNLOAD_TIMEOUT_MS + 1)
    await assertion
    await pending.catch(err => expect(String(err)).not.toContain('private'))
  } finally { vi.useRealTimers() }
})

// A body streamed in 1 MiB chunks, with whatever Content-Length the server
// chooses to claim (or none), so only the running byte count can stop it.
function streamedBody(totalBytes: number, contentLength?: number): Response {
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return }
      const size = Math.min(chunk.length, totalBytes - sent)
      sent += size
      controller.enqueue(chunk.subarray(0, size))
    },
  })
  const headers = contentLength === undefined ? undefined : { 'content-length': String(contentLength) }
  return new Response(body, { headers })
}

it.each([
  ['no Content-Length', undefined],
  ['a small, false Content-Length', 1024],
])('stops a streamed body over the download cap with %s, and cleans up', async (_label, declared) => {
  const before = tmpRootsNow()
  vi.stubGlobal('fetch', vi.fn(async () => streamedBody(MAX_PACK_DOWNLOAD_BYTES + 1024 * 1024, declared)))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/size limit/)
  expect(tmpRootsNow()).toEqual(before)
})

it.each([
  ['credentials in the URL', 'https://user:signed-secret@audit.example/p.tgz?token=private'],
  ['an unparseable URL', 'https://audit.example:99999/signed-secret?token=private'],
])('never echoes a URL that fetch rejects before a response: %s', async (_label, url) => {
  // Real fetch, not a stub: these are the messages undici itself produces.
  let failure: unknown
  try { await downloadAndExtractPack(url) } catch (error) { failure = error }
  expect(String(failure)).toMatch(/Failed to fetch or extract pack/)
  expect(String(failure)).not.toContain('signed-secret')
  expect(String(failure)).not.toContain('private')
  expect(String(failure)).not.toContain('audit.example')
})

it.each([
  ['three dots', 'pack/.../x.md'],
  ['dots then a space', 'pack/.. /x.md'],
  ['a trailing dot', 'pack/dir./x.md'],
  ['a trailing space', 'pack/dir /x.md'],
])('rejects a path segment Windows would rewrite: %s', async (_label, name) => {
  serve(rawTar([{ path: 'pack/SKILL.md', body: Buffer.from('# ok\n') }, { path: name, body: Buffer.from('x') }]))
  await expect(downloadAndExtractPack('https://audit.example/p.tgz')).rejects.toThrow(/escapes extraction directory/)
})

it('still accepts the ./-prefixed names that `tar -czf pack.tgz .` writes', async () => {
  serve(rawTar([{ path: './', type: 'Directory' }, { path: './SKILL.md', body: Buffer.from('# dot\n') }]))
  const { packDir, tmpRoot } = await downloadAndExtractPack('https://audit.example/p.tgz')
  try {
    expect(readFileSync(join(packDir, 'SKILL.md'), 'utf8')).toBe('# dot\n')
  } finally { rmSync(tmpRoot, { recursive: true, force: true }) }
})
