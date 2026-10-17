import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'

export interface McpLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface McpSession {
  callTool(name: string, args: object): Promise<unknown>
  close(): Promise<void>
}

/** Grace period between SIGTERM and SIGKILL when closing or timing out. */
const KILL_GRACE_MS = 2000

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Ends the child: SIGTERM, then SIGKILL after a grace period. Resolves once it has exited. */
function terminate(child: ChildProcess): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS)
    forceTimer.unref()
    child.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })
    try {
      child.kill()
    } catch {
      clearTimeout(forceTimer)
      resolve()
    }
  })
}

/**
 * Opens a minimal MCP stdio session: sends initialize (protocolVersion
 * 2025-06-18), notifications/initialized, then exposes callTool for tool
 * calls (parses content[0].text as JSON). Every request — initialize and each
 * tool call — must answer within opts.timeoutMs, else the child is killed and
 * the call rejects. The child runs without a shell; its stderr is discarded
 * (it may carry configuration or tokens and is never surfaced).
 */
export async function openMcpSession(
  launch: McpLaunch,
  opts: { cwd: string; timeoutMs: number },
): Promise<McpSession> {
  let child: ChildProcess
  try {
    child = spawn(launch.command, launch.args, {
      env: launch.env,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    })
  } catch (e) {
    // e.g. EINVAL for a .cmd/.bat target on Windows without a shell
    throw new Error(`could not start ${launch.command}: ${e instanceof Error ? e.message : String(e)}`)
  }

  let nextId = 1
  let failure: Error | null = null
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  function failAll(err: Error): void {
    if (!failure) failure = err
    for (const [id, h] of [...pending]) {
      pending.delete(id)
      h.reject(err)
    }
  }

  // Without these listeners a spawn failure (ENOENT) or a write to a closed
  // stdin (EPIPE) is an unhandled 'error' event and crashes the process.
  child.on('error', (e) => {
    failAll(new Error(`could not start ${launch.command}: ${e.message}`))
  })
  child.stdin!.on('error', () => {
    // reported through 'exit' / 'error' on the child
  })
  child.on('exit', () => {
    failAll(new Error('MCP server exited unexpectedly'))
  })

  const rl = createInterface({ input: child.stdout! })

  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: { id?: number; result?: unknown; error?: { message: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id == null) return
    const h = pending.get(msg.id)
    if (!h) return
    pending.delete(msg.id)
    if (msg.error) h.reject(new Error(msg.error.message))
    else h.resolve(msg.result)
  })

  function send(method: string, params?: object, id?: number): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (id != null) msg.id = id
    if (params) msg.params = params
    if (child.stdin!.destroyed || !child.stdin!.writable) return
    child.stdin!.write(JSON.stringify(msg) + '\n')
  }

  function request(method: string, params: object | undefined, what: string): Promise<unknown> {
    if (failure) return Promise.reject(failure)
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        void terminate(child)
        reject(new Error(`${what} within ${opts.timeoutMs}ms`))
      }, opts.timeoutMs)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      send(method, params, id)
    })
  }

  try {
    await request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'plur-enterprise', version: '0.1.0' },
      },
      'did not start',
    )
  } catch (e) {
    rl.close()
    await terminate(child)
    throw e
  }

  // Notification — no response expected
  send('notifications/initialized')

  return {
    async callTool(name: string, args: object): Promise<unknown> {
      const result = (await request('tools/call', { name, arguments: args }, `${name} did not answer`)) as {
        content?: Array<{ type: string; text: string }>
        isError?: boolean
      }
      const text = result?.content?.[0]?.text
      if (text == null) throw new Error(`empty response from tool ${name}`)
      if (result.isError) throw new Error(text)
      return JSON.parse(text)
    },

    async close(): Promise<void> {
      rl.close()
      await terminate(child)
    },
  }
}
