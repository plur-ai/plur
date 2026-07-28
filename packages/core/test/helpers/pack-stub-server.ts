/**
 * Lightweight HTTP stub server for testing URL-based pack installation.
 *
 * Serves pre-built .tar.gz archives from an in-memory map over a real TCP
 * connection. No fetch mocking — exercises the full download path.
 *
 * ## Usage
 *
 * ```typescript
 * import { PackStubServer, buildPackArchive } from './helpers/pack-stub-server.js'
 *
 * const server = new PackStubServer()
 * const { url } = await server.start()
 *
 * // Register a pack archive under a path
 * const archive = await buildPackArchive({
 *   skillMd: '---\nname: test-pack\nversion: "1.0"\n---\n',
 *   engramsYaml: 'engrams:\n  - id: ENG-...\n    ...',
 *   packName: 'test-pack',
 * })
 * server.register('/pack.tar.gz', archive)
 *
 * // Install from the URL
 * await installPack(packsDir, `${url}/pack.tar.gz`)
 *
 * await server.stop()
 * ```
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface PackArchiveOptions {
  /** Content for SKILL.md */
  skillMd: string
  /** Content for engrams.yaml */
  engramsYaml: string
  /** Name used for the top-level directory inside the archive */
  packName: string
}

/**
 * Build a .tar.gz archive buffer for a pack with the given SKILL.md and engrams.yaml.
 * Returns a Buffer ready to be served by PackStubServer.
 */
export function buildPackArchive(opts: PackArchiveOptions): Buffer {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur-pack-archive-'))
  const packDir = join(tmpRoot, opts.packName)
  try {
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'SKILL.md'), opts.skillMd)
    writeFileSync(join(packDir, 'engrams.yaml'), opts.engramsYaml)

    const archivePath = join(tmpRoot, 'pack.tar.gz')
    // tar -czf pack.tar.gz -C tmpRoot <packName>  → archive contains <packName>/…
    execFileSync('tar', ['-czf', archivePath, '-C', tmpRoot, opts.packName], { stdio: 'pipe' })
    return readFileSync(archivePath)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

/**
 * Lightweight HTTP stub server that serves registered .tar.gz archives.
 * Returns 404 for unknown paths, 200 with the archive body for known ones.
 */
export class PackStubServer {
  private server: Server | null = null
  private port = 0
  private routes = new Map<string, Buffer>()

  /** Register a Buffer to be served at the given path (e.g. '/pack.tar.gz'). */
  register(urlPath: string, body: Buffer): void {
    this.routes.set(urlPath, body)
  }

  /** Deregister a path. */
  deregister(urlPath: string): void {
    this.routes.delete(urlPath)
  }

  /** Start the server on a random available port. Returns the base URL. */
  async start(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (!addr || typeof addr === 'string') return reject(new Error('unexpected address'))
        this.port = addr.port
        resolve({ url: `http://127.0.0.1:${this.port}` })
      })
      this.server.on('error', reject)
    })
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const urlPath = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`).pathname

    const body = this.routes.get(urlPath)
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Not found: ${urlPath}` }))
      return
    }

    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': body.length,
    })
    res.end(body)
  }
}
