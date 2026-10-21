import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { countUploadCandidates } from '../src/commands/upload.js'

it.each(['local', 'conflict', 'readonly'])('does not advertise uploads when the effective route is %s', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'enterprise-upload-count-'))
  let engine: Plur | undefined
  try {
    const scope = kind === 'local' ? 'user:example:member' : 'project:example/team/app', path = join(root, 'config.yaml')
    writeFileSync(path, JSON.stringify({ index: false, embeddings: { enabled: false } }))
    engine = new Plur({ path: root, autoDiscover: false })
    await engine.learn('A local engineering convention', { scope }); engine.close()
    const remote = { scope, url: 'https://server.example.invalid', token: 'fixture-key', readonly: kind === 'readonly' }
    const extra = kind === 'local' ? [{ scope, path: join(root, 'team.yaml') }] : kind === 'conflict' ? [{ ...remote, url: 'https://second.example.invalid' }] : []
    writeFileSync(path, JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [remote, ...extra] }))
    engine = new Plur({ path: root, autoDiscover: false, readonly: true })
    expect(await countUploadCandidates(engine, [scope])).toBe(0)
  } finally { engine?.close(); rmSync(root, { recursive: true, force: true }) }
})
