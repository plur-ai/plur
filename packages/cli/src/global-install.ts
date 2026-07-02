import { exec } from 'child_process'

export interface GlobalInstallResult {
  found: boolean
  packages: Array<{ name: string; version: string }>
  plurBinaryPath: string | null
}

const GLOBAL_PATH_PATTERNS = [
  '/homebrew/',
  '/usr/local/',
  '/usr/bin/',
  '/usr/share/',
  // Node version managers (issue #190) — `npm install -g` inside a managed
  // node lands under these prefixes, not the system paths above.
  '/.nvm/', // nvm: ~/.nvm/versions/node/vX.Y.Z/bin/plur
  '/.volta/', // volta: ~/.volta/bin/plur
  '/fnm/', // fnm data dir: .../fnm/node-versions/vX.Y.Z/installation/bin/plur
  '/fnm_multishells/', // fnm shell shims: .../fnm_multishells/<pid>_<ts>/bin/plur
]

/** Run a command, resolving with stdout; rejects on failure or timeout. */
function run(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

/**
 * Detect globally installed plur packages that shadow `npx @latest` resolution.
 * Safe to call at startup — subprocesses run concurrently (issue #191: worst
 * case is one timeout, ~5s, not their 12s sum), all time out, no event-loop
 * blocking, and failures are swallowed.
 */
export async function checkGlobalInstall(): Promise<GlobalInstallResult> {
  const packageChecks = ['@plur-ai/mcp', '@plur-ai/cli'].map(async (pkg) => {
    try {
      const out = await run(`npm list -g ${pkg} --depth=0`, 5000)
      // Output: /opt/homebrew/lib\n└── @plur-ai/mcp@0.7.7\n
      const m = out.match(/@[\w-]+\/[\w-]+@([\w.+-]+)/)
      return m ? { name: pkg, version: m[1] } : null
    } catch {
      return null // not globally installed or npm unavailable
    }
  })

  const binaryCheck = (async () => {
    try {
      const p = (await run('which plur', 2000)).trim()
      return p && GLOBAL_PATH_PATTERNS.some((pat) => p.includes(pat)) ? p : null
    } catch {
      return null // `which` failed or plur not on PATH
    }
  })()

  const [pkgResults, plurBinaryPath] = await Promise.all([Promise.all(packageChecks), binaryCheck])
  const packages = pkgResults.filter((p): p is { name: string; version: string } => p !== null)

  return { found: packages.length > 0 || plurBinaryPath !== null, packages, plurBinaryPath }
}

export function formatGlobalInstallWarning(result: GlobalInstallResult): string[] {
  const lines: string[] = []
  if (!result.found) return lines

  lines.push('⚠  Global plur install detected — this shadows `npx @latest` and prevents auto-updates.')
  lines.push('')
  for (const pkg of result.packages) {
    lines.push(`   Found: ${pkg.name}@${pkg.version}`)
  }
  if (result.plurBinaryPath) {
    lines.push(`   Binary: ${result.plurBinaryPath}`)
  }
  lines.push('')
  lines.push('   Fix: npm uninstall -g @plur-ai/mcp @plur-ai/cli')
  lines.push('   Then: npx @plur-ai/mcp@latest  (fetches the latest version each run)')
  return lines
}
