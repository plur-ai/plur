import { execSync } from 'child_process'

export interface GlobalInstallResult {
  found: boolean
  packages: Array<{ name: string; version: string }>
  plurBinaryPath: string | null
}

const GLOBAL_PATH_PATTERNS = ['/homebrew/', '/usr/local/', '/usr/bin/', '/usr/share/']

/**
 * Detect globally installed plur packages that shadow `npx @latest` resolution.
 * Safe to call at startup — all subprocesses time out and failures are swallowed.
 */
export function checkGlobalInstall(): GlobalInstallResult {
  const packages: Array<{ name: string; version: string }> = []

  for (const pkg of ['@plur-ai/mcp', '@plur-ai/cli']) {
    try {
      const out = execSync(`npm list -g ${pkg} --depth=0`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      // Output: /opt/homebrew/lib\n└── @plur-ai/mcp@0.7.7\n
      const m = out.match(/@[\w-]+\/[\w-]+@([\w.+-]+)/)
      if (m) packages.push({ name: pkg, version: m[1] })
    } catch {
      // not globally installed or npm unavailable
    }
  }

  let plurBinaryPath: string | null = null
  try {
    const p = execSync('which plur', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (p && GLOBAL_PATH_PATTERNS.some((pat) => p.includes(pat))) plurBinaryPath = p
  } catch {
    // `which` failed or plur not on PATH
  }

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
