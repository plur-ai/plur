// Preload for spawned-CLI tests (`node --import <this> cli.js ...`): make the
// process report itself as Windows. `os.platform()` returns `process.platform`,
// so every `platform() === 'win32'` branch in the CLI takes its Windows path.
// Path separators stay POSIX (path.join is bound at load time), which is fine:
// the tests assert on quoting, matching and entry shape, not on separators.
Object.defineProperty(process, 'platform', { value: 'win32' })
// A real Windows process always has USERNAME (and usually USERDOMAIN); give the
// stub one so code that names the current account sees a consistent Windows
// environment instead of the host's (which has USER, not USERNAME).
if (!process.env.USERNAME) process.env.USERNAME = process.env.USER || 'stub-user'
