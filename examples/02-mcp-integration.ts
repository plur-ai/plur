/**
 * 02 — MCP integration
 *
 * How PLUR plugs into an MCP client (Claude Code, Cursor, Windsurf), and what the
 * server's `plur_inject` tool actually does: select the engrams relevant to the
 * current task within a token budget, formatted for the system prompt.
 *
 * In real use you don't call this yourself — `npx @plur-ai/mcp init` wires the
 * server into your .mcp.json and the client invokes the tools automatically. This
 * script prints that config and then runs the same core operation so you can see
 * the output.
 *
 * Prerequisites: from the repo root, run `pnpm install && pnpm build` once.
 * Run: pnpm --filter @plur-ai/examples ex:mcp
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'

// The MCP config that `npx @plur-ai/mcp init` adds to your .mcp.json:
const mcpConfig = {
  mcpServers: {
    plur: { command: 'npx', args: ['-y', '@plur-ai/mcp'] },
  },
}
console.log('.mcp.json entry that `npx @plur-ai/mcp init` writes:\n')
console.log(JSON.stringify(mcpConfig, null, 2) + '\n')

const path = mkdtempSync(join(tmpdir(), 'plur-example-'))
const plur = new Plur({ path })

try {
  plur.learn('Always run `pnpm build` before `pnpm test` — claw imports core dist', {
    type: 'procedural',
    domain: 'dev/build',
  })
  plur.learn('Deploy with blue-green; never in-place restart prod', {
    type: 'architectural',
    domain: 'ops/deploy',
  })

  // This is the operation the MCP server exposes as the `plur_inject` tool:
  const result = plur.inject('How do I run the test suite safely?', { budget: 2000 })

  console.log('Injected context for that task (what the agent receives):\n')
  // inject() sorts engrams into three sections — print whichever are non-empty
  for (const [label, text] of [
    ['DIRECTIVES', result.directives],
    ['CONSTRAINTS', result.constraints],
    ['CONSIDER', result.consider],
  ] as const) {
    if (text.trim()) console.log(`${label}:\n${text}\n`)
  }
  console.log(`${result.count} engram(s), ~${result.tokens_used} tokens used`)
} finally {
  rmSync(path, { recursive: true, force: true })
}

/* Expected output: the .mcp.json block above, followed by the injected context
 * (the `pnpm build before pnpm test` engram in one of the labelled sections),
 * with an engram count and token estimate. */
