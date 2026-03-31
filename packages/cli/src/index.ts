import { shouldOutputJson, outputJson, exit } from './output.js'
import { parseGlobalFlags, createPlur } from './plur.js'

export type { GlobalFlags } from './plur.js'
export { parseGlobalFlags, createPlur } from './plur.js'

const VERSION = '0.5.3'

// --- Main ---
const argv = process.argv.slice(2)

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(`plur v${VERSION} — persistent memory for AI agents

Usage: plur <command> [options]

Commands:
  learn <statement>       Create a new engram
  recall <query>          Search engrams
  inject <task>           Get relevant engrams for a task
  list                    List all engrams
  forget <id>             Retire an engram
  ingest <content>        Extract and save engrams from content
  feedback <id> <signal>  Rate an engram (positive|negative|neutral)
  capture <summary>       Record an episode
  timeline [query]        Query episode timeline
  status                  System health check
  sync                    Cross-device sync
  packs list              List installed packs
  packs install <source>  Install engram pack
  packs export <name>     Export engrams as a pack
  promote <id>            Promote an engram to active
  stores list             List configured stores
  stores add <path>       Add a knowledge store

Global flags:
  --json       Force JSON output (auto-detected when piped)
  --path <dir> Override storage path (default: ~/.plur)
  --fast       Use BM25-only search (skip embeddings)
  --quiet      Suppress non-essential output
  --version    Print version
  --help       Show this help`)
  process.exit(0)
}

const { flags, args } = parseGlobalFlags(argv)
const command = args[0]
const commandArgs = args.slice(1)

const COMMANDS: Record<string, string> = {
  learn: './commands/learn.js',
  recall: './commands/recall.js',
  inject: './commands/inject.js',
  list: './commands/list.js',
  forget: './commands/forget.js',
  feedback: './commands/feedback.js',
  capture: './commands/capture.js',
  timeline: './commands/timeline.js',
  status: './commands/status.js',
  sync: './commands/sync.js',
  packs: './commands/packs.js',
  ingest: './commands/ingest.js',
  promote: './commands/promote.js',
  stores: './commands/stores.js',
}

if (!command || !COMMANDS[command]) {
  exit(1, `Unknown command: ${command}. Run 'plur --help' for usage.`)
}

try {
  const mod = await import(COMMANDS[command])
  await mod.run(commandArgs, flags)
} catch (err: any) {
  if (shouldOutputJson(flags)) {
    outputJson({ error: err.message })
  } else {
    exit(1, `Error: ${err.message}`)
  }
  process.exit(1)
}
