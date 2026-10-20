import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

let home: string, repo: string, root: string, file: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-legacy-hook-')))
  repo = join(home, 'repo'); root = join(home, '.plur'); mkdirSync(repo); mkdirSync(root); mkdirSync(join(home, 'tmp'))
  execFileSync('git', ['init', '-q', repo]); file = join(repo, '.plur.yaml')
  writeFileSync(file, 'remote_url: http://127.0.0.1:1\nremote_token: fixture-private-key\nremote_scopes: []\n')
  writeFileSync(join(root, 'folders.yaml'), JSON.stringify({ version: 1, folders: [{ path: repo, plur: 'on' }] }))
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [
    { url: 'http://127.0.0.1:1', scope: 'user:example:fixture', token: 'fixture-key', enterprise: {} },
  ] }))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
function hook(command: string, extra: Record<string, unknown> = {}) {
  return spawnSync(process.execPath, [CLI, command], {
    cwd: repo, encoding: 'utf8', timeout: 25_000,
    env: { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_DISABLE_EMBEDDINGS: '1', PLUR_HOOK_HYBRID: 'off' },
    input: JSON.stringify({ cwd: repo, workspace_roots: [repo], session_id: 'fixture-session', conversation_id: 'fixture-conversation', hook_event_name: 'SessionStart', source: 'startup', ...extra }),
  })
}
it.each(['hook-inject', 'hook-codex-session-start', 'hook-cursor-session-start'])('%s cleans the old file in a real isolated process', command => {
  const result = hook(command)
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(file), result.stdout + result.stderr).toBe(false)
  expect(result.stdout + result.stderr).not.toContain('fixture-private-key')
}, 30_000)
it.each(['hook-inject', 'hook-codex-session-start', 'hook-cursor-session-start'])('%s leaves disabled folders unchanged', command => {
  writeFileSync(join(root, 'folders.yaml'), JSON.stringify({ version: 1, folders: [{ path: repo, plur: 'off' }] }))
  const original = readFileSync(file, 'utf8'), result = hook(command)
  expect(result.status, result.stderr).toBe(0); expect(readFileSync(file, 'utf8')).toBe(original)
}, 30_000)
