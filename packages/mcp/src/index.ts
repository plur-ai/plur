#!/usr/bin/env node
import { runStdio } from './server.js'
runStdio().catch(err => {
  console.error('Failed to start PLUR MCP server:', err)
  process.exit(1)
})
