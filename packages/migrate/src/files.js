import * as fs from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Standalone codemod persistence: do not pull the memory engine into this CLI. */
/** @param {string} file @param {string} original @param {string} next */
export function replaceSource(file, original, next) {
  const before = fs.lstatSync(file)
  if (!before.isFile() || before.nlink !== 1) throw new Error('Source must be an unlinked regular file')
  const temporary = `${file}.${randomUUID()}.tmp`
  let owned = false
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    owned = true
    try {
      fs.fchmodSync(fd, before.mode & 0o777)
      fs.writeFileSync(fd, next, 'utf8')
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    // Catch editor changes and replaced links while staging. Editors do not
    // participate in our locks, so callers should run --write on a quiet tree.
    const current = fs.lstatSync(file)
    if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino ||
        current.mode !== before.mode || !fs.readFileSync(file).equals(Buffer.from(original, 'utf8'))) {
      throw new Error('Source changed during rewrite')
    }
    fs.renameSync(temporary, file)
    let directory
    try {
      directory = fs.openSync(dirname(file), 'r')
      fs.fsyncSync(directory)
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code ?? ''
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code) &&
          !(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR'].includes(code))) throw error
    } finally { if (directory !== undefined) fs.closeSync(directory) }
  } finally {
    if (owned) {
      try { fs.unlinkSync(temporary) } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw error
      }
    }
  }
}
