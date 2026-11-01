import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import * as yaml from 'js-yaml'
import { join, relative } from 'path'
import { atomicWrite } from './atomic-write.js'
import { recordLastWritten } from './backup.js'
import { ENGRAM_ID_TOKEN, engramStoreEntries, freshDuplicateId, heldRecoveryPath, mergeHeldRecords, readHeldMergeRenames, readHeldRecovery, recordIdRenames, renameEngramIdRefs, sameEngramContent, SYNC_HELD_RENAME_REASON, writeHeldRecovery, type HeldFile, type IdRename } from './engrams.js'
import { recordStoreSync, storeRecordMap } from './history.js'
import { isRemoteOnlyQueued } from './remote-only-rows.js'
import { isSharedScope } from './scope-util.js'
import {
    GIT_COMMAND_TIMEOUT_MS,
    heartbeatHeldLocks
} from './store/async-lock.js'


export interface SyncStatus {
  initialized: boolean
  remote: string | null
  dirty: boolean
  branch: string | null
  ahead: number
  behind: number
}

/**
 * What the sync remote is for. `personal` (default): the user's own
 * backup/mirror across their machines — every non-`scope:local` engram is
 * pushed, private included. `shared`: a team-visible remote —
 * ONLY shared-family-scope, non-private engrams are pushed; personal-family and
 * private engrams never leave the machine. On both, a side record (episode,
 * candidate, tension) that names an engram outside the push set stays home too.
 */
export type SyncRemoteType = 'personal' | 'shared'

export interface SyncResult {
  action: 'initialized' | 'committed' | 'synced' | 'up-to-date'
  message: string
  remote: string | null
  files_changed: number
  /** Present when syncing to a remote — describes what the push set includes/excludes. */
  warning?: string
  /**
   * Set when the commit succeeded but `git push` did NOT. The local repo is
   * ahead of the remote and the engrams are not on the server.
   *
   * `action` stays `'synced'` because the local commit genuinely happened —
   * the same split used for a failed outbox flush. A caller that cares whether
   * the data reached the remote must read this field, not `action`.
   */
  push_error?: string
}

const GITIGNORE = `# PLUR — secrets (machine-local, NEVER synced)
config.yaml
secrets.yaml
agent-keystore.json
*.token
keys/

# PLUR — derived/cache files (regenerated automatically)
embeddings/
.embeddings-cache.json
.embeddings-cache.delta.jsonl
.embeddings-cache.json.lock
*.db
*.sqlite
store.pglite/
exchange/

# PLUR — local backups. Machine-local by design: a snapshot is a
# whole-corpus copy INCLUDING scope:local engrams, so pushing one would leak
# exactly the engrams the scope strip exists to hold back.
backups/
*.superseded-*
`

/**
 * Files that constitute the syncable engram store. ONLY these are ever staged by
 * plur sync — an explicit allowlist, so secrets (config.yaml) and machine-local
 * derived files (engrams.db, store.pglite/, exchange/) can NEVER ride along into a
 * synced repo, regardless of how the user's gitignore is (mis)configured.
 */
const SYNC_PATHS = ['engrams.yaml', 'episodes.yaml', 'candidates.yaml', 'tensions.yaml', 'packs', '.gitignore'] as const

/**
 * Secret-bearing files that must never be tracked. Untracked on every sync, so a
 * repo where an older client already committed one stops carrying it forward.
 * Includes `agent-keystore.json` (an encrypted agent key). (Rotating an exposed
 * token/key and purging git history remain manual, operational steps — code
 * can only stop the bleeding.)
 */
const SECRET_PATHS = ['config.yaml', 'secrets.yaml', 'agent-keystore.json'] as const

/**
 * Files inside a pack that are syncable — an explicit ALLOWLIST, mirroring the
 * root-level SYNC_PATHS. `packs/` is force-added (`-f`) recursively, and packs come
 * from external/untrusted sources, so a denylist of secret filenames is the wrong
 * shape: it only blocks the names it enumerates, and anything it misses
 * (`.env`, `*.pem`, `id_rsa`, `credentials.yml`, `.npmrc`, …) rides into the synced
 * repo. An allowlist inverts that — ONLY the files PLUR's own `exportPack`
 * writes are staged; any other file in a pack dir (a secret, a stray asset) is
 * never staged, by construction. (`**` matches the standard `packs/<name>/…` layout
 * and any deeper nesting.)
 */
const PACK_ALLOW_NAMES = ['SKILL.md', 'engrams.yaml', 'INTEGRITY', 'metadata.json'] as const

function git(args: string[], cwd: string): string {
  // A git command blocks the event loop for up to its 30 s timeout, so a lock
  // held around sync (Plur.sync holds the store lock) cannot heartbeat from a
  // timer. Touch it here, before each command.
  heartbeatHeldLocks()
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_COMMAND_TIMEOUT_MS }).trim()
}

function gitSafe(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, '.git'))
}

function hasGitCli(): boolean {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function getRemote(root: string): string | null {
  return gitSafe(['remote', 'get-url', 'origin'], root)
}

function isDirty(root: string): boolean {
  const status = gitSafe(['status', '--porcelain'], root)
  return status !== null && status.length > 0
}

function countDiff(root: string, direction: 'ahead' | 'behind'): number {
  const tracking = gitSafe(['rev-parse', '--abbrev-ref', '@{u}'], root)
  if (!tracking) return 0
  const flag = direction === 'ahead' ? '--left-only' : '--right-only'
  const count = gitSafe(['rev-list', flag, '--count', 'HEAD...@{u}'], root)
  return count ? parseInt(count, 10) : 0
}

export function getSyncStatus(root: string): SyncStatus {
  if (!isGitRepo(root)) {
    return { initialized: false, remote: null, dirty: false, branch: null, ahead: 0, behind: 0 }
  }
  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const remote = getRemote(root)
  // Fetch remote state if available (ignore errors for offline)
  if (remote) gitSafe(['fetch', 'origin', '--quiet'], root)
  return {
    initialized: true,
    remote,
    dirty: isDirty(root),
    branch,
    ahead: countDiff(root, 'ahead'),
    behind: countDiff(root, 'behind'),
  }
}

/**
 * Stage exactly the engram-store files for commit. First untracks any secret a
 * previous client may have committed, then force-adds the allowlisted store files.
 * The `-f` overrides any user gitignore/excludes that would otherwise drop a real
 * engram file, WITHOUT neutralizing the user's global excludes for everything
 * else, and config.yaml/secrets are never in the pathspec so they can never be
 * staged.
 * Returns the number of files staged (added/modified/deleted).
 */
function stageStoreFiles(root: string): number {
  assertNoUnmergedStoreFiles(root)
  for (const secret of SECRET_PATHS) {
    gitSafe(['rm', '--cached', '--ignore-unmatch', '--quiet', '--', secret], root)
  }
  // Root store files (allowlist), EXCEPT `packs` which is staged by its own
  // file-level allowlist below — never as a whole force-added directory.
  const present = SYNC_PATHS.filter((p) => p !== 'packs' && existsSync(join(root, p)))
  const pathspecs: string[] = [...present, ...packStorePaths(root)]
  if (pathspecs.length > 0) {
    // Only the allowlisted root files + the allowlisted pack files are staged, so
    // no secret file (root or nested in a pack) can ever ride along.
    git(['add', '-A', '-f', '--', ...pathspecs], root)
  }
  const staged = gitSafe(['diff', '--cached', '--name-only'], root)
  return staged ? staged.split('\n').filter(Boolean).length : 0
}

/**
 * Refuse to stage while any store file is unmerged: `git add -A -f` would mark it resolved and commit and push
 * the conflict markers. Checks only the store allowlist; unrelated conflicted files are not sync's business.
 */
function assertNoUnmergedStoreFiles(root: string): void {
  const unmerged = gitSafe(['diff', '--name-only', '--diff-filter=U'], root)
  if (!unmerged) return
  const conflicted = unmerged
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean)
    .filter(f => SYNC_PATHS.some(p => f === p || f.startsWith(`${p}/`)))
  if (conflicted.length === 0) return
  throw new Error(
    `[plur] refusing to sync: ${conflicted.join(', ')} ${conflicted.length === 1 ? 'is' : 'are'} unmerged.\n` +
    `Staging an unmerged file would mark the conflict "resolved" with its markers still in it, and commit ` +
    `(and push) that as your engram store.\n` +
    `Resolve the conflict first. If a previous sync left an autostash behind, your complete copy may be in ` +
    `'git stash list' — check it BEFORE running 'git stash drop' or 'git reset --hard'.`,
  )
}

/**
 * The EXACT allowlisted files inside `packs/` to stage. Returns concrete
 * paths, not globs, so a `git add` pathspec can never zero-match (which is
 * fatal, e.g. "packs/<glob>/metadata.json" when no pack has one).
 * Unions on-disk files (adds/modifies) with currently-tracked ones (so a deletion
 * still stages via `-A`). Only SKILL.md / engrams.yaml / INTEGRITY / metadata.json
 * are eligible — any other file in a pack dir (a secret, a stray asset) is excluded
 * by construction.
 */
function packStorePaths(root: string): string[] {
  const packsDir = join(root, 'packs')
  if (!existsSync(packsDir)) return []
  const allow = new Set<string>(PACK_ALLOW_NAMES)
  const paths = new Set<string>()
  const stack: string[] = [packsDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) stack.push(full)
      else if (allow.has(ent.name)) paths.add(relative(root, full))
    }
  }
  // Tracked allowlisted files (so a removed pack file's deletion stages via -A).
  const tracked = gitSafe(['ls-files', '--', 'packs'], root)
  if (tracked) {
    for (const f of tracked.split('\n').filter(Boolean)) {
      if (allow.has(f.split('/').pop() ?? '')) paths.add(f)
    }
  }
  return [...paths]
}

const YAML_DUMP_OPTS = { lineWidth: 120, noRefs: true, quotingType: '"' as const }

/**
 * Sibling store files that ride along with engrams.yaml in SYNC_PATHS and can
 * embed engram-DERIVED text: `episodes.yaml` (session summaries, e.g. the
 * `plur_report_failure` episode quotes an engram's failure context),
 * `candidates.yaml` (pending contradiction pairs — legacy, no in-core writer,
 * but synced when present), and `tensions.yaml` (statement_a/statement_b are
 * verbatim snapshots of the two engrams' statements). Stripping only
 * engrams.yaml would let a `shared` remote receive private-derived text
 * through these files even though the engrams themselves were withheld.
 */
const SIBLING_STRIP_FILES = ['episodes.yaml', 'candidates.yaml', 'tensions.yaml'] as const

/**
 * Dump options matching the sibling-file writers (episodes.ts / tension-store.ts
 * both use `{ lineWidth: 120, noRefs: true }`), so a stripped sibling blob is
 * byte-identical to what the file would contain if it only ever held the kept
 * records — the same determinism that prevents an infinite-dirty loop.
 */
const SIBLING_DUMP_OPTS = { lineWidth: 120, noRefs: true }

interface EngramRecord { id?: string; scope?: string; visibility?: string; [k: string]: unknown }

/**
 * Error thrown when sync finds an engrams.yaml it cannot parse.
 *
 * Sync MUST fail loudly here rather than continue. The strip that keeps
 * `scope:local` engrams off the remote is driven by parsing this file; if a
 * parse failure disabled the strip, the verbatim blob — conflict markers,
 * private engrams and all — would be committed and pushed.
 */
export class SyncStoreUnreadableError extends Error {
  constructor(readonly filePath: string) {
    super(
      `[plur] refusing to sync: cannot parse ${filePath}.\n` +
      `The scope filter that keeps private and scope:local engrams off the remote is derived from this ` +
      `file. With it unreadable, PLUR cannot tell which engrams must NOT be pushed, so continuing would ` +
      `commit the file verbatim — publishing private engrams and any conflict markers along with them.\n` +
      `Common cause: a merge conflict in engrams.yaml — look for <<<<<<< markers. If a previous sync left ` +
      `an autostash behind, your complete copy may be in 'git stash list' — check it BEFORE running ` +
      `'git stash drop' or 'git reset --hard'.\n` +
      `Fix the file, then retry.`,
    )
    this.name = 'SyncStoreUnreadableError'
  }
}

/**
 * Read engrams.yaml as a record list for the strip filters.
 *
 * `null` means ABSENT — there is nothing to strip and nothing to protect. It
 * never doubles as "unparseable": conflating the two would push a corrupt,
 * unstripped store. Unparseable throws.
 */
function readEngramList(root: string): { raw: unknown; list: EngramRecord[] } | null {
  const path = join(root, 'engrams.yaml')
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  // The loader's shape rule, not a looser local copy (e.g. a bare top-level
  // array, which `parseEngramFile` refuses): sync must never strip, commit and
  // push a file PLUR itself cannot load. Anything the loader refuses, sync
  // refuses.
  let list: unknown[]
  try {
    list = engramStoreEntries(path, content, Buffer.byteLength(content))
  } catch {
    throw new SyncStoreUnreadableError(path)
  }
  return { raw: yaml.load(content), list: list as EngramRecord[] }
}

/**
 * Push-set predicate per remote type. `personal`: everything except
 * `scope:local` (private engrams follow the user across their own machines —
 * it is their backup). `shared`: ONLY shared-family scopes (`isSharedScope`)
 * with a non-private visibility — personal-family (`local`/`global`/`user:*`/
 * `agent:*`) and private-visibility engrams are excluded by construction.
 * NOTE the default visibility is 'private', so a shared remote receives
 * only engrams whose visibility was set deliberately — conservative on purpose,
 * consistent with the "private stays local" write-path semantics.
 */
function pushKeep(remoteType: SyncRemoteType): (e: EngramRecord) => boolean {
  // A queued remote-only save is never committed or pushed, whatever the remote:
  // history would keep it after delivery.
  if (remoteType === 'shared') {
    return e => !isRemoteOnlyQueued(e) && isSharedScope(e?.scope ?? '') && (e?.visibility ?? 'private') !== 'private'
  }
  return e => !isRemoteOnlyQueued(e) && e?.scope !== 'local'
}

/**
 * Ids of the engrams this remote type actually receives — the membership set
 * the sibling-file keep-predicate checks references against. Empty when
 * engrams.yaml is absent/unparseable: with no provable push set, every
 * id-referencing sibling record is conservatively outside it.
 */
function pushIds(root: string, remoteType: SyncRemoteType): Set<string> {
  const parsed = readEngramList(root)
  if (!parsed) return new Set()
  const keep = pushKeep(remoteType)
  return new Set(
    parsed.list.filter(keep).map(e => String(e?.id ?? '')).filter(Boolean),
  )
}

/**
 * Read a sibling store file as a record array (the shape episodes.ts /
 * tension-store.ts write). Returns null when absent; throws
 * {@link SyncStoreUnreadableError} when unparseable or not an array.
 */
function readSiblingList(root: string, file: string): unknown[] | null {
  const path = join(root, file)
  // ABSENT is the only "nothing to strip" answer. Unparseable and wrongly
  // shaped are refusals, matching what readEngramList does: skipping the
  // filter would leave the already force-staged blob untouched, and a
  // malformed episodes.yaml carrying text DERIVED from private engrams would
  // be pushed verbatim to a shared remote.
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = yaml.load(readFileSync(path, 'utf8'))
  } catch {
    throw new SyncStoreUnreadableError(path)
  }
  // An empty list serialises as `[]`; null means the bytes said nothing.
  if (raw == null) throw new SyncStoreUnreadableError(path)
  if (!Array.isArray(raw)) throw new SyncStoreUnreadableError(path)
  return raw
}

/**
 * Keep-predicate for sibling-file records: push a record only when EVERY engram id anywhere in its serialization
 * is in the push set (shape-agnostic, covers free text). Personal/private or unknown ids fail — strip-on-doubt,
 * since a false keep is a leak. Records with no engram references are kept.
 */
function siblingKeep(pushedIds: Set<string>): (record: unknown) => boolean {
  return (record: unknown) => {
    const text = JSON.stringify(record) ?? ''
    const refs = text.match(ENGRAM_ID_TOKEN)
    if (!refs) return true
    return refs.every(id => pushedIds.has(id))
  }
}

/** Count of sibling records the strip withholds for this remote type — for the sync warning. */
function droppedSiblingCount(root: string, remoteType: SyncRemoteType): number {
  const keep = siblingKeep(pushIds(root, remoteType))
  let dropped = 0
  for (const file of SIBLING_STRIP_FILES) {
    const records = readSiblingList(root, file)
    if (!records) continue
    dropped += records.filter(r => !keep(r)).length
  }
  return dropped
}

/**
 * Warning shown when a remote is involved: states what the push set actually
 * includes/excludes for this remote type. Returns undefined when
 * there is nothing noteworthy to say.
 */
function stripWarning(root: string, remoteType: SyncRemoteType): string | undefined {
  const parsed = readEngramList(root)
  if (remoteType === 'shared') {
    const strippedEngrams = parsed ? parsed.list.filter(e => !pushKeep('shared')(e)).length : 0
    const strippedSiblings = droppedSiblingCount(root, 'shared')
    if (strippedEngrams === 0 && strippedSiblings === 0) return undefined
    const parts: string[] = []
    if (strippedEngrams > 0) parts.push(`${strippedEngrams} personal-scope or private-visibility engram(s)`)
    if (strippedSiblings > 0) parts.push(`${strippedSiblings} episode/candidate/tension record(s) derived from non-pushed engrams`)
    return `Shared remote: pushed only shared-scope, non-private engrams — ${parts.join(' and ')} stayed local.`
  }
  if (!parsed) return undefined
  // The personal remote does not receive all engrams: `pushKeep('personal')`
  // strips every scope:local engram, and the sensitivity guard auto-demotes
  // engrams to local, so the excluded set grows silently over time. A backup
  // warning that overstates coverage is worse than none: it is read exactly
  // once, when deciding whether other backups are needed.
  const privateCount = parsed.list.filter(
    e => e?.scope !== 'local' && (e?.visibility ?? 'private') === 'private',
  ).length
  const localCount = parsed.list.filter(e => e?.scope === 'local').length
  const strippedSiblings = droppedSiblingCount(root, 'personal')
  const parts: string[] = []
  if (localCount > 0) {
    parts.push(
      `${localCount} scope:local engram(s) are NOT pushed and are NOT backed up by sync` +
      (localCount === parsed.list.length ? ' — this remote backs up nothing' : ''),
    )
  }
  if (strippedSiblings > 0) {
    parts.push(`${strippedSiblings} episode/candidate/tension record(s) naming a non-pushed engram stayed local`)
  }
  if (privateCount > 0) {
    parts.push(`${privateCount} private-visibility engram(s) ARE pushed — use a private git remote`)
  }
  if (parts.length === 0) return undefined
  return `Note: ${parts.join('. ')}. For a team remote, set sync.remote_type: shared to exclude private engrams too.`
}

/**
 * Replace a *staged* blob using git plumbing (hash-object + update-index) so the
 * working tree keeps everything while the commit (and therefore the remote)
 * never sees the excluded content. Must run after staging — the path is already
 * in the index, put there by stageStoreFiles.
 */
function stageBlob(root: string, relPath: string, content: string): void {
  const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: content, encoding: 'utf8', timeout: 30_000,
  }).trim()
  git(['update-index', '--cacheinfo', `100644,${hash},${relPath}`], root)
}

/**
 * Strip every staged store file down to this remote type's push set: the
 * engrams.yaml scope/visibility filter plus the sibling-file
 * derived-record filter. Called on every commit path (init, commit,
 * conflict resolution) so no path can stage verbatim content.
 */
function stageStripped(root: string, remoteType: SyncRemoteType): void {
  stageStrippedEngrams(root, remoteType)
  stageStrippedSiblings(root, remoteType)
}

/**
 * Replace the *staged* engrams.yaml blob with one that keeps only the push set
 * for this remote type.
 *
 * Re-serializes with the same YAML options PLUR uses everywhere, so the
 * stripped blob is deterministic across runs — this is what prevents an
 * infinite-dirty-state loop: a sync whose only change is to a stripped engram
 * produces the identical stripped blob and therefore no new commit.
 */
function stageStrippedEngrams(root: string, remoteType: SyncRemoteType): void {
  const parsed = readEngramList(root)
  if (!parsed) return
  const { raw, list } = parsed
  const keep = pushKeep(remoteType)
  const filtered = list.filter(keep)
  if (filtered.length === list.length) return
  const out = yaml.dump({ ...(raw as object), engrams: filtered }, YAML_DUMP_OPTS)
  stageBlob(root, 'engrams.yaml', out)
}

/**
 * Replace the *staged* episodes/candidates/tensions blobs with ones that keep
 * only records derived from this remote's push set: an engram withheld from
 * the remote must also be withheld in its derived text in the sibling store
 * files. Applies to `personal` remotes too:
 * a scope:local engram never leaves the machine, so a side record naming one
 * does not either.
 */
function stageStrippedSiblings(root: string, remoteType: SyncRemoteType): void {
  const keep = siblingKeep(pushIds(root, remoteType))
  for (const file of SIBLING_STRIP_FILES) {
    const records = readSiblingList(root, file)
    if (!records) continue
    const kept = records.filter(keep)
    if (kept.length === records.length) continue
    stageBlob(root, file, yaml.dump(kept, SIBLING_DUMP_OPTS))
  }
}

function initRepo(root: string, remoteType: SyncRemoteType): void {
  git(['init'], root)
  atomicWrite(join(root, '.gitignore'), GITIGNORE)
  stageStoreFiles(root)
  stageStripped(root, remoteType)
  git(['commit', '-m', 'Initial PLUR engram store'], root)
}

function commitChanges(root: string, remoteType: SyncRemoteType): number {
  const filesChanged = stageStoreFiles(root)
  if (filesChanged === 0) return 0
  stageStripped(root, remoteType)
  // Count changes from the STAGED tree (after stripping) vs HEAD. When the only
  // change is to a scope:local engram, the stripped blob is identical to HEAD, so
  // nothing is staged and we must NOT commit — otherwise every sync would loop
  // forever, since the working tree always differs from the stripped HEAD blob.
  const diff = gitSafe(['diff', '--cached', '--shortstat'], root)
  if (!diff || diff.length === 0) return 0
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  git(['commit', '-m', `plur sync ${now}`], root)
  // Parse "N files changed" from shortstat
  const match = diff.match(/(\d+) file/)
  return match ? parseInt(match[1], 10) : filesChanged
}

function hasConflictMarkers(root: string): boolean {
  // Check if any tracked files contain conflict markers
  const result = gitSafe(['grep', '-l', '<<<<<<<'], root)
  return result !== null && result.length > 0
}

/** A store file whose held records are set aside across the pull — see {@link HeldFile}. */
type WithheldFile = HeldFile

/**
 * Hold withheld records aside across a pull. HEAD holds the stripped store, so a working tree with withheld records
 * is permanently dirty and `git pull` would refuse; reset each such file to its staged blob, pull, then restore.
 * Nothing withheld reaches a commit.
 * CRASH SAFETY: held records are written to fsynced `.git/plur-held.json` BEFORE any reset and deleted only after
 * every record is back (`finally` does not run on signals). While it exists, readers count its records as part of
 * the store and the next sync or write restores them.
 */
function holdWithheld(root: string, remoteType: SyncRemoteType): WithheldFile[] {
  const files: WithheldFile[] = []
  const parsed = readEngramList(root)
  const candidates: Array<{ file: string; held: unknown[] }> = []
  if (parsed) {
    candidates.push({ file: 'engrams.yaml', held: parsed.list.filter(e => !pushKeep(remoteType)(e)) })
  }
  const keepSibling = siblingKeep(pushIds(root, remoteType))
  for (const file of SIBLING_STRIP_FILES) {
    const records = readSiblingList(root, file)
    if (records) candidates.push({ file, held: records.filter(r => !keepSibling(r)) })
  }
  for (const { file, held } of candidates) {
    if (held.length === 0) continue
    const staged = gitSafe(['show', `:${file}`], root)
    if (staged === null) continue // untracked: pull cannot be blocked by it
    const saved = readFileSync(join(root, file), 'utf8')
    // gitSafe trims; compare on trimmed content.
    if (saved.trim() === staged) continue
    files.push({ file, saved, staged, held })
  }
  if (files.length === 0) return files
  // Durable BEFORE the tree is touched: from here until the restore completes,
  // this file is the only copy of the held records.
  writeHeldRecovery(root, files, null)
  for (const f of files) git(['checkout', '--', f.file], root)
  return files
}

/** The committed blob of `file` at HEAD (trimmed, like `gitSafe`), or null when HEAD does not carry it. */
function headBlob(root: string, file: string): string | null {
  return gitSafe(['show', `HEAD:${file}`], root)
}

/** Replace engram-id tokens in a record by `map` (old id -> new id), everywhere in it. */
function renameIdRefs(v: unknown, map: ReadonlyMap<string, string>): unknown {
  return renameEngramIdRefs(v, map)
}

/** Held sibling records not already present verbatim in `current` — a restore may be re-run after a crash. */
function missingSiblingRecords(current: readonly unknown[], held: readonly unknown[]): unknown[] {
  return held.filter(h => !current.some(c => sameEngramContent(c, h)))
}

/**
 * Put held records back after a pull (successful, failed, or being recovered). Idempotent.
 * - File unchanged since before the hold → nothing; unchanged by the pull → saved bytes back verbatim.
 * - Changed by the pull → new file plus held records not in it; a same-id clash re-ids the held LOCAL record
 *   (never pushed, so nothing outside this machine refers to it; {@link mergeHeldRecords}), records the rename and makes held sibling references follow.
 * - Unreadable now: if HEAD carries the pulled version it is KEPT and returned `unresolved` (held records stay in
 *   the recovery file); writing pre-pull bytes would commit a revert. Only when HEAD still holds the pre-pull blob
 *   do the saved bytes go back.
 */
function restoreWithheld(root: string, files: WithheldFile[], merged: readonly IdRename[] = []): { renames: IdRename[]; rewrote: string[]; unresolved: WithheldFile[] } {
  // engrams.yaml first: its renames are applied to held sibling records.
  let ordered = [...files].sort((a, b) => Number(b.file === 'engrams.yaml') - Number(a.file === 'engrams.yaml'))
  // Renames the record merge made to COMMITTED engrams during this pull:
  // held records were written on this machine, so a reference in them to the
  // old id meant this machine's engram, which now has the new id. Every held
  // record follows, held engrams included (their relations), before anything
  // else is decided about them.
  if (merged.length > 0) {
    const map = new Map(merged.map(r => [r.from, r.to] as const))
    ordered = ordered.map(f => ({ ...f, held: f.held.map(r => renameIdRefs(r, map)) }))
  }
  const renamed = new Map<string, string>(merged.map(r => [r.from, r.to] as const))
  const allRenames: IdRename[] = []
  const rewrote: string[] = []
  const unresolved: WithheldFile[] = []
  for (const f of ordered) {
    const path = join(root, f.file)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    const head = headBlob(root, f.file)
    const pulledMoved = head !== f.staged
    // Not integrated → "not pulled", the saved bytes go back. Integrated but
    // unusable → keep the pull, hold the records.
    const unusable = (): void => {
      if (pulledMoved) unresolved.push(f)
      else atomicWrite(path, f.saved)
    }
    if (current === f.saved) continue
    if (current === null) {
      if (!pulledMoved || head !== null) { atomicWrite(path, f.saved); continue }
      // The pull deleted the file: keep that, but not the never-pushed records.
      atomicWrite(path, f.file === 'engrams.yaml'
        ? yaml.dump({ engrams: f.held }, YAML_DUMP_OPTS)
        : yaml.dump(f.held, SIBLING_DUMP_OPTS))
      continue
    }
    if (current.trim() === f.staged) {
      if (renamed.size > 0 && f.file !== 'engrams.yaml') {
        // The pull left this sibling alone, but it holds records naming a held
        // engram that was just re-id'd: put them back under the new id.
        let base: unknown
        try { base = yaml.load(current) } catch { base = null }
        if (Array.isArray(base)) {
          atomicWrite(path, yaml.dump([...base, ...f.held.map(r => renameIdRefs(r, renamed))], SIBLING_DUMP_OPTS))
          rewrote.push(f.file)
          continue
        }
      }
      atomicWrite(path, f.saved)
      continue
    }
    let raw: unknown
    try {
      raw = yaml.load(current)
    } catch {
      unusable()
      continue
    }
    if (f.file === 'engrams.yaml') {
      // Same shape rule as every other reader.
      let pulledOk = true
      try { engramStoreEntries(path, current, Buffer.byteLength(current)) } catch { pulledOk = false }
      if (pulledOk && raw && typeof raw === 'object' && Array.isArray((raw as any).engrams)) {
        const pulled = (raw as any).engrams as unknown[]
        const { held, renames } = mergeHeldRecords(pulled, f.held)
        if (held.length > 0) atomicWrite(path, yaml.dump({ ...(raw as object), engrams: [...pulled, ...held] }, YAML_DUMP_OPTS))
        for (const r of renames) { renamed.set(r.from, r.to); allRenames.push(r) }
      } else {
        unusable()
      }
    } else if (Array.isArray(raw)) {
      const heldNow = renamed.size > 0 ? f.held.map(r => renameIdRefs(r, renamed)) : f.held
      if (renamed.size > 0 && JSON.stringify(heldNow) !== JSON.stringify(f.held)) rewrote.push(f.file)
      const missing = missingSiblingRecords(raw, heldNow)
      if (missing.length > 0) atomicWrite(path, yaml.dump([...raw, ...missing], SIBLING_DUMP_OPTS))
    } else {
      unusable()
    }
  }
  return { renames: allRenames, rewrote, unresolved }
}

/** Sync-result text for held records that are waiting on an unreadable store file. */
function heldPendingNote(root: string, unresolved: readonly WithheldFile[]): string | undefined {
  if (unresolved.length === 0) return undefined
  const n = unresolved.reduce((k, f) => k + f.held.length, 0)
  return `${unresolved.map(f => f.file).join(', ')} as pulled cannot be read, so ${n} scope:local record(s) were NOT put back: ` +
    `they are kept in ${relative(root, heldRecoveryPath(root))} (and every PLUR reader still sees them). ` +
    `The remote's version was kept, not reverted. Fix the file, then sync again to restore them.`
}

/**
 * Put back the held records of a sync that did not finish (killed, crashed, or
 * power lost between holding and restoring) — the first thing every sync does.
 * Deletes the recovery file only once everything in it is back; whatever still
 * cannot be restored (an unreadable store file) stays in it.
 */
function recoverHeld(root: string): WithheldFile[] {
  const files = readHeldRecovery(root)
  if (!files) return []
  // Killed between the record merge and the merge commit: the
  // merge is half-done (merged files in the tree, MERGE_HEAD set) and its
  // renames are not in the store yet. Abort it — the tree goes back to HEAD,
  // which is what the held records were set aside from — and let this sync
  // pull again; that pull merges and renames afresh.
  if (gitSafe(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root) !== null) gitSafe(['merge', '--abort'], root)
  // Killed after the merge commit: its renames were saved with the held
  // records before the commit, and the held records follow them as in an
  // uninterrupted sync. Empty while a merge is still half-done.
  const merged = readHeldMergeRenames(root)
  const restored = restoreWithheld(root, files, merged)
  if (merged.length > 0) {
    recordIdRenames(root, merged, SYNC_MERGE_RENAME_REASON, { store: join(root, 'engrams.yaml'), cause: 'sync-recovery' })
  }
  if (restored.renames.length > 0) {
    recordIdRenames(root, restored.renames, SYNC_HELD_RENAME_REASON,
      { store: join(root, 'engrams.yaml'), cause: 'sync-recovery', files: restored.rewrote })
  }
  writeHeldRecovery(root, restored.unresolved)
  return restored.unresolved
}

/**
 * Sibling records as they were in the working tree BEFORE the pull, per file.
 * After a clash rename these are exactly the records whose references to the old
 * id meant the local engram: the pulled engram with that id did not exist here
 * yet. Unreadable or absent files are skipped (nothing to rewrite from).
 */
function readSiblingsBeforePull(root: string): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  for (const file of SIBLING_STRIP_FILES) {
    try {
      const records = readSiblingList(root, file)
      if (records) out.set(file, records)
    } catch { /* unreadable: sync refuses it elsewhere; nothing to rewrite from */ }
  }
  return out
}

/**
 * On a PERSONAL remote sibling files are committed, not held, so rewrite references to renamed local engrams in
 * sibling records that predate the pull (records the pull brought are left alone); otherwise a reference would
 * silently point at the other machine's engram. Returns the files rewritten for the caller to commit.
 */
function rewriteLocalSiblingRefs(root: string, renamed: ReadonlyMap<string, string>, before: Map<string, unknown[]>): string[] {
  const rewrote: string[] = []
  const names = (r: unknown) => (JSON.stringify(r) ?? '').match(ENGRAM_ID_TOKEN)?.some(t => renamed.has(t)) ?? false
  for (const [file, pre] of before) {
    const local = pre.filter(names)
    if (local.length === 0) continue
    let current: unknown[] | null
    try { current = readSiblingList(root, file) } catch { continue }
    if (!current) continue
    let changed = false
    const next = current.map(r => {
      if (!names(r) || !local.some(p => sameEngramContent(p, r))) return r
      changed = true
      return renameIdRefs(r, renamed)
    })
    if (changed) {
      atomicWrite(join(root, file), yaml.dump(next, SIBLING_DUMP_OPTS))
      rewrote.push(file)
    }
  }
  return rewrote
}

/** @returns whether the pull integrated, the sibling files rewritten after a clash rename (to commit), and held files still waiting. */
function pullRebase(root: string, remoteType: SyncRemoteType): { ok: boolean; rewroteSiblings: string[]; unresolved: WithheldFile[] } {
  const before = readSiblingsBeforePull(root)
  // What the store held before the pull, so the memories it changes are named
  // in history (recordStoreSync).
  const recordsBefore = storeRecordMap(join(root, 'engrams.yaml'))
  const held = holdWithheld(root, remoteType)
  let ok = false
  let restored: { renames: IdRename[]; rewrote: string[]; unresolved: WithheldFile[] } = { renames: [], rewrote: [], unresolved: [] }
  const mergeRenames: IdRename[] = []
  try {
    ok = pullRebaseClean(root, remoteType, mergeRenames)
  } finally {
    // On a throw from the restore the recovery file stays: the next sync or
    // store write finishes the job.
    restored = restoreWithheld(root, held, mergeRenames)
  }
  let committed: string[] = []
  if (restored.renames.length > 0) {
    const renamed = new Map(restored.renames.map(r => [r.from, r.to] as const))
    committed = rewriteLocalSiblingRefs(root, renamed, before)
    const files = [...new Set([...restored.rewrote, ...committed])]
    recordIdRenames(root, restored.renames, SYNC_HELD_RENAME_REASON, { store: join(root, 'engrams.yaml'), cause: 'sync-pull', files })
  }
  // LAST: only now is every held record back (or still in the file, if unresolved).
  if (held.length > 0) writeHeldRecovery(root, restored.unresolved)
  recordStoreSync(root, recordsBefore, 'sync-pull')
  return { ok, rewroteSiblings: committed, unresolved: restored.unresolved }
}

/**
 * @param mergeRenames receives the engram renames the record merge made, so the
 *   caller can carry them into the records held aside for privacy.
 */
function pullRebaseClean(root: string, remoteType: SyncRemoteType, mergeRenames: IdRename[] = []): boolean {
  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], root) || 'main'
  const result = gitSafe(['pull', '--rebase', 'origin', branch], root)
  if (result !== null) return true
  // Rebase conflict — abort and try merge
  gitSafe(['rebase', '--abort'], root)
  // `--no-rebase` is explicit: git 2.27+ refuses a pull of divergent branches
  // unless a reconcile mode is configured, so the bare form would fail in
  // exactly the case this fallback exists for.
  //
  // `--no-commit`: the merge stops before committing, clean or conflicted, so
  // the store files can be merged as records before anything is
  // committed. Git merges YAML line by line, so two devices that each saved a
  // memory offline both append to the end of engrams.yaml and always conflict;
  // and a "clean" line merge can still put two different engrams under one id.
  const mergeResult = gitSafe(['pull', '--no-rebase', '--no-commit', 'origin', branch], root)
  if (gitSafe(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root) !== null) {
    let renames: IdRename[]
    try {
      renames = mergeStoreRecords(root)
    } catch (err) {
      gitSafe(['merge', '--abort'], root)
      throw err
    }
    if (hasConflictMarkers(root)) {
      gitSafe(['merge', '--abort'], root)
      throw new Error('Sync conflict: YAML files have merge conflicts that require manual resolution. Your local changes are preserved.')
    }
    // The renames are saved with the held records BEFORE the
    // commit, so a process killed the moment the commit exists still has them
    // on restart (`recoverHeld`). They take effect only once MERGE_HEAD is gone.
    const heldNow = renames.length > 0 ? readHeldRecovery(root) : null
    if (heldNow && heldNow.length > 0) writeHeldRecovery(root, heldNow, renames)
    stageStoreFiles(root)
    stageStripped(root, remoteType)
    const merged = gitSafe(['commit', '--no-edit', '-m', 'plur sync: merged both devices\' changes'], root)
    if (merged === null) {
      if (heldNow && heldNow.length > 0) writeHeldRecovery(root, heldNow, null)
      gitSafe(['merge', '--abort'], root)
      return false
    }
    mergeRenames.push(...renames)
    if (renames.length > 0) {
      recordIdRenames(root, renames, SYNC_MERGE_RENAME_REASON, { store: join(root, 'engrams.yaml'), cause: 'sync-merge' })
    }
    return countDiff(root, 'behind') === 0
  }
  if (mergeResult !== null) return true
  // Merge conflict — check for conflict markers before staging
  if (hasConflictMarkers(root)) {
    // Abort the merge rather than committing corrupt files
    gitSafe(['merge', '--abort'], root)
    throw new Error('Sync conflict: YAML files have merge conflicts that require manual resolution. Your local changes are preserved.')
  }
  stageStoreFiles(root)
  // Strip the staged blob exactly like every other commit path, so
  // scope:local engrams never ride into the remote on the conflict-resolution
  // commit.
  stageStripped(root, remoteType)
  const committed = gitSafe(['commit', '-m', 'plur sync: merge conflict resolved (kept both)'], root)
  // When the rebase refused (dirty tree), the merge fallback aborted, and
  // there were no conflict markers to catch, the remote changes were never
  // integrated. The honest test is the ledger, not the exit code of the last
  // command: if we are still behind the upstream, the pull did not happen.
  if (committed === null) return false
  return countDiff(root, 'behind') === 0
}

const SYNC_MERGE_RENAME_REASON =
  'sync: both devices saved a different engram under the same id while offline; the one not yet pushed was given a fresh id'

const UNMERGEABLE = 'Sync conflict: YAML files have merge conflicts that require manual resolution. Your local changes are preserved.'

/** Equality on parsed YAML values, key order ignored. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return sameEngramContent(a, b)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Three-way merge of one value both devices changed. Unchanged on one side →
 * the other side's change. Changed on both:
 * - `status`: a retirement wins (a forgotten or superseded memory stays so);
 * - lists: union, minus what either side removed (a link added on either
 *   device survives);
 * - objects: merged key by key;
 * - numbers: the larger (counters only grow);
 * - anything else: this device's value.
 * `undefined` means the key is absent.
 */
function mergeValue(base: unknown, ours: unknown, theirs: unknown, key?: string): unknown {
  if (same(ours, theirs)) return ours
  if (same(ours, base)) return theirs
  if (same(theirs, base)) return ours
  if (key === 'status' && (ours === 'retired' || theirs === 'retired')) return 'retired'
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const b = Array.isArray(base) ? base : []
    const has = (list: unknown[], v: unknown) => list.some(x => same(x, v))
    const removed = (v: unknown) => has(b, v) && (!has(ours, v) || !has(theirs, v))
    const out = ours.filter(v => !removed(v))
    for (const v of theirs) if (!removed(v) && !has(out, v)) out.push(v)
    return out
  }
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {}
    const out: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = mergeValue(b[k], ours[k], theirs[k], k)
      if (v !== undefined) out[k] = v
    }
    return out
  }
  if (typeof ours === 'number' && typeof theirs === 'number') return Math.max(ours, theirs)
  // Removed on one side, changed on the other: the removal was deliberate.
  if (ours === undefined || theirs === undefined) return undefined
  return ours
}

/**
 * Three-way merge of two record lists, matched by `id` (or, for a record
 * without one, by its content). The result follows the remote's order, then
 * this device's additions. A record deleted on either side stays deleted.
 * Records both sides added under one id are merged field by field — for
 * engrams, {@link renameLocalClashes} has already split genuine clashes apart.
 */
function mergeRecordLists(
  base: unknown[], ours: unknown[], theirs: unknown[],
  mergeOne: (base: unknown, ours: unknown, theirs: unknown) => unknown = mergeValue,
): unknown[] {
  const keyOf = (r: unknown): string => {
    const id = (r as { id?: unknown } | null)?.id
    return typeof id === 'string' ? `id:${id}` : `content:${JSON.stringify(r) ?? ''}`
  }
  const index = (list: unknown[]) => new Map(list.map(r => [keyOf(r), r] as const))
  const b = index(base), o = index(ours), t = index(theirs)
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const [k, rt] of t) {
    seen.add(k)
    const inBase = b.has(k), inOurs = o.has(k)
    if (inBase && !inOurs) continue // this device deleted it
    if (!inOurs) { out.push(rt); continue }
    const merged = mergeOne(inBase ? b.get(k) : undefined, o.get(k), rt)
    if (merged !== undefined) out.push(merged)
  }
  for (const [k, ro] of o) {
    if (seen.has(k)) continue
    if (b.has(k)) continue // the other device deleted it
    out.push(ro)
  }
  return out
}

/**
 * Engrams both sides added under one id with different content (each device
 * mints `max(same-day suffix)+1`). The local one was never pushed — the merge
 * base predates it — so it takes a fresh id, and every reference to it on
 * this side follows (keep both, rename one).
 */
function renameLocalClashes(base: unknown[], ours: unknown[], theirs: unknown[]): { ours: unknown[]; renames: IdRename[] } {
  const idOf = (r: unknown) => (r as { id?: unknown } | null)?.id
  const baseIds = new Set(base.map(idOf).filter((x): x is string => typeof x === 'string'))
  const theirsById = new Map<string, unknown>()
  for (const r of theirs) { const id = idOf(r); if (typeof id === 'string') theirsById.set(id, r) }
  const taken = new Set<string>([...baseIds, ...theirsById.keys()])
  for (const r of ours) { const id = idOf(r); if (typeof id === 'string') taken.add(id) }
  const map = new Map<string, string>()
  const renames: IdRename[] = []
  for (const r of ours) {
    const id = idOf(r)
    if (typeof id !== 'string' || baseIds.has(id) || !theirsById.has(id)) continue
    if (sameEngramContent(theirsById.get(id), r)) continue
    const to = freshDuplicateId(id, r, taken)
    taken.add(to)
    map.set(id, to)
    renames.push({ from: id, to })
  }
  if (map.size === 0) return { ours, renames }
  return { ours: ours.map(r => renameIdRefs(r, map)), renames }
}

/**
 * Sibling records (reviews, episodes, candidates) both sides added under one id with different content. Review ids
 * are a per-day sequence, so offline devices mint the same id for different reviews; a field merge would lose one.
 * Same rule as engrams: keep both, rename one (nothing refers to sibling ids). A review of the SAME engram pair is
 * one review, merged by {@link mergeReview} keeping the furthest lifecycle state.
 */
function renameSiblingClashes(file: string, base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const idOf = (r: unknown) => (r as { id?: unknown } | null)?.id
  const pairOf = reviewPairOf
  const baseIds = new Set(base.map(idOf).filter((x): x is string => typeof x === 'string'))
  const theirsById = new Map<string, unknown>()
  for (const r of theirs) { const id = idOf(r); if (typeof id === 'string') theirsById.set(id, r) }
  const taken = new Set<string>([...baseIds, ...theirsById.keys()])
  for (const r of ours) { const id = idOf(r); if (typeof id === 'string') taken.add(id) }
  return ours.map(r => {
    const id = idOf(r)
    if (typeof id !== 'string' || baseIds.has(id) || !theirsById.has(id)) return r
    const other = theirsById.get(id)
    if (sameEngramContent(other, r)) return r
    if (file === 'tensions.yaml' && pairOf(r) !== null && pairOf(r) === pairOf(other)) return r
    const to = freshDuplicateId(id, r, taken)
    taken.add(to)
    return { ...(r as object), id: to }
  })
}

/** A review's unordered engram pair (`tensionPairKey` form), or null for a record that is not one. */
function reviewPairOf(r: unknown): string | null {
  const t = r as { engram_a?: unknown; engram_b?: unknown } | null
  return typeof t?.engram_a === 'string' && typeof t?.engram_b === 'string' ? [t.engram_a, t.engram_b].sort().join(':') : null
}

type ReviewLifecycle = { status?: unknown; resolved_by?: unknown; resolved_at?: unknown }
/** How far along `detected → confirmed → dismissed | resolved` a review is. A resolution retired a memory, so it outranks a dismissal. */
const REVIEW_RANK: Record<string, number> = { detected: 0, confirmed: 1, dismissed: 2, resolved: 3 }
const reviewRank = (r: unknown): number => REVIEW_RANK[String((r as ReviewLifecycle | null)?.status ?? 'detected')] ?? 0
const lifecycleOf = (r: unknown) => {
  const x = (r ?? {}) as ReviewLifecycle
  return { status: x.status ?? 'detected', resolved_by: x.resolved_by ?? null, resolved_at: x.resolved_at ?? null }
}

/**
 * Of two records of one review, the one whose lifecycle state stands:
 * N3): the furthest along, so a resolution (with its winner and time) or a
 * dismissal is never reopened by the other device's detected/confirmed copy.
 * Two different resolutions: the earlier one, then the smaller winner id — the
 * same answer whichever device merges.
 */
function standingReview(x: unknown, y: unknown): unknown {
  if (reviewRank(x) !== reviewRank(y)) return reviewRank(x) > reviewRank(y) ? x : y
  const key = (r: unknown) => { const l = lifecycleOf(r); return `${l.resolved_at ?? '\uffff'}\0${l.resolved_by ?? ''}` }
  return key(x) <= key(y) ? x : y
}

/** `record` with the lifecycle fields of `from`. */
const withLifecycle = (record: unknown, from: unknown): unknown => ({ ...(record as object), ...lifecycleOf(from) })

/** Field merge of one review record both devices changed; the lifecycle comes from {@link standingReview}. */
function mergeReview(base: unknown, ours: unknown, theirs: unknown): unknown {
  const merged = mergeValue(base, ours, theirs)
  if (merged === undefined || reviewPairOf(ours) === null || reviewPairOf(ours) !== reviewPairOf(theirs)) return merged
  return withLifecycle(merged, standingReview(ours, theirs))
}

/**
 * One record per unordered memory pair (`recordTensions` keeps one
 * locally). Two devices that detected the same pair under different daily ids
 * hold one review twice. The merged list keeps one: the id already in the base,
 * else the remote's (already published), else the first; its fields are that
 * record's, its lifecycle the standing one of the group.
 */
function onePerReviewPair(list: unknown[], base: unknown[], theirs: unknown[]): unknown[] {
  const idOf = (r: unknown) => (r as { id?: unknown } | null)?.id
  const baseIds = new Set(base.map(idOf))
  const theirIds = new Set(theirs.map(idOf))
  const groups = new Map<string, unknown[]>()
  for (const r of list) {
    const pair = reviewPairOf(r)
    if (pair !== null) groups.set(pair, [...(groups.get(pair) ?? []), r])
  }
  const out: unknown[] = []
  for (const r of list) {
    const pair = reviewPairOf(r)
    const group = pair === null ? undefined : groups.get(pair)
    if (!group || group.length === 1) { out.push(r); continue }
    if (group[0] !== r) continue // emitted at the group's first position
    const keep = group.find(x => baseIds.has(idOf(x))) ?? group.find(x => theirIds.has(idOf(x))) ?? group[0]
    out.push(withLifecycle(keep, group.reduce((a, x) => standingReview(a, x))))
  }
  return out
}

/**
 * Merge the store files of an in-progress `git merge` as records, so
 * both devices' offline saves, corrections and forgets survive. Writes and
 * stages each merged file. Throws when a conflicted file cannot be merged this
 * way (not a store file, or not a shape PLUR writes); the caller aborts the
 * merge, leaving the local store as it was.
 *
 * Every side read here is a COMMITTED blob, i.e. already stripped of records
 * this remote never receives; those held records are put back afterwards by
 * the caller's restore step, exactly as after any pull.
 */
function mergeStoreRecords(root: string): IdRename[] {
  const unmerged = (gitSafe(['diff', '--name-only', '--diff-filter=U'], root) ?? '').split('\n').filter(Boolean)
  const mergeable = new Set<string>(['engrams.yaml', ...SIBLING_STRIP_FILES])
  if (unmerged.some(f => !mergeable.has(f))) throw new Error(UNMERGEABLE)
  const baseRev = gitSafe(['merge-base', 'HEAD', 'MERGE_HEAD'], root)
  if (!baseRev) throw new Error(UNMERGEABLE)

  const load = (rev: string, file: string): { text: string | null; raw: unknown } => {
    const text = gitSafe(['show', `${rev}:${file}`], root)
    if (text === null) return { text, raw: undefined }
    try { return { text, raw: yaml.load(text) } } catch { return { text, raw: null } }
  }
  const sides = (file: string) => ({ base: load(baseRev, file), ours: load('HEAD', file), theirs: load('MERGE_HEAD', file) })
  const write = (file: string, content: string) => {
    atomicWrite(join(root, file), content)
    git(['add', '-f', '--', file], root)
  }

  // engrams.yaml first: its id renames apply to the sibling records too.
  let renames: IdRename[] = []
  const map = new Map<string, string>()
  {
    const file = 'engrams.yaml'
    const s = sides(file)
    const conflicted = unmerged.includes(file)
    const changedBoth = s.base.text !== s.ours.text && s.base.text !== s.theirs.text
    if (conflicted || changedBoth) {
      const list = (text: string | null): unknown[] | null => {
        if (text === null) return []
        try { return engramStoreEntries(join(root, file), text, Buffer.byteLength(text)) } catch { return null }
      }
      const b = list(s.base.text), o = list(s.ours.text), t = list(s.theirs.text)
      if (!b || !o || !t) {
        if (conflicted) throw new Error(UNMERGEABLE)
      } else {
        const clash = renameLocalClashes(b, o, t)
        renames = clash.renames
        for (const r of renames) map.set(r.from, r.to)
        const engrams = mergeRecordLists(b, clash.ours, t)
        const top = (v: unknown) => (isPlainObject(v) ? v : {})
        const merged = mergeValue(top(s.base.raw), top(s.ours.raw), top(s.theirs.raw)) as Record<string, unknown>
        write(file, yaml.dump({ ...merged, engrams }, YAML_DUMP_OPTS))
      }
    }
  }

  for (const file of SIBLING_STRIP_FILES) {
    const s = sides(file)
    const conflicted = unmerged.includes(file)
    const oursChanged = s.base.text !== s.ours.text
    const changedBoth = oursChanged && s.base.text !== s.theirs.text
    if (!conflicted && !changedBoth && !(oursChanged && map.size > 0)) continue
    const list = (side: { text: string | null; raw: unknown }): unknown[] | null =>
      side.text === null ? [] : Array.isArray(side.raw) ? side.raw : null
    const b = list(s.base), o = list(s.ours), t = list(s.theirs)
    if (!b || !o || !t) {
      if (conflicted) throw new Error(UNMERGEABLE)
      continue
    }
    const oursNow = renameSiblingClashes(file, b, map.size > 0 ? o.map(r => renameIdRefs(r, map)) : o, t)
    const merged = file === 'tensions.yaml'
      ? onePerReviewPair(mergeRecordLists(b, oursNow, t, mergeReview), b, t)
      : mergeRecordLists(b, oursNow, t)
    write(file, yaml.dump(merged, SIBLING_DUMP_OPTS))
  }
  return renames
}

/**
 * A pull that rewrote engrams.yaml is a PLUR write too: record the count that
 * landed for the daily backup's shrink gate. Without it a legitimate pulled
 * shrink of more than 10% (another machine forgot or compacted) would be
 * refused as "shrunk" by the next day's backup, until PLUR's next local write
 * recorded the new count.
 * Only a file that passes the loader's shape rule is counted; anything else is
 * left for the gate to refuse.
 */
function recordPulledCount(storePath: string, before: string | null): void {
  if (!existsSync(storePath)) return
  const after = readFileSync(storePath, 'utf8')
  if (after === before) return
  let count: number
  try {
    count = engramStoreEntries(storePath, after, Buffer.byteLength(after)).length
  } catch {
    return
  }
  recordLastWritten(storePath, count)
}

export function sync(root: string, remote?: string, options?: { remoteType?: SyncRemoteType }): SyncResult {
  if (!hasGitCli()) {
    throw new Error('git is not installed. Install git to enable sync.')
  }
  // Default `personal` mirrors everything; `shared` is an explicit opt-in.
  const remoteType: SyncRemoteType = options?.remoteType ?? 'personal'

  // State 1: No git repo — initialize
  if (!isGitRepo(root)) {
    initRepo(root, remoteType)
    if (remote) {
      git(['remote', 'add', 'origin', remote], root)
      // Detect default branch name
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
      git(['push', '-u', 'origin', branch], root)
      return { action: 'initialized', message: `Initialized and pushed to ${remote}`, remote, files_changed: 0, warning: stripWarning(root, remoteType) }
    }
    return {
      action: 'initialized',
      message: 'Initialized local git repo. Call plur.sync with remote to enable cross-device sync.',
      remote: null,
      files_changed: 0,
    }
  }

  // Held records of a sync that never finished go back before anything else
  // reads or commits the store.
  let heldPending = recoverHeld(root)

  // Add remote if provided and not yet set
  const existingRemote = getRemote(root)
  if (remote && !existingRemote) {
    git(['remote', 'add', 'origin', remote], root)
    const filesChanged = commitChanges(root, remoteType)
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    git(['push', '-u', 'origin', branch], root)
    return { action: 'synced', message: `Remote added and pushed to ${remote}`, remote, files_changed: filesChanged, warning: stripWarning(root, remoteType) }
  }

  // State 2: Git repo, no remote
  if (!existingRemote) {
    const filesChanged = commitChanges(root, remoteType)
    if (filesChanged === 0) {
      return { action: 'up-to-date', message: 'No changes to commit. Add a remote with await plur.sync({ remote: "..." }) to enable cross-device sync.', remote: null, files_changed: 0 }
    }
    return { action: 'committed', message: `Committed ${filesChanged} file(s) locally.`, remote: null, files_changed: filesChanged }
  }

  // State 3: Git repo with remote — full sync
  const filesChanged = commitChanges(root, remoteType)

  // Fetch to check if we need to pull/push
  gitSafe(['fetch', 'origin', '--quiet'], root)
  const behind = countDiff(root, 'behind')
  const aheadBefore = countDiff(root, 'ahead')

  // Capture the pull result so a pull that silently failed is not reported as
  // `synced`, and re-measure rather than trust it — `behind` below is the
  // count BEFORE pulling, i.e. what we meant to pull, not what we actually got.
  let pullFailed = false
  if (behind > 0) {
    const storePath = join(root, 'engrams.yaml')
    const before = existsSync(storePath) ? readFileSync(storePath, 'utf8') : null
    const pulledResult = pullRebase(root, remoteType)
    pullFailed = !pulledResult.ok
    if (pulledResult.unresolved.length > 0) heldPending = readHeldRecovery(root) ?? pulledResult.unresolved
    recordPulledCount(storePath, before)
    // Committed sibling records rewritten after a rename: commit them now so
    // this sync pushes the correction (it is the user's own remote).
    if (pulledResult.ok && pulledResult.rewroteSiblings.length > 0) commitChanges(root, remoteType)
  }
  const behindAfter = behind > 0 ? countDiff(root, 'behind') : 0
  const pulled = behind - behindAfter

  // Push if we have local commits.
  //
  // NOT via `gitSafe`: it swallows the error and returns null, so a rejected
  // push (expired credentials, no network, non-fast-forward) would look
  // identical to a successful one, and an agent caller would report the sync
  // worked while the engrams sit unpushed.
  let pushError: string | null = null
  const aheadAfter = countDiff(root, 'ahead')
  if (aheadAfter > 0) {
    try {
      git(['push', 'origin'], root)
    } catch (err) {
      pushError = ((err as Error).message || '').trim() || 'git push failed'
    }
  }

  const heldNote = heldPendingNote(root, heldPending)
  const warn = (): string | undefined => {
    // stripWarning parses engrams.yaml; with held records pending it may be the unreadable file.
    let w: string | undefined
    try { w = stripWarning(root, remoteType) } catch { w = undefined }
    return heldNote ? (w ? `${heldNote} ${w}` : heldNote) : w
  }

  if (filesChanged === 0 && behind === 0 && aheadBefore === 0 && !heldNote) {
    return { action: 'up-to-date', message: 'Already in sync.', remote: existingRemote, files_changed: 0, warning: stripWarning(root, remoteType) }
  }

  const parts: string[] = []
  if (filesChanged > 0) parts.push(`${filesChanged} file(s) committed`)
  // Report what was actually integrated, and say so plainly when it was not:
  // claiming a pull that did not happen makes a user believe two machines
  // agree when they do not.
  if (pulled > 0) parts.push(`pulled ${pulled} remote commit(s)`)
  if (pullFailed || behindAfter > 0) {
    parts.push(`NOT pulled — still ${behindAfter} commit(s) behind the remote; resolve locally and retry`)
  }
  // `aheadAfter` is measured BEFORE the push, so it counts the commits this
  // sync pushed.
  if (aheadAfter > 0 && !pushError) parts.push('pushed')
  // Say it in the message too — a caller reading only the text still sees it.
  if (pushError) parts.push('NOT pushed — the commit is local only')
  if (heldNote) parts.push(`scope:local records NOT restored — see ${relative(root, heldRecoveryPath(root))}`)

  return {
    action: 'synced',
    message: `Synced. ${parts.join(', ')}.`,
    remote: existingRemote,
    files_changed: filesChanged,
    warning: warn(),
    ...(pushError ? { push_error: pushError } : {}),
  }
}
