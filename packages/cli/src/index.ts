const VERSION = '0.1.0'

const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`plur v${VERSION} — persistent memory for AI agents

Usage: plur <command> [options]

Commands:
  learn <statement>       Create a new engram
  recall <query>          Search engrams
  inject <task>           Get relevant engrams for a task
  list                    List all engrams
  forget <id>             Retire an engram
  feedback <id> <signal>  Rate an engram (positive|negative|neutral)
  capture <summary>       Record an episode
  timeline [query]        Query episode timeline
  status                  System health check
  sync                    Cross-device sync
  packs list              List installed packs
  packs install <source>  Install engram pack

Global flags:
  --json       Force JSON output (auto-detected when piped)
  --path <dir> Override storage path (default: ~/.plur)
  --quiet      Suppress non-essential output
  --version    Print version
  --help       Show this help`)
  process.exit(0)
}

console.error(`Unknown command: ${args[0]}. Run 'plur --help' for usage.`)
process.exit(1)
