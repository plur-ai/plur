// #1904: the npm token is stage-only, so `pnpm publish` gets 403
// E_STAGE_REQUIRED. release.sh must pack each package and `npm stage publish`
// it, core first, then wait for the owner's passkey approval. Its dry run must
// print every stage command and stage nothing.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const HELPER = join(ROOT, 'scripts', 'release-stage-publish.sh')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// Every workspace package npm can receive: not marked private.
const publishable = readdirSync(join(ROOT, 'packages'))
  .filter((dir) => existsSync(join(ROOT, 'packages', dir, 'package.json')))
  .map((dir) => ({ dir, pkg: JSON.parse(read(`packages/${dir}/package.json`)) }))
  .filter(({ pkg }) => pkg.private !== true)
  .map(({ dir }) => dir)

// Stand-ins for npm and pnpm that record any call and fail it, so a dry run that
// reaches the registry, packs or publishes shows up in the log.
const stubDir = mkdtempSync(join(tmpdir(), 'plur-stage-stub-'))
const callLog = join(stubDir, 'calls.log')
for (const tool of ['npm', 'pnpm', 'npx']) {
  const path = join(stubDir, tool)
  writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${callLog}"\nexit 1\n`)
  chmodSync(path, 0o755)
}
afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

describe('the staged-publish step, dry run (#1904)', () => {
  const run = spawnSync(
    'bash',
    [HELPER, '--dry-run', '--version', '9.9.9', '--claw', '8.8.8', '--dsh', '7.7.7', '--opencode', '6.6.6'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` } },
  )
  const out = run.stdout ?? ''
  const stageLines = out.split('\n').filter((line) => /npm stage publish /.test(line))

  it('exits 0', () => {
    expect(run.status, run.stderr).toBe(0)
  })

  it('finds the publishable packages to check against', () => {
    expect(publishable).toEqual(expect.arrayContaining(['core', 'cli', 'mcp', 'migrate', 'claw', 'dsh', 'opencode']))
  })

  it.each(publishable)('prints `npm stage publish` for %s, to @next, public', (dir) => {
    const line = stageLines.find((l) => l.includes(`plur-ai-${dir}-`))
    expect(line, `no stage command for ${dir} in:\n${out}`).toBeDefined()
    expect(line).toMatch(/npm stage publish \S+\.tgz --access public --tag next/)
  })

  it('stages core first', () => {
    expect(stageLines[0]).toContain('plur-ai-core-9.9.9.tgz')
  })

  it('packs each package from inside its own folder', () => {
    for (const dir of publishable) {
      expect(out).toMatch(new RegExp(`cd packages/${dir} && pnpm pack --pack-destination`))
    }
  })

  it('prints the passkey approval and the move to latest', () => {
    expect(out).toMatch(/npm stage approve/)
    expect(out).toMatch(/npm dist-tag add @plur-ai\/core@9\.9\.9 latest/)
  })

  it('never runs npm, pnpm or npx, so nothing is packed, staged or published', () => {
    expect(existsSync(callLog) ? readFileSync(callLog, 'utf8') : '').toBe('')
  })
})

describe('release.sh publishes through staging (#1904)', () => {
  const script = read('scripts/release.sh')
  const code = script
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line))
    .join('\n')

  it('never calls `pnpm publish`', () => {
    expect(code).not.toMatch(/pnpm\b[^\n]*\bpublish\b/)
  })

  it('stages through the helper in the publish step', () => {
    expect(code).toMatch(/release-stage-publish\.sh"? --version "\$VERSION"/)
  })

  it('prints the stage commands in --dry-run', () => {
    // The block that ends the dry run: from its `if` to the stop message.
    const stop = script.indexOf('=== DRY RUN — stopping before publish ===')
    expect(stop).toBeGreaterThan(0)
    const start = script.lastIndexOf('if [ "$DRY_RUN" = true ]; then', stop)
    expect(script.slice(start, stop)).toMatch(/release-stage-publish\.sh"? --dry-run/)
  })
})
