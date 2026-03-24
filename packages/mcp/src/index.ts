#!/usr/bin/env node
export {}

const VERSION = '0.2.7'

const HELP = `plur-mcp v${VERSION} — persistent memory for AI agents

Usage:
  plur-mcp              Start the MCP server (stdio transport)
  plur-mcp init         Initialize storage and print setup instructions
  plur-mcp --help       Show this help message
  plur-mcp --version    Show version

Environment:
  PLUR_PATH             Storage location (default: ~/.plur/)

Setup:
  Add to .claude/mcp.json (Claude Code) or .cursor/mcp.json (Cursor):

  {
    "mcpServers": {
      "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
    }
  }

Docs: https://plur.ai · https://github.com/plur-ai/plur
`

const arg = process.argv[2]

// Fast paths — no heavy imports needed
if (arg === '--help' || arg === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}

if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (arg === 'init') {
  // Dynamic import — only load core when actually needed
  const { detectPlurStorage } = await import('@plur-ai/core')
  const paths = detectPlurStorage()
  process.stdout.write(`PLUR initialized.

  Storage: ${paths.root}

  Files created:
    ${paths.engrams}
    ${paths.episodes}
    ${paths.config}
    ${paths.packs}/

  Next step — add to your MCP config:

  Claude Code (.claude/mcp.json):
  {
    "mcpServers": {
      "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
    }
  }

  Cursor (.cursor/mcp.json):
  {
    "mcpServers": {
      "plur": { "command": "npx", "args": ["-y", "@plur-ai/mcp"] }
    }
  }

  Then restart your editor. Your agent now has persistent memory.
  Learn more: https://plur.ai
`)
  process.exit(0)
}

if (arg === 'serve' || arg === undefined) {
  // Dynamic import — only load server (and its ONNX deps) when starting
  const { runStdio } = await import('./server.js')
  runStdio().catch(err => {
    console.error('Failed to start PLUR MCP server:', err)
    process.exit(1)
  })
} else {
  console.error(`Unknown command: ${arg}\nRun plur-mcp --help for usage.`)
  process.exit(1)
}
