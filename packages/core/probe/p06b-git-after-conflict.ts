/**
 * P06b — what a sync does once engrams.yaml is unparseable (post-conflict).
 *
 * stageStrippedEngrams() returns early when readEngramList() can't parse the
 * file, so the VERBATIM staged blob (scope:local engrams + conflict markers)
 * is what gets committed and pushed.
 *
 * Run against the working directory left behind by p06 (pass its A path).
 */
import { sync as gitSync } from '../src/sync.js'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { join } from 'path'

const A = process.argv[2]
function git(args: string[]): string {
  try { return execFileSync('git', args, { cwd: A, encoding: 'utf8' }).trim() } catch (e: any) { return `ERR ${String(e.stderr ?? e.message).trim().split('\n')[0]}` }
}
console.log('pre-state:', git(['status', '--porcelain']).split('\n')[0])
let res: unknown
try { res = gitSync(A, undefined) } catch (e) { res = `THREW ${(e as Error).message}` }
console.log('sync result:', JSON.stringify(res))
const committed = git(['show', 'HEAD:engrams.yaml'])
console.log('committed blob has conflict markers:', committed.includes('<<<<<<<'))
console.log('committed blob has scope:local engrams (004/005):',
  /ENG-2026-08-02-004|ENG-2026-08-02-005/.test(committed))
console.log('remote now has markers:',
  git(['show', 'origin/main:engrams.yaml']).includes('<<<<<<<'))
console.log('working tree still unreadable:', fs.readFileSync(join(A, 'engrams.yaml'), 'utf8').includes('<<<<<<<'))
