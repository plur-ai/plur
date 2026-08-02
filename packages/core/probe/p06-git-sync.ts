/**
 * P06 — plur_sync git paths. Can a sync lose local engrams?
 *
 * Models two machines sharing one bare remote, with the strip-on-commit
 * behaviour (#640/#380) that makes the working tree permanently differ from
 * HEAD, and probes:
 *   A. does the committed blob match the working tree?
 *   B. what does the second sync do when the remote moved ahead?
 *   C. same, with rebase.autoStash=true (a very common global git setting)
 *   D. merge-conflict resolution path ("kept both")
 */
import { sync as gitSync } from '../src/sync.js'
import { loadEngrams } from '../src/engrams.js'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'

function git(args: string[], cwd: string): string {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim() } catch (e: any) { return `ERR: ${String(e.stderr ?? e.message).trim().split('\n')[0]}` }
}

function engramDoc(ids: Array<[string, string]>): string {
  return yaml.dump({
    engrams: ids.map(([id, scope]) => ({
      id, version: 2, status: 'active', consolidated: false, type: 'behavioral', scope,
      visibility: 'private', statement: `statement of ${id}`,
      activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-02' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
      knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
      abstract: null, derived_from: null, polarity: null, content_hash: `h-${id}`,
      commitment: 'leaning', reference_count: 1, sources: [], recurrence_count: 0,
      summary: id, engram_version: 1, episode_ids: [],
    })),
  }, { lineWidth: 120, noRefs: true, quotingType: '"' })
}

function countCommitted(root: string): number {
  const blob = git(['show', 'HEAD:engrams.yaml'], root)
  if (blob.startsWith('ERR')) return -1
  const doc = yaml.load(blob) as any
  return Array.isArray(doc?.engrams) ? doc.engrams.length : -1
}

function countWorking(root: string): number | string {
  try { return loadEngrams(join(root, 'engrams.yaml')).length } catch (e) { return `THROWS ${(e as Error).name}` }
}

const base = fs.mkdtempSync(join(os.tmpdir(), 'plur-p06-'))
const remote = join(base, 'remote.git')
fs.mkdirSync(remote)
git(['init', '--bare', '-b', 'main'], remote)

// --- machine A: 3 global + 2 local engrams ---
const A = join(base, 'A'); fs.mkdirSync(A)
fs.writeFileSync(join(A, 'engrams.yaml'), engramDoc([
  ['ENG-2026-08-02-001', 'global'], ['ENG-2026-08-02-002', 'global'], ['ENG-2026-08-02-003', 'global'],
  ['ENG-2026-08-02-004', 'local'], ['ENG-2026-08-02-005', 'local'],
]))
git(['-c', 'init.defaultBranch=main', 'init'], A)
git(['config', 'user.email', 'p@p'], A); git(['config', 'user.name', 'p'], A)
console.log('A sync#1:', JSON.stringify(gitSync(A, remote)))
console.log(`A: working=${countWorking(A)} committed=${countCommitted(A)}  (personal remote strips scope:local)`)
console.log('A dirty after sync:', git(['status', '--porcelain'], A) || '(clean)')

// --- machine B: clone, add one engram, push ---
const B = join(base, 'B')
git(['clone', remote, B], base)
git(['config', 'user.email', 'p@p'], B); git(['config', 'user.name', 'p'], B)
const bDoc = yaml.load(fs.readFileSync(join(B, 'engrams.yaml'), 'utf8')) as any
console.log(`B fresh clone sees ${bDoc.engrams.length} engrams (A had 5 on disk)`)
fs.writeFileSync(join(B, 'engrams.yaml'), engramDoc([
  ['ENG-2026-08-02-001', 'global'], ['ENG-2026-08-02-002', 'global'], ['ENG-2026-08-02-003', 'global'],
  ['ENG-2026-08-02-010', 'global'],
]))
console.log('B sync:', JSON.stringify(gitSync(B)))
git(['push', 'origin', 'main'], B)

// --- C: A syncs again while behind. First WITHOUT autostash ---
console.log('\n--- A sync#2, no autostash ---')
let res: unknown
try { res = gitSync(A, undefined) } catch (e) { res = `THREW ${(e as Error).message}` }
console.log('result:', JSON.stringify(res))
console.log(`A: working=${countWorking(A)} committed=${countCommitted(A)} behindRemote=${git(['rev-list', '--count', 'HEAD..origin/main'], A)}`)

// --- D: same again WITH rebase.autoStash ---
console.log('\n--- A sync#3, rebase.autoStash=true ---')
git(['config', 'rebase.autoStash', 'true'], A)
git(['config', 'pull.rebase', 'true'], A)
// move the remote ahead once more
fs.writeFileSync(join(B, 'engrams.yaml'), engramDoc([
  ['ENG-2026-08-02-001', 'global'], ['ENG-2026-08-02-002', 'global'], ['ENG-2026-08-02-003', 'global'],
  ['ENG-2026-08-02-010', 'global'], ['ENG-2026-08-02-011', 'global'],
]))
gitSync(B); git(['push', 'origin', 'main'], B)
const beforeIds = (() => { try { return loadEngrams(join(A, 'engrams.yaml')).map(e => e.id) } catch { return ['<unreadable>'] } })()
try { res = gitSync(A, undefined) } catch (e) { res = `THREW ${(e as Error).message}` }
console.log('result:', JSON.stringify(res))
const afterIds = (() => { try { return loadEngrams(join(A, 'engrams.yaml')).map(e => e.id) } catch (e) { return [`<${(e as Error).name}>`] } })()
console.log('A ids before:', beforeIds.join(','))
console.log('A ids after :', afterIds.join(','))
const lost = beforeIds.filter(i => !afterIds.includes(i))
console.log(lost.length ? `LOSS — local engrams gone from working tree: ${lost.join(',')}` : 'no working-tree loss')
console.log('A raw file head:', fs.readFileSync(join(A, 'engrams.yaml'), 'utf8').split('\n').slice(0, 3).join(' | '))
console.log('A stash list:', git(['stash', 'list'], A) || '(empty)')
console.log('\nbase:', base)
