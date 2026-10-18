#!/usr/bin/env node
/**
 * Stamp a CI-only version on the packages the Windows editor job installs
 * (#1605, M1). Run in CI before the build, never on a release tree.
 *
 *   node scripts/ci-stamp-version.mjs <suffix>      e.g. ci.1a2b3c4d
 *
 * core, mcp, cli and migrate get `<their version>-<suffix>` in package.json,
 * and the two compiled-in constants that report it (`VERSION` in
 * packages/mcp/src/version.ts, which the MCP server answers `initialize` with,
 * and `CLI_VERSION` in packages/cli/src/version.ts, which `plur --version`
 * prints and every npx fallback entry pins). The opencode plugin is on its own
 * track and gets `<its version>-<suffix>` in package.json and
 * `OPENCODE_PLUGIN_VERSION`.
 *
 * Nothing with these versions exists on the npm registry. So an editor entry
 * that fell back to `npx @plur-ai/...@<version>` cannot resolve and fails
 * loudly, and a server that answers with the stamped version is this build.
 *
 * Prints `PLUR_CI_VERSION=...` and `PLUR_CI_OPENCODE_VERSION=...`, for
 * $GITHUB_ENV.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const suffix = process.argv[2]
if (!suffix || !/^[0-9A-Za-z.]+$/.test(suffix)) {
  console.error('usage: ci-stamp-version.mjs <suffix> (letters, digits and dots)')
  process.exit(2)
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stampPackage(dir) {
  const file = join(repo, 'packages', dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const base = pkg.version.replace(/-.*$/, '')
  pkg.version = `${base}-${suffix}`
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  return pkg.version
}
function stampConst(file, name, version) {
  const path = join(repo, file)
  const text = readFileSync(path, 'utf8')
  const re = new RegExp(`(export const ${name} = )'[^']*'`)
  if (!re.test(text)) { console.error(`${name} not found in ${file}`); process.exit(1) }
  writeFileSync(path, text.replace(re, `$1'${version}'`))
}

const version = stampPackage('core')
for (const p of ['mcp', 'cli', 'migrate']) {
  if (stampPackage(p) !== version) { console.error(`packages/${p} is not on core's version`); process.exit(1) }
}
stampConst('packages/mcp/src/version.ts', 'VERSION', version)
stampConst('packages/cli/src/version.ts', 'CLI_VERSION', version)
const opencode = stampPackage('opencode')
stampConst('packages/opencode/src/version.ts', 'OPENCODE_PLUGIN_VERSION', opencode)

console.log(`PLUR_CI_VERSION=${version}`)
console.log(`PLUR_CI_OPENCODE_VERSION=${opencode}`)
