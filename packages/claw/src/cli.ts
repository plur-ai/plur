#!/usr/bin/env node
import { runDoctorCli, runRepairCli, runSetupCli } from './setup.js'

function help(): string {
  return [
    'Usage: npx @plur-ai/claw <command>',
    '',
    'Commands:',
    '  setup            Enable plur-claw in ~/.openclaw/openclaw.json',
    '  setup --repair   Fix only the steps that `doctor` reports as failed',
    '  doctor           Inspect current activation state without modifying config',
    '  help             Show this help',
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
  if (cmd === 'setup') {
    if (argv[3] === '--repair') return runRepairCli()
    return runSetupCli()
  }
  if (cmd === 'doctor') return runDoctorCli()
  process.stderr.write(`Unknown command: ${cmd}\n\n${help()}\n`)
  return 1
}

process.exit(main(process.argv))
