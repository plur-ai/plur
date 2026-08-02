import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync, readdirSync, openSync, closeSync, fsyncSync } from 'fs'
import { join, dirname, relative } from 'path'
import * as yaml from 'js-yaml'
import { isSharedScope } from './scope-util.js'

export interface SyncStatus {
  initialized: boolean
  remote: string | null
  dirty: boolean
  branch: string | null
  ahead: number
  behind: number
}

/**
 * What the sync remote is for (#640). `personal` (default): the user's own
 * backup/mirror across their machines — every non-`scope:local` engram is
 * pushed, private included (today's historical behavior). `shared`: a
 * team-visible remote — ONLY shared-family-scope, non-private engrams are
 * pushed; personal-family and private engrams never leave the machine.
 */
export type SyncRemoteType = 'personal' | 'shared'

export interface SyncResult {
  action: 'initialized' | 'committed' | 'synced' | 'up-to-date'
  message: string
  remote: string | null
  files_changed: number
  /** Present when syncing to a remote — describes what the push set includes/excludes (#640). */
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

# PLUR — derived/cache files (regenerated automatically)
embeddings/
.embeddings-cache.json
*.db
*.sqlite
store.pglite/
exchange/
`

/**
 * Files that constitute the syncable engram store. ONLY these are ever staged by
 * plur sync — an explicit allowlist, so secrets (config.yaml) and machine-local
 * derived files (engrams.db, store.pglite/, exchange/) can NEVER ride along into a
 * synced repo, regardless of how the user's gitignore is (mis)configured. (#380, #384)
 */
const SYNC_PATHS = ['engrams.yaml', 'episodes.yaml', 'candidates.yaml', 'tensions.yaml', 'packs', '.gitignore'] as const

/**
 * Secret-bearing files that must never be tracked. Untracked on every sync, so a
 * repo created by a vulnerable pre-0.10.0 client that already committed one stops
 * carrying it forward. Includes `agent-keystore.json` (an encrypted agent key —
 * exposed the same way as config.yaml in the 2026-06 incident; #392). (Rotating
 * an exposed token/key and purging git history remain manual, operational steps —
 * code can only stop the bleeding.)
 */
const SECRET_PATHS = ['config.yaml', 'secrets.yaml', 'agent-keystore.json'] as const

/**
 * Files inside a pack that are syncable — an explicit ALLOWLIST, mirroring the
 * root-level SYNC_PATHS. `packs/` is force-added (`-f`) recursively, and packs come
 * from external/untrusted sources, so a denylist of secret filenames is the wrong
 * shape: it only blocks the names it enumerates, and anything it misses
 * (`.env`, `*.pem`, `id_rsa`, `credentials.yml`, `.npmrc`, …) rides into the synced
 * repo (#428). An allowlist inverts that — ONLY the files PLUR's own `exportPack`
 * writes are staged; any other file in a pack dir (a secret, a stray asset) is
 * never staged, by construction. (`**` matches the standard `packs/<name>/…` layout
 * and any deeper nesting.)
 */
const PACK_ALLOW_NAMES = ['SKILL.md', 'engrams.yaml', 'INTEGRITY', 'metadata.json'] as const

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim()
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
 * engram file — the data-staging guarantee that #329 needed — but now WITHOUT
 * neutralizing the user's global excludes for everything else (closes #384, and
 * replaces the #366 `neutraliseGlobalExcludes` helper), and config.yaml/secrets
 * are never in the pathspec so they can never be staged (#380).
 * Returns the number of files staged (added/modified/deleted).
 */
function stageStoreFiles(root: string): number {
  for (const secret of SECRET_PATHS) {
    gitSafe(['rm', '--cached', '--ignore-unmatch', '--quiet', '--', secret], root)
  }
  // Root store files (allowlist), EXCEPT `packs` which is staged by its own
  // file-level allowlist below — never as a whole force-added directory (#428).
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
 * The EXACT allowlisted files inside `packs/` to stage (#428). Returns concrete
 * paths, not globs, so a `git add` pathspec can never zero-match (which is fatal)
 * — the bug a "packs/<glob>/metadata.json" pathspec hit when no pack had one.
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
 * embed engram-DERIVED text (#686): `episodes.yaml` (session summaries, e.g. the
 * `plur_report_failure` episode quotes an engram's failure context),
 * `candidates.yaml` (pending contradiction pairs — legacy, no in-core writer,
 * but synced when present), and `tensions.yaml` (statement_a/statement_b are
 * verbatim snapshots of the two engrams' statements). #678 stripped only
 * engrams.yaml, so a `shared` remote could still receive private-derived text
 * through these files even though the engrams themselves were withheld.
 */
const SIBLING_STRIP_FILES = ['episodes.yaml', 'candidates.yaml', 'tensions.yaml'] as const

/**
 * Canonical engram id token, matched anywhere inside a serialized record
 * (schema: `/^(ENG|ABS|META)-[A-Za-z0-9-]+$/` in schemas/engram.ts). Greedy
 * over the id charset, so a longer unknown token ("ENG-0011" around "ENG-001")
 * extracts as itself and simply fails push-set membership — conservative.
 */
const ENGRAM_ID_TOKEN = /\b(?:ENG|ABS|META)-[A-Za-z0-9-]+/g

/**
 * Dump options matching the sibling-file writers (episodes.ts / tension-store.ts
 * both use `{ lineWidth: 120, noRefs: true }`), so a stripped sibling blob is
 * byte-identical to what the file would contain if it only ever held the kept
 * records — the same determinism that keeps the #396 no-infinite-dirty property.
 */
const SIBLING_DUMP_OPTS = { lineWidth: 120, noRefs: true }

interface EngramRecord { id?: string; scope?: string; visibility?: string; [k: string]: unknown }

/**
 * Read engrams.yaml and return the engram list, tolerating both the canonical
 * `{ engrams: [...] }` shape and a bare top-level array. Returns null when the
 * file is absent, unparseable, or not in a recognized engram shape.
 */
function readEngramList(root: string): { raw: unknown; list: EngramRecord[] } | null {
  const path = join(root, 'engrams.yaml')
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = yaml.load(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (Array.isArray(raw)) return { raw, list: raw as EngramRecord[] }
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).engrams)) {
    return { raw, list: (raw as any).engrams as EngramRecord[] }
  }
  return null
}

/**
 * Push-set predicate per remote type (#640). `personal`: everything except
 * `scope:local` (historical behavior — private engrams follow the user across
 * their own machines). `shared`: ONLY shared-family scopes (`isSharedScope`)
 * with a non-private visibility — personal-family (`local`/`global`/`user:*`/
 * `agent:*`) and private-visibility engrams are excluded by construction.
 * NOTE the default visibility is 'private' (#401), so a shared remote receives
 * only engrams whose visibility was set deliberately — conservative on purpose,
 * consistent with the "private stays local" write-path semantics (#90).
 */
function pushKeep(remoteType: SyncRemoteType): (e: EngramRecord) => boolean {
  if (remoteType === 'shared') {
    return e => isSharedScope(e?.scope ?? '') && (e?.visibility ?? 'private') !== 'private'
  }
  return e => e?.scope !== 'local'
}

/**
 * Ids of the engrams a `shared` remote actually receives — the membership set
 * the sibling-file keep-predicate checks references against (#686). Empty when
 * engrams.yaml is absent/unparseable: with no provable push set, every
 * id-referencing sibling record is conservatively outside it.
 */
function sharedPushIds(root: string): Set<string> {
  const parsed = readEngramList(root)
  if (!parsed) return new Set()
  const keep = pushKeep('shared')
  return new Set(
    parsed.list.filter(keep).map(e => String(e?.id ?? '')).filter(Boolean),
  )
}

/**
 * Read a sibling store file as a record array (the shape episodes.ts /
 * tension-store.ts write). Returns null when absent, unparseable, or not an
 * array — in which case the staged blob is left as-is, the same posture
 * stageStrippedEngrams takes for an unrecognized engrams.yaml (#678).
 */
function readSiblingList(root: string, file: string): unknown[] | null {
  const path = join(root, file)
  if (!existsSync(path)) return null
  try {
    const raw = yaml.load(readFileSync(path, 'utf8'))
    return Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Keep-predicate for sibling-file records on a `shared` remote (#686): a record
 * is pushed only when EVERY engram id referenced anywhere in it resolves to the
 * shared push set. Shape-agnostic by design — the id scan runs over the whole
 * serialized record, so it covers structured fields (`engram_a`/`engram_b`/
 * `resolved_by`) and ids embedded in free text (episode summaries) alike, and
 * candidates.yaml needs no schema of its own. A referenced id that is personal/
 * private (stripped from the push) OR unknown (deleted, foreign) fails the test
 * — strip-on-doubt, because a false keep is a leak and a false drop is not.
 * Records with no engram references are kept: they are not derived from any
 * engram the filter withheld.
 */
function siblingKeep(pushedIds: Set<string>): (record: unknown) => boolean {
  return (record: unknown) => {
    const text = JSON.stringify(record) ?? ''
    const refs = text.match(ENGRAM_ID_TOKEN)
    if (!refs) return true
    return refs.every(id => pushedIds.has(id))
  }
}

/** Count of sibling records the `shared` strip withholds — for the sync warning. */
function droppedSiblingCount(root: string): number {
  const keep = siblingKeep(sharedPushIds(root))
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
 * includes/excludes for this remote type (#640, #686). Returns undefined when
 * there is nothing noteworthy to say.
 */
function stripWarning(root: string, remoteType: SyncRemoteType): string | undefined {
  const parsed = readEngramList(root)
  if (remoteType === 'shared') {
    const strippedEngrams = parsed ? parsed.list.filter(e => !pushKeep('shared')(e)).length : 0
    const strippedSiblings = droppedSiblingCount(root)
    if (strippedEngrams === 0 && strippedSiblings === 0) return undefined
    const parts: string[] = []
    if (strippedEngrams > 0) parts.push(`${strippedEngrams} personal-scope or private-visibility engram(s)`)
    if (strippedSiblings > 0) parts.push(`${strippedSiblings} episode/candidate/tension record(s) derived from non-pushed engrams`)
    return `Shared remote: pushed only shared-scope, non-private engrams — ${parts.join(' and ')} stayed local.`
  }
  if (!parsed) return undefined
  const count = parsed.list.filter(
    e => e?.scope !== 'local' && (e?.visibility ?? 'private') === 'private',
  ).length
  if (count === 0) return undefined
  return `Note: sync remote receives all engrams including ${count} private-visibility one(s) — use a private git remote. For a team remote, set sync.remote_type: shared to exclude them.`
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
 * engrams.yaml scope/visibility filter (#640) plus the sibling-file
 * derived-record filter (#686). Called on every commit path (init, commit,
 * conflict resolution) so no path can stage verbatim content.
 */
function stageStripped(root: string, remoteType: SyncRemoteType): void {
  stageStrippedEngrams(root, remoteType)
  stageStrippedSiblings(root, remoteType)
}

/**
 * Replace the *staged* engrams.yaml blob with one that keeps only the push set
 * for this remote type (#640; generalizes the scope:local strip of #380/#396).
 *
 * Re-serializes with the same YAML options PLUR uses everywhere, so the
 * stripped blob is deterministic across runs — this is what prevents an
 * infinite-dirty-state loop (issue #396): a sync whose only change is to a
 * stripped engram produces the identical stripped blob and therefore no new commit.
 */
function stageStrippedEngrams(root: string, remoteType: SyncRemoteType): void {
  const parsed = readEngramList(root)
  if (!parsed) return
  const { raw, list } = parsed
  const keep = pushKeep(remoteType)
  const filtered = list.filter(keep)
  if (filtered.length === list.length) return
  const out = Array.isArray(raw)
    ? yaml.dump(filtered, YAML_DUMP_OPTS)
    : yaml.dump({ ...(raw as object), engrams: filtered }, YAML_DUMP_OPTS)
  stageBlob(root, 'engrams.yaml', out)
}

/**
 * Replace the *staged* episodes/candidates/tensions blobs with ones that keep
 * only records derived from the shared push set (#686 — completes the #640
 * guarantee: "personal-family and private engrams never reach the remote"
 * must also hold for their derived text in the sibling store files).
 * `personal` remotes are untouched — the historical mirror-everything behavior.
 */
function stageStrippedSiblings(root: string, remoteType: SyncRemoteType): void {
  if (remoteType !== 'shared') return
  const keep = siblingKeep(sharedPushIds(root))
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

function pullRebase(root: string, remoteType: SyncRemoteType): boolean {
  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], root) || 'main'
  const result = gitSafe(['pull', '--rebase', 'origin', branch], root)
  if (result !== null) return true
  // Rebase conflict — abort and try merge
  gitSafe(['rebase', '--abort'], root)
  const mergeResult = gitSafe(['pull', 'origin', branch, '--no-edit'], root)
  if (mergeResult !== null) return true
  // Merge conflict — check for conflict markers before staging
  if (hasConflictMarkers(root)) {
    // Abort the merge rather than committing corrupt files
    gitSafe(['merge', '--abort'], root)
    throw new Error('Sync conflict: YAML files have merge conflicts that require manual resolution. Your local changes are preserved.')
  }
  stageStoreFiles(root)
  // #640: the conflict-resolution commit previously staged the working-tree
  // engrams.yaml VERBATIM — scope:local engrams rode into the remote on this
  // path. Strip the staged blob exactly like every other commit path.
  stageStripped(root, remoteType)
  gitSafe(['commit', '-m', 'plur sync: merge conflict resolved (kept both)'], root)
  return true
}

export function sync(root: string, remote?: string, options?: { remoteType?: SyncRemoteType }): SyncResult {
  if (!hasGitCli()) {
    throw new Error('git is not installed. Install git to enable sync.')
  }
  // Default `personal` preserves the historical mirror-everything behavior for
  // every existing install (#640) — `shared` is an explicit opt-in.
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

  if (behind > 0) {
    pullRebase(root, remoteType)
  }

  // Push if we have local commits.
  //
  // NOT via `gitSafe`: it swallows the error and returns null, and the return
  // was discarded anyway, so a rejected push (expired credentials, no network,
  // non-fast-forward) produced a result byte-identical to a successful one.
  // For an agent caller that is the worst shape — it reports the sync worked
  // and the engrams sit unpushed indefinitely with nobody looking.
  let pushError: string | null = null
  const aheadAfter = countDiff(root, 'ahead')
  if (aheadAfter > 0) {
    try {
      git(['push', 'origin'], root)
    } catch (err) {
      pushError = ((err as Error).message || '').trim() || 'git push failed'
    }
  }

  if (filesChanged === 0 && behind === 0 && aheadBefore === 0) {
    return { action: 'up-to-date', message: 'Already in sync.', remote: existingRemote, files_changed: 0, warning: stripWarning(root, remoteType) }
  }

  const parts: string[] = []
  if (filesChanged > 0) parts.push(`${filesChanged} file(s) committed`)
  if (behind > 0) parts.push(`pulled ${behind} remote commit(s)`)
  if (aheadAfter === 0 && aheadBefore > 0) parts.push('pushed')
  // Say it in the message too — a caller reading only the text still sees it.
  if (pushError) parts.push('NOT pushed — the commit is local only')

  return {
    action: 'synced',
    message: `Synced. ${parts.join(', ')}.`,
    remote: existingRemote,
    files_changed: filesChanged,
    warning: stripWarning(root, remoteType),
    ...(pushError ? { push_error: pushError } : {}),
  }
}

export interface LockOptions {
  maxRetries?: number
  baseDelay?: number
  staleThreshold?: number
}

/** File-based exclusive lock using O_EXCL. Retries with exponential backoff. */
export function withLock<T>(
  filePath: string,
  fn: () => T,
  options?: LockOptions,
): T {
  const lockPath = filePath + '.lock'
  const maxRetries = options?.maxRetries ?? 5
  const baseDelay = options?.baseDelay ?? 100
  const staleThreshold = options?.staleThreshold ?? 10_000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: 'wx' })
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs > staleThreshold) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue
      }
      if (attempt === maxRetries) {
        throw new Error(`Failed to acquire lock on ${filePath} after ${maxRetries} retries`)
      }
      const delay = baseDelay * Math.pow(2, attempt)
      const end = Date.now() + delay
      while (Date.now() < end) { /* busy wait — sync context */ }
    }
  }

  try {
    return fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* lock already gone */ }
  }
}

/** Options for {@link atomicWrite}. */
export interface AtomicWriteOptions {
  /**
   * fsync the file and its parent directory before returning. Default `true`.
   *
   * Pass `false` ONLY for derived, rebuildable state (embedding cache,
   * reranker-eval cache, telemetry counters). Never for a store file: see the
   * durability note on {@link atomicWrite}.
   */
  durable?: boolean
}

/** Counter making each tmp name unique within a process (pid makes it unique across them). */
let tmpCounter = 0

/**
 * Atomic write: write to a temp file, flush it, then rename over the target.
 *
 * ## Why the fsync (audit #794, F4)
 *
 * write + rename alone is atomic with respect to a dying *process* — the page
 * cache outlives it, so a reader either sees the old file or the new one. It is
 * NOT atomic with respect to a dying *kernel*. On power loss the rename can
 * reach disk before the data does, and the canonical artifact is a zero-length
 * or truncated file.
 *
 * That artifact is precisely the input to the corrupt-read wipe (#795): a
 * zero-length engrams.yaml used to read as an empty corpus, and the next write
 * persisted it. The two compose into total corpus loss, which is why this is
 * fsync-by-default rather than fsync-on-request.
 *
 * The parent directory is flushed too, because the rename itself is directory
 * metadata — without that flush the durable file can still be reachable only
 * under its temp name after a crash.
 *
 * ## Why the tmp name is unique
 *
 * It used to be a fixed `<path>.tmp`, which let two concurrent writers clobber
 * each other's partial file and rename it into place — measured in probe P02 as
 * a hard `ENOENT: rename '…/episodes.yaml.tmp'` crash when the loser's tmp had
 * already been renamed away. Unique names make concurrent writers independent;
 * the last rename wins cleanly instead of publishing a half-written blend.
 */
export function atomicWrite(filePath: string, content: string, opts: AtomicWriteOptions = {}): void {
  const durable = opts.durable !== false
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`
  try {
    if (durable) {
      const fd = openSync(tmp, 'w')
      try {
        writeFileSync(fd, content)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      writeFileSync(tmp, content)
    }
    renameSync(tmp, filePath)
    if (durable) fsyncDir(dir)
  } catch (err) {
    // Never leave the tmp behind on a failed write — it would accumulate, and
    // with a unique name nothing would ever clean it up.
    try { unlinkSync(tmp) } catch { /* already gone, or never created */ }
    throw err
  }
}

/**
 * fsync a directory so a rename into it is durable.
 *
 * Best-effort by design: directory fds cannot be opened for sync on Windows,
 * and some filesystems reject the fsync outright. A failure here means the
 * rename may not survive power loss — it does NOT mean the write failed, and
 * throwing would turn a working write into a spurious error.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* platform does not support it — the file's own fsync still happened */
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}
