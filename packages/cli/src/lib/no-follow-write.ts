import { lstatSync } from 'fs'
import { join, relative, isAbsolute, sep } from 'path'

// security audit 2026-11-06: a repository can commit any path under the project as a symlink; PLUR never writes through one.

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
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      return parts[i]
    }
  }
  return null
}
