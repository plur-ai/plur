/**
 * A fake `npm install -g` of this workspace's built @plur-ai/cli (and,
 * optionally, @plur-ai/mcp) under `<prefix>/lib/node_modules/@plur-ai/`, the
 * layout `plur init` resolves the MCP package from (resolveMcpEntrypoint).
 *
 * Each package's `dist` and `package.json` are copied, so the running CLI's
 * own location is inside the prefix; `node_modules` is a symlink to the
 * workspace package's, so @plur-ai/core and the other dependencies resolve.
 * The version constant compiled into the copy (`CLI_VERSION`, `VERSION`) and
 * the copied package.json are stamped with `version`, so a second call with
 * a newer version is an in-place global upgrade: same paths, new files.
 *
 * Needs a built workspace (`pnpm build`).
 *
 * Kept out of test/helpers/: files there count as eval judge code
 * (scripts/check-eval-separation.py), and this one is only a fixture for the
 * #1832 tests.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

const PACKAGES = join(__dirname, '..', '..')

function stamp(dir: string, pattern: RegExp, replacement: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { stamp(p, pattern, replacement); continue }
    if (!name.endsWith('.js')) continue
    const src = readFileSync(p, 'utf8')
    const out = src.replace(pattern, replacement)
    if (out !== src) writeFileSync(p, out)
  }
}

function install(prefix: string, pkg: 'cli' | 'mcp', version: string): string {
  const from = join(PACKAGES, pkg)
  const to = join(prefix, 'lib', 'node_modules', '@plur-ai', pkg)
  if (!existsSync(join(from, 'dist', 'index.js'))) throw new Error(`packages/${pkg} is not built — run pnpm build`)
  // An upgrade replaces the package's files at the same path, as npm does.
  rmSync(join(to, 'dist'), { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true })
  if (pkg === 'mcp' && existsSync(join(from, 'packs'))) {
    rmSync(join(to, 'packs'), { recursive: true, force: true })
    cpSync(join(from, 'packs'), join(to, 'packs'), { recursive: true })
  }
  const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  writeFileSync(join(to, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n')
  if (!existsSync(join(to, 'node_modules'))) symlinkSync(realpathSync(join(from, 'node_modules')), join(to, 'node_modules'), 'dir')
  const constant = pkg === 'cli' ? 'CLI_VERSION' : 'VERSION'
  stamp(join(to, 'dist'), new RegExp(`var ${constant} = "[^"]*";`, 'g'), `var ${constant} = "${version}";`)
  return join(to, 'dist', 'index.js')
}

/** Install (or upgrade in place) the fake global packages; returns the CLI entry. */
export function fakeGlobalInstall(prefix: string, opts: { version: string; withMcp: boolean }): { cli: string; mcp: string | null } {
  const cli = install(prefix, 'cli', opts.version)
  const mcp = opts.withMcp ? install(prefix, 'mcp', opts.version) : null
  return { cli, mcp }
}
