/**
 * Minimal MCP stdio server for enterprise-hello tests.
 *
 * Env:
 *   FAKE_MODE  — controls behaviour (default: 'remote')
 *   FAKE_LOG   — path to append one JSON line per tool call (args + cwd)
 *
 * Modes:
 *   remote       plur_learn → { id:'ENG-HELLO-1', delivery:'remote', ... }
 *                plur_recall → { results:[{ id:'ENG-HELLO-1', ... }] }
 *                plur_recall_hybrid → isError, as the real server's default
 *                (lean) tool profile answers a tool it does not expose
 *   queued       plur_learn → { id:'ENG-L1', delivery:'outbox', ... }
 *   off          plur_learn → { plur:'off' }
 *   recall-miss  plur_recall → { results:[] }
 *   no-start     never responds to initialize (client will time out)
 *   hang-call    answers initialize, never answers tools/call
 *   tool-error   plur_learn → isError result with a plain-text message
 *   no-id        plur_learn → { delivery:'remote' } without an id
 *   noisy-stderr writes 1 MiB to stderr before each answer
 *   FAKE_PID     path to write this process's pid to (to check it was killed)
 */
import { appendFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'

const MODE = process.env.FAKE_MODE ?? 'remote'
const LOG_PATH = process.env.FAKE_LOG
if (process.env.FAKE_PID) writeFileSync(process.env.FAKE_PID, String(process.pid))

if (MODE === 'no-start') {
  // Drain stdin without responding so the parent's write doesn't block.
  const rl = createInterface({ input: process.stdin })
  rl.on('line', () => { /* swallow */ })
} else {
  let savedId = null

  const rl = createInterface({ input: process.stdin })

  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-plur', version: '0.1.0' },
        },
      })
      return
    }

    if (msg.method === 'notifications/initialized') {
      // No response for notifications.
      return
    }

    if (msg.method === 'tools/call') {
      if (MODE === 'hang-call') return
      const tool = msg.params?.name
      const args = msg.params?.arguments ?? {}

      if (LOG_PATH) {
        appendFileSync(
          LOG_PATH,
          JSON.stringify({ tool, args, cwd: process.cwd() }) + '\n',
        )
      }

      if (tool === 'plur_learn') {
        if (MODE === 'tool-error') {
          write({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'scope user:acme:alice is not writable' }], isError: true },
          })
          return
        }
        if (MODE === 'no-id') {
          replyTool(msg.id, { delivery: 'remote' })
          return
        }
        if (MODE === 'off') {
          replyTool(msg.id, { plur: 'off' })
          return
        }
        if (MODE === 'queued') {
          savedId = 'ENG-L1'
          replyTool(msg.id, {
            id: 'ENG-L1',
            delivery: 'outbox',
            destination:
              'queued for user:acme:alice — not on the server yet: first delivery pending',
          })
          return
        }
        // default: remote
        savedId = 'ENG-HELLO-1'
        replyTool(msg.id, {
          id: 'ENG-HELLO-1',
          delivery: 'remote',
          destination: 'saved to user:acme:alice (server)',
        })
        return
      }

      if (tool === 'plur_recall_hybrid') {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Tool "plur_recall_hybrid" exists but is not directly callable under the current tool profile.', success: false }) }],
            isError: true,
          },
        })
        return
      }

      if (tool === 'plur_recall') {
        if (MODE === 'recall-miss') {
          replyTool(msg.id, { results: [] })
          return
        }
        // Return the saved id (or the default for standalone recall launches).
        const id = savedId ?? 'ENG-HELLO-1'
        replyTool(msg.id, {
          results: [{ id, statement: args.query ?? '', similarity: 1.0 }],
        })
        return
      }

      // Unknown tool
      write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${tool}` },
      })
    }
  })

  rl.on('close', () => process.exit(0))
}

function write(obj) {
  if (MODE === 'noisy-stderr') process.stderr.write('x'.repeat(1024 * 1024))
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function replyTool(id, data) {
  write({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] },
  })
}
