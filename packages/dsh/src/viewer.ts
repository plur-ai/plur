/**
 * The memory viewer, reachable from inside DeepSeek Harness.
 *
 * DeepSeek Harness renders its own UI as a React client assembled from
 * `@deepseek-ai/dsh-client-ui-*` plugins over a typed slot registry. Adding a
 * native tab there means shipping a browser bundle bound to that registry's
 * pre-1.0 internals. This takes the other road: the same viewer `plur ui`
 * serves, started on demand and handed back as a URL.
 *
 * The server is `@plur-ai/ui/server`, shared with the CLI — one viewer, one
 * implementation, so a fix in either reaches both.
 *
 * @module
 */
import type { PlurClient } from './client.js'

/** What the command needs from a running viewer. */
export interface ViewerHandle {
  /** The loopback URL to open. */
  url: string
  /** Stop the server. */
  close: () => Promise<void>
}

/** Lazily-imported so a host that never opens the viewer never loads it. */
type StartViewer = (opts: {
  load: () => Promise<readonly unknown[]>
  where: string
  openPath?: string
  port?: number
}) => Promise<ViewerHandle>

/**
 * A viewer that starts on first use and is reused thereafter.
 *
 * Idempotent on purpose: running the command twice should hand back the same
 * URL rather than leaking a second server onto a second port. Disposing the
 * controller stops whatever is running.
 */
export interface ViewerController {
  /** Start if needed, then return the URL. */
  open: () => Promise<string>
  /** Stop the viewer if one is running. */
  dispose: () => Promise<void>
}

/** Read `storage_root` off a status result without trusting its shape. */
async function storePath(plur: PlurClient): Promise<string> {
  try {
    const status = await plur.status?.()
    const root = status?.storage_root
    return typeof root === 'string' ? root : ''
  } catch {
    // A diagnostic failure must not stop someone reading their memory.
    return ''
  }
}

/**
 * Build the viewer controller.
 *
 * @param plur - the engine to read. Never written to by the viewer.
 * @param deps - overridable for tests; defaults to the real `@plur-ai/ui/server`.
 * @returns a controller whose `open` is safe to call repeatedly.
 */
export function createViewer(
  plur: PlurClient | undefined,
  deps: { startViewer?: StartViewer; port?: number } = {},
): ViewerController {
  let running: ViewerHandle | undefined
  // Concurrent /plur-memory invocations must not race two servers into
  // existence; the second await joins the first start.
  let starting: Promise<ViewerHandle> | undefined

  const start = async (): Promise<ViewerHandle> => {
    if (!plur) throw new Error('PLUR is not installed. Run: npm i @plur-ai/core')
    // An engine facade that never loaded would serve an empty table that looks
    // like an empty store. Say what actually happened instead.
    const ready = (plur as { ready?: () => Promise<boolean> }).ready
    if (typeof ready === 'function' && !(await ready.call(plur))) {
      throw new Error('@plur-ai/core could not be loaded. Run: npm i @plur-ai/core')
    }
    const startViewer = deps.startViewer
      ?? (await import('@plur-ai/ui/server')).startViewer as unknown as StartViewer
    const where = await storePath(plur)
    return await startViewer({
      // Reloaded per request, so learning something mid-session and
      // refreshing shows it.
      // Unscoped on purpose, and said so in the command's own output: the
      // viewer is a human-initiated, loopback-only window onto the store the
      // user owns. Scoping it to the calling session would hide the very
      // engrams someone opens it to find. The prompt path is scoped; this is
      // not the prompt path.
      load: async () => (await plur.list?.()) ?? [],
      where,
      // Revealing a folder is harmless locally, and the server binds loopback
      // only, so there is no remote caller to worry about.
      ...(where ? { openPath: where } : {}),
      ...(deps.port === undefined ? {} : { port: deps.port }),
    })
  }

  return {
    open: async () => {
      if (running) return running.url
      starting ??= start()
      try {
        running = await starting
      } finally {
        starting = undefined
      }
      return running.url
    },
    dispose: async () => {
      const handle = running ?? await starting?.catch(() => undefined)
      running = undefined
      starting = undefined
      await handle?.close()
    },
  }
}
