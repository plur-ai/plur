#!/usr/bin/env node
// Plugin core-range check (#1831).
//
// The opencode, claw and dsh plugins are on their own version tracks, so a core
// release does not republish them. Users who install everything at `latest`
// get the plugin's `latest`, and it must work with the core being released.
// Each plugin declares @plur-ai/core as a range (opencode and claw as a peer
// and a regular dependency, dsh as a regular dependency only); this check fails
// when a requirement does not include the core version.
//
//   node scripts/check-plugin-core-range.mjs --core <version> [--releasing opencode,claw,dsh] [--post]
//
// Without --post (release.sh Step 0.5, before anything changes):
//   - every plugin's workspace manifest must declare the range and include <version>;
//   - every plugin NOT being released must have a published `latest` whose core
//     requirement includes <version>. A plugin being released is judged on its
//     workspace manifest, because that is what will be published.
// With --post (release.sh Step 9b, after publishing): only the published
// `latest` of every plugin is checked.
//
// Exit codes: 0 every requirement includes <version>; 1 at least one does not;
// 2 could not check (npm missing or unreachable, package not found, answer not
// JSON, semver missing, bad arguments). 2 is never a pass. A definite failure
// (1) is reported over a could-not-check (2), since both stop a release.
//
// npm runs only as `process.execPath <npm-cli.js>`, never as a bare `npm`.
// PLUR_RELEASE_NPM_CLI overrides the npm-cli.js path and PLUR_RELEASE_ROOT the
// repository root; both exist for the tests.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE = '@plur-ai/core'
const PLUGINS = ['opencode', 'claw', 'dsh']
// pnpm 11's hoisted linker with autoInstallPeers: false (DeepSeek Harness profiles) does not link a package declared as both peer and dependency.
const DEPENDENCY_ONLY = new Set(['dsh'])
const USAGE = 'usage: check-plugin-core-range.mjs --core <version> [--releasing opencode,claw,dsh] [--post]'

class CouldNotCheck extends Error {}

function parseArgs(argv) {
  const out = { core: '', releasing: new Set(), post: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--post') out.post = true
    else if (arg === '--core') out.core = argv[++i] ?? ''
    else if (arg === '--releasing') {
      for (const name of (argv[++i] ?? '').split(',').filter(Boolean)) {
        if (!PLUGINS.includes(name)) throw new CouldNotCheck(`unknown plugin in --releasing: ${name}\n${USAGE}`)
        out.releasing.add(name)
      }
    } else throw new CouldNotCheck(`unknown argument: ${arg}\n${USAGE}`)
  }
  if (!out.core) throw new CouldNotCheck(`--core is required\n${USAGE}`)
  return out
}

/** The npm CLI beside the running Node: the `npm` link next to it, then the Windows and Unix layouts. */
function npmCli() {
  if (process.env.PLUR_RELEASE_NPM_CLI) return process.env.PLUR_RELEASE_NPM_CLI
  const dir = dirname(process.execPath)
  const candidates = [join(dir, 'node_modules/npm/bin/npm-cli.js'), join(dir, '../lib/node_modules/npm/bin/npm-cli.js')]
  try {
    const linked = realpathSync(join(dir, 'npm'))
    if (linked.endsWith('npm-cli.js')) candidates.unshift(linked)
  } catch { /* no npm link beside node */ }
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new CouldNotCheck(`no npm-cli.js beside ${process.execPath}`)
  return found
}

/** The published `latest` manifest of a package, or CouldNotCheck. */
function publishedLatest(name) {
  const run = spawnSync(process.execPath, [npmCli(), 'view', `${name}@latest`, '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error) throw new CouldNotCheck(`${name}: could not run npm (${run.error.message})`)
  let answer
  try {
    answer = JSON.parse(run.stdout)
  } catch {
    throw new CouldNotCheck(`${name}: npm view did not answer JSON (exit ${run.status}): ${(run.stderr || run.stdout).trim().split('\n')[0] ?? ''}`)
  }
  if (answer?.error) {
    const what = answer.error.code === 'E404' ? 'not found on the registry' : `npm error ${answer.error.code ?? ''}: ${answer.error.summary ?? ''}`
    throw new CouldNotCheck(`${name}: ${what.trim()}`)
  }
  if (run.status !== 0 || !answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.version !== 'string') {
    throw new CouldNotCheck(`${name}: unexpected npm view answer (exit ${run.status})`)
  }
  return answer
}

/** Does a core requirement admit `core`? Returns a problem string, or null when it does. */
function judge(semver, requirement, core) {
  if (!requirement) return `declares no ${CORE} requirement`
  if (requirement.startsWith('workspace:')) return `has an unpublished specifier ${requirement}`
  if (semver.valid(requirement)) {
    return semver.eq(requirement, core) ? null : `pins ${CORE} ${requirement} exactly`
  }
  if (!semver.validRange(requirement)) return `has an invalid ${CORE} range "${requirement}"`
  return semver.satisfies(core, requirement, { includePrerelease: true })
    ? null
    : `requires ${CORE} "${requirement}", which excludes ${core}`
}

/** Problems with a plugin's workspace manifest: the range shape, and whether it includes `core`. */
function checkWorkspace(semver, root, plugin, core) {
  const path = join(root, 'packages', plugin, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CouldNotCheck(`packages/${plugin}/package.json: ${error.message}`)
  }
  const peer = pkg.peerDependencies?.[CORE]
  const dep = pkg.dependencies?.[CORE]
  const problems = []
  if (DEPENDENCY_ONLY.has(plugin)) {
    const range = dep?.startsWith('workspace:') ? dep.slice('workspace:'.length) : undefined
    if (peer) problems.push(`must not declare a ${CORE} peer dependency (dependency only)`)
    if (!range || range === '*' || semver.valid(range)) problems.push(`dependency ${CORE} must be workspace:<range>, not "${dep ?? '(none)'}"`)
    else {
      const verdict = judge(semver, range, core)
      if (verdict) problems.push(`dependency ${verdict}`)
    }
  } else if (!peer) problems.push(`declares no ${CORE} peer dependency`)
  else if (peer.startsWith('workspace:') || semver.valid(peer)) problems.push(`peer ${CORE} must be a published range, not "${peer}"`)
  else {
    const verdict = judge(semver, peer, core)
    if (verdict) problems.push(`peer ${verdict}`)
  }
  if (!DEPENDENCY_ONLY.has(plugin) && peer && dep !== `workspace:${peer}`) problems.push(`dependency ${CORE} is "${dep ?? '(none)'}", expected "workspace:${peer}"`)
  if (pkg.devDependencies?.[CORE]) problems.push(`${CORE} must not also be a devDependency`)
  return problems.map((problem) => `workspace @plur-ai/${plugin} ${problem}`)
}

export async function main(argv = process.argv.slice(2)) {
  let semver
  try {
    semver = (await import('semver')).default
  } catch (error) {
    console.error(`? could not check: semver is not importable (${error.message}). Run pnpm install.`)
    return 2
  }

  const failures = []
  const unknowns = []
  const behind = []
  let args
  try {
    args = parseArgs(argv)
    if (!semver.valid(args.core)) throw new CouldNotCheck(`--core ${args.core} is not a version`)
  } catch (error) {
    console.error(`? could not check: ${error.message}`)
    return 2
  }
  const root = resolve(process.env.PLUR_RELEASE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'))

  for (const plugin of PLUGINS) {
    const name = `@plur-ai/${plugin}`
    try {
      if (!args.post) {
        const problems = checkWorkspace(semver, root, plugin, args.core)
        failures.push(...problems)
        if (problems.length === 0) console.log(`  ✓ workspace ${name} declares a ${CORE} range that includes ${args.core}`)
        if (args.releasing.has(plugin)) continue
      }
      const manifest = publishedLatest(name)
      const requirement = manifest.peerDependencies?.[CORE] ?? manifest.dependencies?.[CORE]
      const problem = judge(semver, requirement, args.core)
      if (problem) {
        failures.push(`published ${name}@${manifest.version} ${problem}`)
        behind.push(plugin)
      } else {
        console.log(`  ✓ published ${name}@${manifest.version} accepts ${CORE} ${args.core} (${requirement})`)
      }
    } catch (error) {
      if (!(error instanceof CouldNotCheck)) throw error
      unknowns.push(error.message)
    }
  }

  for (const failure of failures) console.error(`  ✗ ${failure}`)
  for (const unknown of unknowns) console.error(`  ? could not check: ${unknown}`)
  if (behind.length > 0) {
    const flags = behind.map((plugin) => `--${plugin} <next version>`).join(' ')
    console.error('')
    console.error(`  Users who install these plugins at latest would run a ${CORE} that is not ${args.core}.`)
    console.error(args.post
      ? `  Release them with a core that matches: ./scripts/release.sh <version> ${flags}`
      : `  Release them together with this core: add ${flags} to this release.`)
    console.error(`  A plugin published before ${CORE} became a range dependency (#1831) pins one exact`)
    console.error('  core, so the first release after that change must include all three plugin flags.')
  }
  if (failures.length > 0) return 1
  if (unknowns.length > 0) {
    console.error('  Could not check every plugin. This is not a pass: restore npm access and re-run.')
    return 2
  }
  return 0
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main()
}
