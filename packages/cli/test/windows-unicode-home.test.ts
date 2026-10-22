/**
 * A Windows account name with a non-English letter (2026-10-22, found by the
 * locked-down first-install proof on a Windows runner, home "Ünïcode Üser home"):
 *
 * - `plur init` crashed Node outright (exit 0xC0000409, no output) while
 *   copying the bundled skills: Node's native fs.cpSync aborts on such a path
 *   on Windows. The copy is now done file by file.
 * - The .cmd launchers (plur-hook.cmd, plur-mcp.cmd) are written as UTF-8, but
 *   cmd.exe reads a batch file in the console code page, so the node and script
 *   paths came out garbled and the launch failed. A launcher whose paths are not
 *   plain ASCII now switches cmd to UTF-8 first; an ASCII one is unchanged.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { windowsLauncher } from '../src/commands/init.js'

describe('a home path with a non-English letter on Windows', () => {
  it('init copies no tree with fs.cpSync (it aborts Node on Windows for such paths)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'init.ts'), 'utf8')
    expect(src).not.toMatch(/\bcpSync\s*\(/)
  })

  it('a launcher whose paths are plain ASCII is byte-for-byte what earlier versions wrote', () => {
    expect(windowsLauncher('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js'))
      .toBe('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ana\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js" %*\r\n')
  })

  it('a launcher with a non-ASCII path switches cmd to UTF-8 before the command line, quietly', () => {
    const text = windowsLauncher('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Jože Müller\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(lines[1]).toBe('chcp 65001 >nul')
    expect(lines[2]).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jože Müller\\AppData\\Roaming\\npm\\node_modules\\@plur-ai\\cli\\dist\\index.js" %*')
  })
})
