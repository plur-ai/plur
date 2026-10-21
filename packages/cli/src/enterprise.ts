import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { runEnterpriseCommand } from './enterprise/command.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`plur-enterprise — enterprise setup for PLUR

Usage: plur-enterprise init --server <url> [options]

Commands:
  init --server <url> [options]

Options for init:
  --server <url>          PLUR Enterprise server URL (required, or set PLUR_SERVER)
  --expect-version <ver>  PLUR version each tool must launch (default: this CLI's)
  --ca-file <path>        Path to company CA certificate
  --ca-sha256 <hex>       SHA-256 fingerprint of the company CA (64 hex chars)
  --proxy <url>           HTTPS proxy URL
  --json                  Output JSON
  --no-browser            Skip browser-based sign-in prompt
`)
  process.exit(0)
}

if (cmd === 'init') {
  process.exitCode = await runEnterpriseCommand(argv, {
    cliEntry: fileURLToPath(new URL('./index.js', import.meta.url)),
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text),
    restart: (args, env) => new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { env, stdio: 'inherit', shell: false })
      child.once('error', () => resolve(1))
      child.once('exit', code => resolve(code ?? 1))
    }),
  })
} else {
  process.stderr.write(`Unknown command: ${cmd}\n`)
  process.exit(1)
}
