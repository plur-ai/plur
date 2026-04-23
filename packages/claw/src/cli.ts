#!/usr/bin/env node
import { runSetupCli } from './setup.js'

function help(): string {
  return [
    'Usage: npx @plur-ai/claw <command>',
    '',
    'Commands:',
    '  setup    Enable plur-claw in ~/.openclaw/openclaw.json',
    '  help     Show this help',
    '',
    'Env:',
    '  OPENCLAW_HOME   Override the OpenClaw config directory (default: ~/.openclaw)',
  ].join('\n')
}

function main(argv: string[]): number {
  const cmd = argv[2]
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(help() + '\n')
    return cmd ? 0 : 1
  }
  if (cmd === 'setup') return runSetupCli()
  process.stderr.write(`Unknown command: ${cmd}\n\n${help()}\n`)
  return 1
}

process.exit(main(process.argv))
