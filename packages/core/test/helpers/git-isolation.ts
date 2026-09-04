import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeAll, afterAll } from 'vitest'

/**
 * Isolate every git this suite spawns — directly or through sync.ts — from
 * the developer's global/system git config.
 *
 * Without it, a global gitignore listing `engrams.yaml` silently empties
 * `git add -A`, the seed commit fails with "nothing to commit", and every
 * test in the fixture dies in beforeEach (#1062). That environment is not
 * exotic for THIS project: globally ignoring the memory store is exactly how
 * a PLUR user keeps `~/.plur/engrams.yaml` clones out of every repository.
 *
 * The scratch global config still carries a user identity, because
 * `git commit` refuses to run without one and not every fixture sets it
 * locally.
 *
 * First solved inline in sync.test.ts for #329; hoisted here because the two
 * git-spawning test files written since then each forgot it — a shared
 * helper is the version the NEXT file cannot forget.
 */
export function isolateGitConfig(): void {
  let tmpConfigDir: string
  let origGlobal: string | undefined
  let origSystem: string | undefined

  beforeAll(() => {
    origGlobal = process.env.GIT_CONFIG_GLOBAL
    origSystem = process.env.GIT_CONFIG_SYSTEM
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'plur-gitconfig-'))
    const configFile = join(tmpConfigDir, 'gitconfig')
    writeFileSync(configFile, '[user]\n  name = PLUR Test\n  email = test@plur.ai\n')
    process.env.GIT_CONFIG_GLOBAL = configFile
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  })

  afterAll(() => {
    if (origGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = origGlobal
    if (origSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
    else process.env.GIT_CONFIG_SYSTEM = origSystem
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })
}
