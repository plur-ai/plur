/**
 * P09b — setSchemaVersion() and the config.yaml lock.
 *
 * persistStores() / persistDismissedScopes() serialize their read-modify-write
 * with withLock(paths.config) (#685 / scope-audit 2026-07-24). setSchemaVersion()
 * did the same read-modify-write with NO lock, so it wrote straight through a
 * held lock and the two last-writer-wins each other — measured here as
 * `schema_version=5` erased, after which migrations re-run against an
 * already-migrated store.
 *
 * FIXED in #805 (audit F12): it now takes the same lock. This probe asserts the
 * bypass is closed — the write must NOT land while another writer holds the
 * lock. In production the two are separate processes and the migrate side
 * retries; here the holder never releases, so the correct outcome is that
 * setSchemaVersion fails loudly rather than corrupting the config quietly.
 */
import { setSchemaVersion } from '../src/migrations/runner.js'
import { withLock } from '../src/sync.js'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'

const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p09b-'))
const cfg = join(root, 'config.yaml')
fs.writeFileSync(cfg, yaml.dump({ auto_learn: true, schema_version: 2 }))

let bypassed = false
let lost: string[] = []
withLock(cfg, () => {
  // A locked writer's read-modify-write, mid-flight (this is exactly the shape
  // of persistStores: read, merge, write).
  const mine = yaml.load(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>
  mine.stores = [{ url: 'https://plur.datafund.io', scope: 'group:plur/engineering', token: 'SECRET' }]

  // Meanwhile `plur migrate` finishes and tries to stamp the schema version.
  try {
    setSchemaVersion(cfg, 5)
  } catch {
    /* expected: the lock is held and never released in this probe */
  }
  bypassed = (yaml.load(fs.readFileSync(cfg, 'utf8')) as any).schema_version === 5

  // The locked writer completes, from the snapshot it read BEFORE the bypass.
  fs.writeFileSync(cfg, yaml.dump(mine, { lineWidth: 120, noRefs: true }))
})

const final = yaml.load(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>
if (final.schema_version !== 5) lost.push('schema_version=5 (migration marker)')
console.log('setSchemaVersion wrote while the config lock was held:', bypassed)
console.log('final config:', JSON.stringify(final).slice(0, 160))
console.log(lost.length
  ? `no lost update possible — ${lost.join(', ')} never landed, because the lock held`
  : 'no lost update')
console.log(bypassed
  ? 'FAIL: setSchemaVersion still writes through a held config lock'
  : 'PASS: setSchemaVersion respects the config lock (#805, F12)')
fs.rmSync(root, { recursive: true, force: true })
