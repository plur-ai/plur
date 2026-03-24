import { execSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface SyncStatus {
  initialized: boolean
  remote: string | null
  dirty: boolean
  branch: string | null
  ahead: number
  behind: number
}

export interface SyncResult {
  action: 'initialized' | 'committed' | 'synced' | 'up-to-date'
  message: string
  remote: string | null
  files_changed: number
}

const GITIGNORE = `# PLUR — derived/cache files (regenerated automatically)
embeddings/
*.db
*.sqlite
exchange/
`

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 30_000 }).trim()
}

function gitSafe(args: string, cwd: string): string | null {
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
    execSync('git --version', { encoding: 'utf8', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function getRemote(root: string): string | null {
  return gitSafe('remote get-url origin', root)
}

function isDirty(root: string): boolean {
  const status = gitSafe('status --porcelain', root)
  return status !== null && status.length > 0
}

function countDiff(root: string, direction: 'ahead' | 'behind'): number {
  const tracking = gitSafe('rev-parse --abbrev-ref @{u}', root)
  if (!tracking) return 0
  const flag = direction === 'ahead' ? 'left' : 'right'
  const count = gitSafe(`rev-list --${flag}-only --count HEAD...@{u}`, root)
  return count ? parseInt(count, 10) : 0
}

export function getSyncStatus(root: string): SyncStatus {
  if (!isGitRepo(root)) {
    return { initialized: false, remote: null, dirty: false, branch: null, ahead: 0, behind: 0 }
  }
  const branch = gitSafe('rev-parse --abbrev-ref HEAD', root)
  const remote = getRemote(root)
  // Fetch remote state if available (ignore errors for offline)
  if (remote) gitSafe('fetch origin --quiet', root)
  return {
    initialized: true,
    remote,
    dirty: isDirty(root),
    branch,
    ahead: countDiff(root, 'ahead'),
    behind: countDiff(root, 'behind'),
  }
}

function initRepo(root: string): void {
  git('init', root)
  writeFileSync(join(root, '.gitignore'), GITIGNORE)
  git('add -A', root)
  git('commit -m "Initial PLUR engram store"', root)
}

function commitChanges(root: string): number {
  if (!isDirty(root)) return 0
  git('add -A', root)
  const diff = gitSafe('diff --cached --stat --shortstat', root)
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  git(`commit -m "plur sync ${now}"`, root)
  // Parse "N files changed" from shortstat
  const match = diff?.match(/(\d+) file/)
  return match ? parseInt(match[1], 10) : 1
}

function pullRebase(root: string): boolean {
  const result = gitSafe('pull --rebase origin main', root)
  if (result !== null) return true
  // Rebase conflict — abort and try merge
  gitSafe('rebase --abort', root)
  const mergeResult = gitSafe('pull origin main --no-edit', root)
  if (mergeResult !== null) return true
  // Merge conflict — accept both, commit
  git('add -A', root)
  gitSafe('commit -m "plur sync: merge conflict resolved (kept both)"', root)
  return true
}

export function sync(root: string, remote?: string): SyncResult {
  if (!hasGitCli()) {
    throw new Error('git is not installed. Install git to enable sync.')
  }

  // State 1: No git repo — initialize
  if (!isGitRepo(root)) {
    initRepo(root)
    if (remote) {
      git(`remote add origin ${remote}`, root)
      // Detect default branch name
      const branch = git('rev-parse --abbrev-ref HEAD', root)
      git(`push -u origin ${branch}`, root)
      return { action: 'initialized', message: `Initialized and pushed to ${remote}`, remote, files_changed: 0 }
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
    git(`remote add origin ${remote}`, root)
    const filesChanged = commitChanges(root)
    const branch = git('rev-parse --abbrev-ref HEAD', root)
    git(`push -u origin ${branch}`, root)
    return { action: 'synced', message: `Remote added and pushed to ${remote}`, remote, files_changed: filesChanged }
  }

  // State 2: Git repo, no remote
  if (!existingRemote) {
    const filesChanged = commitChanges(root)
    if (filesChanged === 0) {
      return { action: 'up-to-date', message: 'No changes to commit. Add a remote with plur.sync({ remote: "..." }) to enable cross-device sync.', remote: null, files_changed: 0 }
    }
    return { action: 'committed', message: `Committed ${filesChanged} file(s) locally.`, remote: null, files_changed: filesChanged }
  }

  // State 3: Git repo with remote — full sync
  const filesChanged = commitChanges(root)

  // Fetch to check if we need to pull/push
  gitSafe('fetch origin --quiet', root)
  const behind = countDiff(root, 'behind')
  const aheadBefore = countDiff(root, 'ahead')

  if (behind > 0) {
    pullRebase(root)
  }

  // Push if we have local commits
  const aheadAfter = countDiff(root, 'ahead')
  if (aheadAfter > 0) {
    gitSafe('push origin', root)
  }

  if (filesChanged === 0 && behind === 0 && aheadBefore === 0) {
    return { action: 'up-to-date', message: 'Already in sync.', remote: existingRemote, files_changed: 0 }
  }

  const parts: string[] = []
  if (filesChanged > 0) parts.push(`${filesChanged} file(s) committed`)
  if (behind > 0) parts.push(`pulled ${behind} remote commit(s)`)
  if (aheadAfter === 0 && aheadBefore > 0) parts.push('pushed')

  return {
    action: 'synced',
    message: `Synced. ${parts.join(', ')}.`,
    remote: existingRemote,
    files_changed: filesChanged,
  }
}
