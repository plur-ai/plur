/**
 * P09b — setSchemaVersion() ignores the config.yaml lock.
 *
 * persistStores() / persistDismissedScopes() serialize their read-modify-write
 * with withLock(paths.config) (#685 / scope-audit 2026-07-24). runMigrations'
 * setSchemaVersion() does the same read-modify-write with no lock at all, so it
 * writes straight through a held lock and the two last-writer-wins each other.
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

  // Meanwhile `plur migrate` finishes and stamps the schema version.
  setSchemaVersion(cfg, 5)
  bypassed = (yaml.load(fs.readFileSync(cfg, 'utf8')) as any).schema_version === 5

  // The locked writer completes, from the snapshot it read BEFORE the bypass.
  fs.writeFileSync(cfg, yaml.dump(mine, { lineWidth: 120, noRefs: true }))
})

const final = yaml.load(fs.readFileSync(cfg, 'utf8')) as Record<string, unknown>
if (final.schema_version !== 5) lost.push('schema_version=5 (migration marker)')
console.log('setSchemaVersion wrote while the config lock was held:', bypassed)
console.log('final config:', JSON.stringify(final).slice(0, 160))
console.log(lost.length
  ? `LOST UPDATE — ${lost.join(', ')} erased; migrations will re-run against an already-migrated store`
  : 'no lost update')
fs.rmSync(root, { recursive: true, force: true })
