/**
 * A Cursor workspace root as a folder path (audit L2 of #1583). Cursor sends
 * folder paths; a `file://` URI is converted with fileURLToPath, Windows drive
 * letters included. Anything else that is not an absolute path is unusable,
 * and the hook then fails closed instead of using its own process folder.
 */
import { describe, it, expect } from 'vitest'
import { cursorRootPath } from '../src/lib/folder-gate.js'

describe('cursorRootPath', () => {
  it('an absolute POSIX path is kept', () => {
    expect(cursorRootPath('/home/me/proj', false)).toBe('/home/me/proj')
  })
  it('a file:// URI becomes its path', () => {
    expect(cursorRootPath('file:///home/me/my%20proj', false)).toBe('/home/me/my proj')
  })
  it('a Windows file:// URI keeps its drive letter', () => {
    expect(cursorRootPath('file:///C:/Users/me/proj', true)).toBe('C:\\Users\\me\\proj')
  })
  it('a Windows absolute path is kept', () => {
    expect(cursorRootPath('C:\\Users\\me\\proj', true)).toBe('C:\\Users\\me\\proj')
  })
  it('unusable values give null', () => {
    for (const v of ['', 'proj', './proj', 'C:proj', 'vscode-remote://ssh-remote+box/home/x', 'file://otherhost/share/x', 42, null, undefined, {}]) {
      expect(cursorRootPath(v, false), JSON.stringify(v)).toBeNull()
    }
    expect(cursorRootPath('/home/me/proj', true), 'a POSIX path on Windows is not a drive path').toBeNull()
  })
})
