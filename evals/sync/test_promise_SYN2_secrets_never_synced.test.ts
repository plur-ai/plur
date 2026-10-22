// SYN-2: Secrets and machine settings are never synced.
//
// Secrets and machine settings planted in the store folder: config.yaml (machine
// settings, holds remote tokens), secrets.yaml, a *.token file, an agent
// keystore, a derived index (engrams.db) and a stray .env inside an installed
// pack. None may appear in what the remote receives; the memories must.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { bareRemote, cloneRemote, git, isolateGit } from '../helpers/sync-packs-durability-history-git.js'

const MARK = 'EVAL-SECRET-7f3c9a'

function plantSecrets(dir: string): void {
  appendFileSync(join(dir, 'config.yaml'), `# remote token ${MARK}-config\n`)
  writeFileSync(join(dir, 'secrets.yaml'), `api_key: ${MARK}-secrets\n`)
  writeFileSync(join(dir, 'remote.token'), `${MARK}-token\n`)
  writeFileSync(join(dir, 'agent-keystore.json'), `{"key":"${MARK}-keystore"}\n`)
  writeFileSync(join(dir, 'engrams.db'), `${MARK}-db`)
  mkdirSync(join(dir, 'packs', 'some-pack'), { recursive: true })
  writeFileSync(join(dir, 'packs', 'some-pack', 'SKILL.md'), '---\nname: some-pack\n---\nA pack.\n')
  writeFileSync(join(dir, 'packs', 'some-pack', '.env'), `TOKEN=${MARK}-packenv\n`)
}

const SECRET_FILES = ['config.yaml', 'secrets.yaml', 'remote.token', 'agent-keystore.json', 'engrams.db', 'packs/some-pack/.env']

describe('SYN-2 secrets and machine settings are never synced', () => {
  const cleanups: Array<() => void> = []
  let s: TempStore
  afterEach(() => { s?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('a first sync to my repository carries memories but no secret or machine file', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    const m = await s.plur.learn('Use pnpm, not npm, in this repository', { scope: 'global' })
    plantSecrets(s.dir)

    const remote = bareRemote(); cleanups.push(remote.cleanup)
    await s.plur.sync(remote.path)
    const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)

    expect(clone.engrams.map(e => e.id), 'precondition: the memory itself was synced').toContain(m.id)
    expect(clone.files, 'precondition: the pack file PLUR writes was synced').toContain('packs/some-pack/SKILL.md')
    for (const f of SECRET_FILES) expect(clone.files, `${f} was pushed to the sync repository`).not.toContain(f)
    expect(clone.text, 'a secret value appears in the files pushed to the sync repository').not.toContain(MARK)
  })

  it('a repository where an older version committed config.yaml stops carrying it', async () => {
    isolateGit()
    s = await tempStore({ embedder: 'off' })
    const m = await s.plur.learn('Run the linter before every commit', { scope: 'global' })
    plantSecrets(s.dir)
    // An older client tracked config.yaml in the sync repository.
    git(['init', '--quiet', '-b', 'main'], s.dir)
    git(['add', '-f', 'config.yaml', 'engrams.yaml'], s.dir)
    git(['commit', '--quiet', '-m', 'old client'], s.dir)
    expect(git(['ls-files'], s.dir).split('\n'), 'precondition: config.yaml was tracked before the sync').toContain('config.yaml')

    const remote = bareRemote(); cleanups.push(remote.cleanup)
    await s.plur.sync(remote.path)
    const clone = cloneRemote(remote.path); cleanups.push(clone.cleanup)

    expect(clone.engrams.map(e => e.id), 'precondition: the memory itself was synced').toContain(m.id)
    for (const f of SECRET_FILES) expect(clone.files, `${f} is in the sync repository after the sync`).not.toContain(f)
    expect(clone.text, 'a secret value appears in the files pushed to the sync repository').not.toContain(MARK)
  })
})
