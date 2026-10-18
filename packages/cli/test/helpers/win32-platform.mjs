// Preload for spawned-CLI tests (`node --import <this> cli.js ...`): make the
// process report itself as Windows. `os.platform()` returns `process.platform`,
// so every `platform() === 'win32'` branch in the CLI takes its Windows path.
// Path separators stay POSIX (path.join is bound at load time), which is fine:
// the tests assert on quoting, matching and entry shape, not on separators.
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'win32' })
// A real Windows process always has USERNAME (and usually USERDOMAIN); give the
// stub one so code that names the current account sees a consistent Windows
// environment instead of the host's (which has USER, not USERNAME).
if (!process.env.USERNAME) process.env.USERNAME = process.env.USER || 'stub-user'
// Core protects every config.yaml write with icacls on Windows (#1631) and
// refuses the write when it cannot. A real Windows process has icacls; give
// the stub a faithful fake (fake-icacls/icacls: the access list is kept in the
// file's mode, so it follows the file across a rename). Only on a non-Windows
// host — on real Windows the real tool is used.
if (realPlatform !== 'win32') {
  const fakeBin = join(dirname(fileURLToPath(import.meta.url)), 'fake-icacls')
  process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`
}
