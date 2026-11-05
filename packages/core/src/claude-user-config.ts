import {
  existsSync, lstatSync, readlinkSync, realpathSync, statSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, chmodSync, readdirSync, accessSync, openSync, fsyncSync, closeSync, constants,
} from 'fs'
import { basename, dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { backupPath } from './instruction-section.js'

/**
 * Register the `plur` MCP server for Claude Code at user scope in `~/.claude.json`
 * (the only user-level place it reads), shared by `plur init` and `plur-mcp init`.
 * - All other keys are kept; a BOM is dropped. Non-object files or `mcpServers`,
 *   and symlinks to missing files, are refused untouched.
 * - The file is re-read just before the atomic rename; if it changed, re-apply
 *   once, then refuse. This narrows but cannot close the lost-update window
 *   (Claude Code takes no lock); more retries would lose more of its updates.
 * - Back up before a change (`<name>.plur-backup-<stamp>`, 0600, newest `maxBackups` kept); no change, no write.
 */
export interface RegisterClaudeUserMcpOptions {
  /** `~/.claude.json`. */
  userPath: string
  /** The entry to register when there is none. */
  entry: () => Record<string, unknown>
  /** Heal the `plur` entry of `config` in place; a label when it changed something, else null. */
  heal?: (config: Record<string, unknown>) => string | null
  /** An entry from an older location to move here when `~/.claude.json` has none. */
  legacyEntry?: unknown
  /** Where `legacyEntry` came from, for the message. */
  legacyPath?: string
  /** PLUR backups of the file to keep (default 3). */
  maxBackups?: number
  /** Attempts in all when the file changes underneath (default 2: the first and one re-apply). */
  maxAttempts?: number
  /** The command to name when the file was busy (default `plur init`). */
  rerunCommand?: string
  /** Test seam: runs just before the last check and the rename. */
  _beforeWrite?: () => void
}

export interface RegisterClaudeUserMcpResult {
  /** The server is registered in the file (whether or not this run wrote it). */
  ok: boolean
  status: 'registered' | 'moved' | 'healed' | 'already' | 'refused'
  /** One line for the install report. */
  message: string
  backup?: string
}

type Parsed = { config: Record<string, unknown> } | { error: string }

function parse(raw: string): Parsed {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { error: 'is not valid JSON' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'is not a JSON object' }
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    return { error: 'has an "mcpServers" value that is not an object, so Claude Code cannot read servers from it either' }
  }
  return { config: parsed as Record<string, unknown> }
}

function apply(config: Record<string, unknown>, opts: RegisterClaudeUserMcpOptions):
  { changed: boolean; status: Exclude<RegisterClaudeUserMcpResult['status'], 'refused'>; label?: string } {
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, 'plur')) {
    const label = opts.heal?.(config) ?? null
    return label ? { changed: true, status: 'healed', label } : { changed: false, status: 'already' }
  }
  if (opts.legacyEntry && typeof opts.legacyEntry === 'object') {
    servers.plur = JSON.parse(JSON.stringify(opts.legacyEntry))
    config.mcpServers = servers
    const label = opts.heal?.(config) ?? undefined
    return { changed: true, status: 'moved', ...(label ? { label } : {}) }
  }
  servers.plur = opts.entry()
  config.mcpServers = servers
  return { changed: true, status: 'registered' }
}

const serialize = (config: Record<string, unknown>) => JSON.stringify(config, null, 2) + '\n'

function syncFile(path: string): void {
  let fd: number | undefined
  try { fd = openSync(path, 'r+'); fsyncSync(fd) } catch { /* best effort */ } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * Delete all but the newest `keep` PLUR backups of `target`. Ordered by
 * modification time, not name: a pruned name is free again and can be reused
 * by a later backup within the same second.
 */
export function pruneBackups(target: string, keep: number): void {
  const dir = dirname(target)
  const prefix = `${basename(target)}.plur-backup-`
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => n.startsWith(prefix))
      .map(n => { try { return { n, t: statSync(join(dir, n)).mtimeMs } } catch { return { n, t: 0 } } })
      .sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1))
      .map(x => x.n)
  } catch { return }
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { unlinkSync(join(dir, n)) } catch { /* leave it */ }
  }
}

export function registerClaudeUserMcp(opts: RegisterClaudeUserMcpOptions): RegisterClaudeUserMcpResult {
  const { userPath } = opts
  const maxAttempts = opts.maxAttempts ?? 2
  const keep = opts.maxBackups ?? 3
  const refused = (why: string): RegisterClaudeUserMcpResult =>
    ({ ok: false, status: 'refused', message: `not registered — ${userPath} ${why}. Nothing was changed` })
  const done = (status: RegisterClaudeUserMcpResult['status'], label: string | undefined, backup: string | null): RegisterClaudeUserMcpResult => {
    const head = {
      registered: `registered in ${userPath}`,
      moved: `moved from ${opts.legacyPath ?? 'an older location'} to ${userPath}, where Claude Code reads MCP servers`,
      healed: `${label ?? 'updated'} in ${userPath}`,
      already: `already registered in ${userPath}`,
      refused: '',
    }[status]
    const notes = [status === 'moved' && label ? label : null, backup ? `backup: ${backup}` : null].filter(Boolean)
    return { ok: true, status, message: notes.length ? `${head} (${notes.join('; ')})` : head, ...(backup ? { backup } : {}) }
  }

  let link: ReturnType<typeof lstatSync> | null = null
  try { link = lstatSync(userPath) } catch { link = null }
  if (link?.isSymbolicLink() && !existsSync(userPath)) {
    let to = '?'
    try { to = readlinkSync(userPath) } catch { /* keep ? */ }
    return refused(`is a symlink to ${to}, which does not exist; point the link at a real file or remove it, then run init again`)
  }

  if (!link) {
    const config: Record<string, unknown> = {}
    const a = apply(config, opts)
    try {
      opts._beforeWrite?.()
      // Claude Code keeps private state in this file and creates it 0600.
      writeFileSync(userPath, serialize(config), { flag: 'wx', mode: 0o600 })
      return done(a.status, a.label, null)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return refused(`could not be created (${(err as Error).message})`)
      // Created meanwhile: fall through and edit what is there now.
    }
  }

  let target: string
  try {
    target = realpathSync(userPath)
    accessSync(target, constants.W_OK)
  } catch (err) {
    return refused(`is not writable by PLUR (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let before: ReturnType<typeof statSync>
    let raw: Buffer
    try {
      before = statSync(target)
      raw = readFileSync(target)
    } catch (err) {
      return refused(`could not be read (${(err as Error).message})`)
    }
    if (before.nlink > 1) return refused('shares its contents with another name (a hard link), and PLUR does not rewrite shared files')
    const text = raw.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(raw)) return refused('is not UTF-8 text')
    const p = parse(text)
    if ('error' in p) return refused(p.error)
    const a = apply(p.config, opts)
    if (!a.changed) return done(a.status, a.label, null)

    const dir = dirname(target)
    const mode = Number(before.mode) & 0o7777
    const tmp = join(dir, `.${basename(target)}.plur-tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    const backup = backupPath(target)
    const cleanup = () => {
      for (const f of [tmp, backup]) { try { unlinkSync(f) } catch { /* not there */ } }
    }
    try {
      writeFileSync(tmp, serialize(p.config), { flag: 'wx', mode })
      chmodSync(tmp, mode)
      syncFile(tmp)
      writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 })
      chmodSync(backup, 0o600)
      opts._beforeWrite?.()
      // The last look, as close to the rename as it can be: content first,
      // then the cheap stat, then rename.
      const now = readFileSync(target)
      const nowSt = statSync(target)
      if (!now.equals(raw) || nowSt.size !== before.size || nowSt.mtimeMs !== before.mtimeMs || nowSt.ino !== before.ino) {
        cleanup()
        continue
      }
      renameSync(tmp, target)
    } catch (err) {
      cleanup()
      return refused(`could not be written (${(err as Error).message})`)
    }
    pruneBackups(target, keep)
    return done(a.status, a.label, backup)
  }
  return {
    ok: false,
    status: 'refused',
    message: `not registered — Claude Code is writing ${userPath} right now. Nothing was changed; run ${opts.rerunCommand ?? 'plur init'} again`,
  }
}
