import { expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { enterpriseFixture, sourceCli } from '../helpers/enterprise-install.js'
it('EFI-9 a session removes obsolete untracked credentials but preserves tracked project settings', async () => {
  const f = await enterpriseFixture(), file = join(f.repo, '.plur.yaml')
  writeFileSync(join(f.store, 'folders.yaml'), JSON.stringify({ version: 1, folders: [{ path: f.repo, plur: 'on', trusted: true }] }))
  const legacy = `remote_url: ${f.url}\nremote_token: fixture-obsolete-token\n`
  const hook = () => sourceCli(['hook-codex-session-start'], { ...f.env, PLUR_REMOTE_RECALL: 'off' }, f.repo,
    JSON.stringify({ cwd: f.repo, session_id: `cleanup-${Date.now()}`, source: 'startup' }))
  try {
    writeFileSync(file, legacy)
    expect((await hook()).status, 'The cleanup must run through a successful session hook').toBe(0)
    expect(existsSync(file), 'An obsolete installer-only file should be removed after backup').toBe(false)
    writeFileSync(file, legacy + 'domain: release.operations\n')
    execFileSync('git', ['-C', f.repo, 'add', '--', '.plur.yaml'])
    const before = readFileSync(file)
    const retained = await hook()
    expect(retained.status, 'A tracked file must not prevent session startup').toBe(0)
    expect(readFileSync(file), 'Tracked credentials and project settings require an explicit user change').toEqual(before)
    expect(retained.stdout + retained.stderr, 'A warning must never print the retained credential').not.toContain('fixture-obsolete-token')
  } finally { await f.close() }
})
