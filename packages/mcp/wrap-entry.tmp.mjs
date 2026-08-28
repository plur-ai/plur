const t0 = Date.now()
const mark = (m) => process.stderr.write(`[wrap +${Date.now() - t0}ms] ${m}\n`)
process.on('exit', (code) => mark(`exit event code=${code}`))
for (const sig of ['SIGTERM','SIGINT','SIGHUP','SIGPIPE','SIGUSR2']) {
  try { process.on(sig, () => { mark(sig); if (sig !== 'SIGPIPE') process.exit(1) }) } catch {}
}
process.stdout.on('error', (e) => mark(`stdout error: ${e.code} ${e.message}`))
process.stdin.on('close', () => mark('stdin closed'))
mark('wrap loaded')
await import('./dist/index.js')
