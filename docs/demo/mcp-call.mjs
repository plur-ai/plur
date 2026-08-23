#!/usr/bin/env node
/**
 * Call one tool on the PLUR MCP server over stdio, exactly as a real client does.
 *
 *   node mcp-call.mjs <PLUR_PATH> --list
 *   node mcp-call.mjs <PLUR_PATH> <tool> '<json arguments>'
 *
 * This exists so a demo can show REAL tool results rather than invented ones.
 * It speaks the same protocol Claude Code, Cursor and Windsurf speak: initialize,
 * notifications/initialized, then tools/call.
 *
 * Point it at a different build with PLUR_MCP_SERVER.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.PLUR_MCP_SERVER ?? join(HERE, '..', '..', 'packages', 'mcp', 'dist', 'index.js')

const [storePath, tool, argsJson] = process.argv.slice(2)
if (!storePath || !tool) {
  console.error("usage: node mcp-call.mjs <PLUR_PATH> <tool|--list> '<json arguments>'")
  process.exit(2)
}

const child = spawn('node', [SERVER], {
  // The full tool profile, so a demo can reach tools that normally sit behind
  // plur_admin. A real session uses the lean profile and dispatches through it.
  env: { ...process.env, PLUR_PATH: storePath, PLUR_TOOL_PROFILE: 'full' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk.toString()
  let cut
  while ((cut = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})
// The server writes warnings to stderr; a demo does not want them inline.
child.stderr.on('data', () => {})

let nextId = 1
const send = (method, params) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})

const die = message => { console.error(message); child.kill(); process.exit(1) }
setTimeout(() => die('timed out after 60s'), 60_000).unref()

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-call', version: '1.0.0' },
})
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

if (tool === '--list') {
  const reply = await send('tools/list', {})
  for (const t of reply.result?.tools ?? []) {
    console.log(`${t.name}\t${(t.description ?? '').slice(0, 100)}`)
  }
} else {
  const reply = await send('tools/call', { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} })
  if (reply.error) { console.log(JSON.stringify(reply.error, null, 2)); child.kill(); process.exit(1) }
  for (const part of reply.result?.content ?? []) {
    console.log(part.type === 'text' ? part.text : JSON.stringify(part, null, 2))
  }
  if (reply.result?.isError) { child.kill(); process.exit(1) }
}
child.kill()
process.exit(0)
