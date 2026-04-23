#!/usr/bin/env node
// Postinstall runner. Must never fail an install, ever.
// Imports the built module when present; no-ops silently otherwise
// (monorepo dev before `pnpm build`, CI, --ignore-scripts, etc.).
try {
  const mod = await import('../dist/postinstall.js')
  const rc = mod.runPostinstallCli()
  process.exit(typeof rc === 'number' ? rc : 0)
} catch {
  process.exit(0)
}
