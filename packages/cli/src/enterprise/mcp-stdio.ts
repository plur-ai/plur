import { spawn } from 'child_process'
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

/**
 * Opens a minimal MCP stdio session: sends initialize (protocolVersion
 * 2025-06-18), notifications/initialized, then exposes callTool for tool
 * calls (parses content[0].text as JSON). Rejects if initialize does not
 * complete within opts.timeoutMs.
 */
export async function openMcpSession(
  launch: McpLaunch,
  opts: { cwd: string; timeoutMs: number },
): Promise<McpSession> {
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

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

  child.on('exit', () => {
    const err = new Error('MCP server exited unexpectedly')
    for (const [id, h] of [...pending]) {
      pending.delete(id)
      h.reject(err)
    }
  })

  function send(method: string, params?: object, id?: number): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (id != null) msg.id = id
    if (params) msg.params = params
    try {
      child.stdin!.write(JSON.stringify(msg) + '\n')
    } catch {
      // stdin closed (child already exited)
    }
  }

  function request(method: string, params?: object): Promise<unknown> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send(method, params, id)
    })
  }

  // Initialize handshake with session-level timeout
  try {
    await new Promise<void>((resolve, reject) => {
      const initId = nextId++
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        pending.delete(initId)
        child.kill()
        reject(new Error(`did not start within ${opts.timeoutMs}ms`))
      }, opts.timeoutMs)

      pending.set(initId, {
        resolve: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        reject: (e: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(e)
        },
      })

      send(
        'initialize',
        {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'plur-enterprise', version: '0.1.0' },
        },
        initId,
      )
    })
  } catch (e) {
    rl.close()
    throw e
  }

  // Notification — no response expected
  send('notifications/initialized')

  return {
    async callTool(name: string, args: object): Promise<unknown> {
      const result = (await request('tools/call', { name, arguments: args })) as {
        content?: Array<{ type: string; text: string }>
      }
      const text = result?.content?.[0]?.text
      if (text == null) throw new Error(`empty response from tool ${name}`)
      return JSON.parse(text)
    },

    async close(): Promise<void> {
      rl.close()
      if (child.exitCode !== null) return
      child.kill()
      await new Promise<void>((r) => child.once('exit', r))
    },
  }
}
