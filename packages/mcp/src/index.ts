#!/usr/bin/env node
export {}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const VERSION = '0.5.3'

const HELP = `plur-mcp v${VERSION} — persistent memory for AI agents

Usage:
  plur-mcp              Start the MCP server (stdio transport)
  plur-mcp init         Set up PLUR: storage + MCP config + Claude Code hooks
  plur-mcp --help       Show this help message
  plur-mcp --version    Show version

Environment:
  PLUR_PATH             Storage location (default: ~/.plur/)

Quick start:
  npx @plur-ai/mcp init

Docs: https://plur.ai · https://github.com/plur-ai/plur
`

// --- Constants (must be before any await that uses them) ---

const MCP_SERVER_CONFIG = {
  command: 'npx',
  args: ['-y', '@plur-ai/mcp@latest'],
}

const PLUR_HOOKS: Record<string, HookEntry[]> = {
  UserPromptSubmit: [{
    hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject', timeout: 15 }],
  }],
  PostCompact: [{
    matcher: 'auto|manual',
    hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-inject --rehydrate', timeout: 15 }],
  }],
}

// --- Types ---

interface McpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string; timeout?: number }>
}

// --- Functions ---

function findMcpConfig(): string {
  const projectMcp = join(process.cwd(), '.mcp.json')
  if (existsSync(projectMcp)) return projectMcp
  const globalMcp = join(homedir(), '.claude', 'mcp.json')
  if (existsSync(globalMcp)) return globalMcp
  return projectMcp
}

function writeMcpConfig(configPath: string): string {
  let config: McpConfig = {}
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (servers.plur) {
    return `already configured in ${configPath}`
  }

  servers.plur = MCP_SERVER_CONFIG
  config.mcpServers = servers
  const dir = join(configPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  return `added to ${configPath}`
}

function installHooks(): string {
  const projectSettings = join(process.cwd(), '.claude', 'settings.json')
  const globalSettings = join(homedir(), '.claude', 'settings.json')
  const settingsPath = existsSync(join(process.cwd(), '.claude'))
    ? projectSettings
    : globalSettings

  let settings: Settings = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch {}
  }

  // Check if already installed
  const hooks = settings.hooks ?? {}
  for (const entries of Object.values(hooks)) {
    for (const entry of (entries as HookEntry[])) {
      for (const h of entry.hooks ?? []) {
        if (h.command.includes('@plur-ai/cli')) {
          return `already installed in ${settingsPath}`
        }
      }
    }
  }

  // Merge hooks
  const existing = settings.hooks ?? {}
  const merged: Record<string, HookEntry[]> = { ...existing }
  for (const [event, newEntries] of Object.entries(PLUR_HOOKS)) {
    merged[event] = [...(merged[event] ?? []), ...newEntries]
  }
  settings.hooks = merged

  const dir = join(settingsPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return `installed in ${settingsPath}`
}

async function runInit() {
  const results: string[] = []

  // Step 1: Initialize storage
  const { detectPlurStorage } = await import('@plur-ai/core')
  const paths = detectPlurStorage()
  results.push(`Storage:  ${paths.root}`)

  let searchMode = 'BM25 keyword search'
  try {
    const mod = '@huggingface/' + 'transformers'
    await import(/* @vite-ignore */ mod)
    searchMode = 'hybrid (BM25 + embeddings)'
  } catch {}
  results.push(`Search:   ${searchMode}`)

  // Step 2: Write MCP config
  const mcpConfigPath = findMcpConfig()
  const mcpStatus = writeMcpConfig(mcpConfigPath)
  results.push(`MCP:      ${mcpStatus}`)

  // Step 3: Install Claude Code hooks
  const hooksStatus = installHooks()
  results.push(`Hooks:    ${hooksStatus}`)

  process.stdout.write(`PLUR initialized.

  ${results.join('\n  ')}

`)

  if (mcpStatus.includes('added') || hooksStatus.includes('installed')) {
    process.stdout.write(`  Restart Claude Code to activate.\n\n`)
  } else {
    process.stdout.write(`  Everything is set up. Start a new conversation to use PLUR.\n\n`)
  }
}

// --- Main execution ---

const arg = process.argv[2]

if (arg === '--help' || arg === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}

if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (arg === 'init') {
  await runInit()
  process.exit(0)
}

if (arg === 'serve' || arg === undefined) {
  const { runStdio } = await import('./server.js')
  runStdio().catch(err => {
    console.error('Failed to start PLUR MCP server:', err)
    process.exit(1)
  })
} else {
  console.error(`Unknown command: ${arg}\nRun plur-mcp --help for usage.`)
  process.exit(1)
}
