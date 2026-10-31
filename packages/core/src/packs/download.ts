import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as tar from 'tar'
import { gunzipSync } from 'zlib'
import { logger } from '../logger.js'


// --- URL download helpers ---

/**
 * Directory name a downloaded archive is extracted into. For a FLAT archive
 * (pack files at the archive root) this also becomes the source basename, which
 * is why installPack overrides it with the manifest name; otherwise every flat
 * archive would install to `packs/extracted`.
 */
export const FLAT_ARCHIVE_DIRNAME = 'extracted'


/** Returns true if the source string looks like an http/https URL. */
export function isPackUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}


export const MAX_PACK_DOWNLOAD_BYTES = 32 * 1024 * 1024

export const MAX_PACK_ARCHIVE_BYTES = 64 * 1024 * 1024

export const PACK_DOWNLOAD_TIMEOUT_MS = 30_000


/**
 * Download a pack tar.gz from `url`, extract it to a temp directory, and
 * return the path to the extracted pack directory.
 *
 * The caller is responsible for removing the returned temp directory when done.
 * Use `cleanupDownloadedPack` for that.
 *
 * The archive must be a gzipped tar whose top-level directory is the pack
 * (e.g. `my-pack/SKILL.md`, `my-pack/engrams.yaml`). A flat archive (files
 * at the root without a subdirectory) is also accepted; in that case the
 * extraction root itself is returned as the pack directory.
 *
 * No auth headers are added: with signed-URL delivery the URL is the
 * credential.
 */
export async function downloadAndExtractPack(url: string): Promise<{ packDir: string; tmpRoot: string }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-pack-dl-'))
  const controller = new AbortController()
  // A TOTAL deadline for the request and the body, not an idle timeout.
  // Extraction below is synchronous and runs after the body is in memory.
  const timeout = setTimeout(() => controller.abort(), PACK_DOWNLOAD_TIMEOUT_MS)
  // Signed URLs carry credentials in their path/query; errors must not echo them.
  try {
    let response: Response
    try {
      response = await fetch(url, { signal: controller.signal })
    } catch {
      // fetch() quotes the URL in its own messages ("Failed to parse URL
      // from <url>", "…includes credentials: <url>"). Never pass them on.
      throw new Error(controller.signal.aborted ? 'download timed out' : 'request failed before a response')
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_PACK_DOWNLOAD_BYTES) {
      await response.body?.cancel()
      throw new Error('pack download exceeds size limit')
    }
    if (!response.body) throw new Error('empty pack response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try { next = await reader.read() } catch {
          throw new Error(controller.signal.aborted ? 'download timed out' : 'connection failed while downloading')
        }
        const { done, value } = next
        if (done) break
        total += value.byteLength
        if (total > MAX_PACK_DOWNLOAD_BYTES) throw new Error('pack download exceeds size limit')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    // Bound expansion BEFORE extracting even the first archive entry. This
    // also bounds tar metadata, padding and sparse-file payloads.
    const archive = gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_PACK_ARCHIVE_BYTES })
    const archivePath = path.join(tmpRoot, 'pack.tar')
    fs.writeFileSync(archivePath, archive, { mode: 0o600 })
    let entries = 0
    tar.list({ file: archivePath, sync: true, strict: true, onReadEntry(entry) {
      if (++entries > MAX_PACK_ENTRIES) throw new Error('pack archive exceeds entry limit')
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
        throw new Error('pack archive contains a symbolic link, hard link, or special file')
      }
      const name = entry.path
      if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\') || name.split('/').some(unsafeSegment)) {
        throw new Error('pack archive path escapes extraction directory')
      }
      if (name.split('/').length > 64 || entry.size > MAX_PACK_FILE_BYTES) {
        throw new Error('pack archive entry exceeds size or depth limit')
      }
    } })
    const extractDir = path.join(tmpRoot, FLAT_ARCHIVE_DIRNAME)
    fs.mkdirSync(extractDir)
    tar.extract({ file: archivePath, cwd: extractDir, sync: true, strict: true,
      preservePaths: false, preserveOwner: false, noChmod: true, maxDepth: 64 })
    const names = fs.readdirSync(extractDir)
    const subdirs = names.filter(e => fs.lstatSync(path.join(extractDir, e)).isDirectory())
    const hasPackFiles = names.some(e => ['SKILL.md', 'engrams.yaml', 'manifest.yaml'].includes(e))
    const packDir = hasPackFiles ? extractDir
      : subdirs.length === 1 ? path.join(extractDir, subdirs[0]) : undefined
    if (!packDir) throw new Error('unexpected archive layout — expected a pack directory or pack files at root')
    return { packDir, tmpRoot }
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    const reason = controller.signal.aborted ? 'download timed out' : (err instanceof Error ? err.message : 'invalid archive')
    throw new Error(`Failed to fetch or extract pack: ${reason}`)
  } finally {
    clearTimeout(timeout)
  }
}


/**
 * A path segment that is, or on some platform becomes, a parent reference.
 * Windows strips trailing dots and spaces, so `.. `, `...` and `name.` are
 * not what they look like. A lone `.` is a no-op (`tar -czf p.tgz .` writes
 * `./SKILL.md`) and stays allowed.
 */
export function unsafeSegment(segment: string): boolean {
  if (segment === '.') return false
  return /^\.+\s*$/.test(segment) || /[. ]$/.test(segment)
}


/** Remove the temp directory created by downloadAndExtractPack. Safe to call even if the path no longer exists. */
export function cleanupDownloadedPack(tmpRoot: string): void {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup: log but do not throw
    logger.warning(`cleanupDownloadedPack: could not remove temp dir ${tmpRoot}`)
  }
}


/** The most files a pack may ship before the scan stops and says so. */
export const MAX_PACK_ENTRIES = 10_000

/** The largest file the scan will read. Bigger ones are flagged, not skipped. */
export const MAX_PACK_FILE_BYTES = 16 * 1024 * 1024
