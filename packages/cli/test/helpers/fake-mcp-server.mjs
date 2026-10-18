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
 *   recall-miss  plur_recall → { results:[] }, the server leg answered with nothing
 *   recall-degraded plur_recall → the saved id (a cached row) but the server
 *                leg failed: remote.state 'degraded', results_complete false
 *   recall-no-report plur_recall → the saved id with no remote report at all
 *   no-start     never responds to initialize (client will time out)
 *   hang-call    answers initialize, never answers tools/call
 *   tool-error   plur_learn → isError result with a plain-text message
 *   no-id        plur_learn → { delivery:'remote' } without an id
 *   noisy-stderr writes 1 MiB to stderr before each answer
 *   FAKE_PID     path to write this process's pid to (to check it was killed)
 *   recall-other-holds the id comes back from ANOTHER server; the intended
 *                server answered ok with an unrelated row (Codex round 5, finding 2)
 *   recall-local-degraded local semantic search degraded (embedding model
 *                missing: results_complete false), the server answered with the id
 *   recall-other-failed another dialed server failed (remote.state timeout),
 *                the intended server answered with the id
 *   FAKE_HOST    the server the recall report names (default https://plur.example.com)
 *   FAKE_SAVE_HOST the server plur_learn says it delivered to (`delivered_to`,
 *                default https://plur.example.com; 'none' leaves the field out)
 *
 * Every plur_recall answer (but recall-no-report) carries the per-call remote
 * report the real server attaches: `remote` { state, hosts[] } with the ids
 * each host returned, and `results_complete`. Each log line carries this
 * process's pid.
 */
import { appendFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'

const MODE = process.env.FAKE_MODE ?? 'remote'
const LOG_PATH = process.env.FAKE_LOG
const HOST = process.env.FAKE_HOST ?? 'https://plur.example.com'
const SAVE_HOST = process.env.FAKE_SAVE_HOST ?? 'https://plur.example.com'
const OTHER = 'https://other.example.com'
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
          JSON.stringify({ tool, args, cwd: process.cwd(), pid: process.pid }) + '\n',
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
          ...(SAVE_HOST === 'none' ? {} : { delivered_to: SAVE_HOST }),
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
        const report = (state, ids) => ({
          remote: { state, hosts: [{ host: HOST, state, ms: 3, count: ids.length, ids }] },
          results_complete: state === 'ok',
        })
        if (MODE === 'recall-miss') {
          replyTool(msg.id, { results: [], ...report('ok', []) })
          return
        }
        // Return the saved id (or the default for standalone recall launches).
        const id = savedId ?? 'ENG-HELLO-1'
        const results = [{ id, statement: args.query ?? '', similarity: 1.0 }]
        if (MODE === 'recall-degraded') {
          replyTool(msg.id, { results, ...report('degraded', []) })
          return
        }
        if (MODE === 'recall-other-holds') {
          replyTool(msg.id, {
            results: [...results, { id: 'ENG-UNRELATED-1', statement: 'something else' }],
            remote: {
              state: 'ok',
              hosts: [
                { host: OTHER, state: 'ok', ms: 3, count: 1, ids: [id] },
                { host: HOST, state: 'ok', ms: 3, count: 1, ids: ['ENG-UNRELATED-1'] },
              ],
            },
            results_complete: true,
          })
          return
        }
        if (MODE === 'recall-local-degraded') {
          replyTool(msg.id, {
            results,
            mode: 'hybrid-degraded',
            degraded_reason: 'embedding_model_missing',
            ...report('ok', [id]),
            results_complete: false,
          })
          return
        }
        if (MODE === 'recall-other-failed') {
          replyTool(msg.id, {
            results,
            remote: {
              state: 'timeout',
              hosts: [
                { host: OTHER, state: 'timeout', ms: 2000, count: 0, ids: [] },
                { host: HOST, state: 'ok', ms: 3, count: 1, ids: [id] },
              ],
            },
            results_complete: false,
          })
          return
        }
        if (MODE === 'recall-no-report') {
          replyTool(msg.id, { results })
          return
        }
        replyTool(msg.id, { results, ...report('ok', [id]) })
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
