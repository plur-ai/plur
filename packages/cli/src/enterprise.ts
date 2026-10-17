import { parseInitArgs } from './enterprise/args.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`plur-enterprise — enterprise setup for PLUR

Usage: plur-enterprise <command> [options]

Commands:
  plur-enterprise init --server <url> [options]

Options for init:
  --server <url>          PLUR Enterprise server URL (required, or set PLUR_SERVER)
  --expect-version <ver>  Expected @plur-ai/cli version on the server
  --ca-file <path>        Path to company CA certificate
  --ca-sha256 <hex>       SHA-256 fingerprint of the company CA (64 hex chars)
  --proxy <url>           HTTPS proxy URL
  --json                  Output JSON
  --no-browser            Skip browser-based sign-in prompt
`)
  process.exit(0)
}

if (cmd === 'init') {
  const opts = parseInitArgs(argv, process.env)
  if ('error' in opts) {
    process.stderr.write(opts.error + '\n')
    process.exit(1)
  }
  // runEnterpriseInit is implemented in a later task (refs #1638)
  throw new Error('not implemented')
} else {
  process.stderr.write(`Unknown command: ${cmd}\n`)
  process.exit(1)
}
