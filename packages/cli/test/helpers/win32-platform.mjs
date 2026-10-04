// Preload for spawned-CLI tests (`node --import <this> cli.js ...`): make the
// process report itself as Windows. `os.platform()` returns `process.platform`,
// so every `platform() === 'win32'` branch in the CLI takes its Windows path.
// Path separators stay POSIX (path.join is bound at load time), which is fine:
// the tests assert on quoting, matching and entry shape, not on separators.
Object.defineProperty(process, 'platform', { value: 'win32' })
