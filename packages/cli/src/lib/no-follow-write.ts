import { lstatSync, mkdirSync, openSync, readSync, writeSync, closeSync, fstatSync, constants } from 'fs'
import { join, relative, isAbsolute, sep } from 'path'

/**
 * Writes PLUR makes INSIDE a project (a workspace's `.cursor/rules/*.mdc`,
 * the project `.gitignore`) must land in that project and nowhere else.
 * A repository can commit any of those paths, or a directory above them, as
 * a symlink, and git materialises it on clone; a plain `writeFileSync` /
 * `mkdirSync({ recursive: true })` follows it and rewrites a file the
 * repository chose, outside the project (security audit 2026-11-06).
 *
 * The rule here: `root` is trusted (the caller resolved it); every component
 * from `root` down to `path` must be a real directory (created one level at a
 * time when missing, never through a link), and the leaf must be absent or a
 * regular file, opened with O_NOFOLLOW where the platform has it.
 */

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code
}

function componentsUnder(root: string, path: string): string[] | null {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  const out: string[] = []
  let cur = root
  for (const part of rel.split(sep)) {
    cur = join(cur, part)
    out.push(cur)
  }
  return out
}

/**
 * The first path component from `root` (exclusive) down to `path` (inclusive)
 * that is a symlink, a non-directory parent, or a non-regular leaf — or null
 * when the path is safe to write (missing components count as safe). A path
 * outside `root` is returned as-is (refused).
 */
export function unsafeComponentUnder(root: string, path: string): string | null {
  const parts = componentsUnder(root, path)
  if (!parts) return path
  for (let i = 0; i < parts.length; i++) {
    const leaf = i === parts.length - 1
    try {
      const st = lstatSync(parts[i])
      if (st.isSymbolicLink() || (leaf ? !st.isFile() : !st.isDirectory())) return parts[i]
    } catch (err) {
      if (code(err) === 'ENOENT') return null
      return parts[i]
    }
  }
  return null
}

/**
 * Write `content` to `path` without following any symlink between `root` and
 * `path`. Returns false (and writes nothing) when a component is a symlink or
 * of the wrong type, or when the write fails; never throws.
 */
export function writeFileNoFollow(root: string, path: string, content: string, mode = 0o644): boolean {
  const parts = componentsUnder(root, path)
  if (!parts) return false
  for (const dir of parts.slice(0, -1)) {
    try {
      const st = lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
    } catch (err) {
      if (code(err) !== 'ENOENT') return false
      // Non-recursive: the parent was just vetted. EEXIST here means something
      // appeared in between — refuse rather than look again.
      try { mkdirSync(dir) } catch { return false }
    }
  }
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return false
  } catch (err) {
    if (code(err) !== 'ENOENT') return false
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, mode)
  } catch { return false }
  try {
    if (!fstatSync(fd).isFile()) return false
    writeSync(fd, content)
    return true
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Read `path` as UTF-8 under the same rule. Returns '' when it is absent and
 * null when it is a symlink (or under one) or otherwise unsafe to read.
 */
export function readFileNoFollow(root: string, path: string): string | null {
  if (unsafeComponentUnder(root, path)) return null
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  } catch (err) {
    return code(err) === 'ENOENT' ? '' : null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)))
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
