#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runDoctorCli, runRepairCli, runSetupCli } from './setup.js'

function help(): string {
  return [
    'Usage: npx @plur-ai/claw <command>',
    '',
    'Commands:',
    '  setup            Enable plur-claw in ~/.openclaw/openclaw.json',
    '  setup --repair   Fix only the steps that `doctor` reports as failed',
    '  doctor           Inspect current activation state without modifying config',
    '  learn <text>     Store a new engram in PLUR memory',
    '  recall <query>   Search PLUR memory for relevant engrams',
    '  forget <id>      Retire an engram by its ID',
    '  help             Show this help',
    '',
    'Env:',
    '  OPENCLAW_HOME   Override the OpenClaw config directory (default: ~/.openclaw)',
    '  PLUR_PATH       Override the PLUR storage directory (default: ~/.plur)',
  ].join('\n')
}

export async function runLearn(
  args: string[],
  opts: { plurPath?: string; out?: (s: string) => void; err?: (s: string) => void } = {},
): Promise<number> {
  const text = args.join(' ').trim()
  const out = opts.out ?? ((s: string) => process.stdout.write(s))
  const err = opts.err ?? ((s: string) => process.stderr.write(s))
  if (!text) {
    err('Usage: claw learn <text>\n')
    return 1
  }
  const { Plur } = await import('@plur-ai/core')
  const plurPath = opts.plurPath ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const plur = new Plur({ path: plurPath })
  const engram = plur.learn(text)
  out(`Learned: ${engram.id}\n  ${engram.statement}\n`)
  return 0
}

export async function runRecall(
  args: string[],
  opts: { plurPath?: string; out?: (s: string) => void; err?: (s: string) => void } = {},
): Promise<number> {
  const query = args.join(' ').trim()
  const out = opts.out ?? ((s: string) => process.stdout.write(s))
  const err = opts.err ?? ((s: string) => process.stderr.write(s))
  if (!query) {
    err('Usage: claw recall <query>\n')
    return 1
  }
  const { Plur } = await import('@plur-ai/core')
  const plurPath = opts.plurPath ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const plur = new Plur({ path: plurPath })
  const results = plur.recall(query, { limit: 10 })
  if (results.length === 0) {
    out('No engrams found.\n')
    return 0
  }
  for (const e of results) {
    out(`[${e.id}] ${e.statement}\n`)
  }
  return 0
}

export async function runForget(
  args: string[],
  opts: { plurPath?: string; out?: (s: string) => void; err?: (s: string) => void } = {},
): Promise<number> {
  const id = args[0]?.trim()
  const out = opts.out ?? ((s: string) => process.stdout.write(s))
  const err = opts.err ?? ((s: string) => process.stderr.write(s))
  if (!id) {
    err('Usage: claw forget <engram-id>\n')
    return 1
  }
  const { Plur } = await import('@plur-ai/core')
  const plurPath = opts.plurPath ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const plur = new Plur({ path: plurPath })
  await plur.forget(id)
  out(`Forgot: ${id}\n`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2]
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(help() + '\n')
    return cmd ? 0 : 1
  }
  if (cmd === 'setup') {
    if (argv[3] === '--repair') return runRepairCli()
    return runSetupCli()
  }
  if (cmd === 'doctor') return runDoctorCli()
  if (cmd === 'learn') return runLearn(argv.slice(3))
  if (cmd === 'recall') return runRecall(argv.slice(3))
  if (cmd === 'forget') return runForget(argv.slice(3))
  process.stderr.write(`Unknown command: ${cmd}\n\n${help()}\n`)
  return 1
}

// Guard: only run main() when this file is the direct entry point.
// When imported as a module (e.g., by tests), do not auto-execute.
const isMain = typeof process !== 'undefined' && (
  process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')
)
if (isMain) {
  main(process.argv).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
}
