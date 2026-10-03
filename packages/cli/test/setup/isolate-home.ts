/**
 * Per-file isolation of every location a CLI test (or a CLI process it spawns)
 * could resolve the developer's real home or PLUR store from.
 *
 * Runs as a vitest `setupFiles` entry, so it executes in the worker before each
 * test file is imported: module-level `homedir()` calls and every child process
 * spawned without an explicit `env` (`execSync(...)` inherits `process.env`)
 * see the temp locations. Tests that forget isolation are therefore still
 * safe; tests that set their own HOME keep working, because they spread
 * `process.env` and override on top of it.
 *
 * Found by the 0.21.1 audit: hook-cursor-guard and hook-cursor-post-tool
 * spawned the CLI with no env and no --path (the folder-map migration in
 * core/src/folders.ts can write folders.yaml into the real ~/.plur), and
 * several suites set a temp HOME but inherited PLUR_PATH from the shell.
 *
 * PLUR_PATH, CODEX_HOME and OPENCODE_CONFIG_DIR are REMOVED rather than set:
 * each falls back to a location under HOME (now a temp dir), and a test that
 * sets its own HOME expects the store under that HOME. Pinning PLUR_PATH here
 * would send such a test's child to this file's temp store instead. The
 * backend/telemetry overrides are removed for the same reason as in
 * helpers/isolated-env.ts (#1399). Everything is restored after the file.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll } from 'vitest'

const SET = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'] as const
const REMOVED = [
  'PLUR_PATH',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'PLUR_BACKEND',
  'PLUR_POSTGRES_URL',
  'PLUR_TELEMETRY',
] as const

const saved = new Map<string, string | undefined>()
for (const key of [...SET, ...REMOVED]) saved.set(key, process.env[key])

const home = mkdtempSync(join(tmpdir(), 'plur-cli-test-home-'))
const xdg = join(home, '.config')
mkdirSync(xdg, { recursive: true })
// The temp HOME hides the developer's (or CI runner's) ~/.gitconfig, and with
// it the user identity `git commit` requires: the store's first sync commit
// failed with "empty ident name" on the CI runners. Give the temp HOME a test
// identity, as core's test/helpers/git-isolation.ts does. It also keeps a
// global gitignore that lists engrams.yaml out of the fixtures (#1062).
writeFileSync(join(home, '.gitconfig'), '[user]\n  name = PLUR Test\n  email = test@plur.ai\n')

process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_CONFIG_HOME = xdg
for (const key of REMOVED) delete process.env[key]

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})
