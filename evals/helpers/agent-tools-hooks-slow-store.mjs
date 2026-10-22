// Preload for a hook process (`node --import <this> ...`): make the memory
// store slow or broken, the way a store that never answers looks to a hook.
//
//   PLUR_EVAL_STORE=hang-hybrid  the semantic (hybrid) search never answers;
//                                keyword search still works
//   PLUR_EVAL_STORE=hang-all     every search never answers
//
// A real hung store keeps the process alive (a pending read, a socket), so the
// hang here holds a timer: without it Node would simply exit, and a hook with
// no deadline at all would look as if it had one.
//
// The CLI loads @plur-ai/core from packages/core/dist; this patches that same
// module (same real path, same module instance). Nothing in production reads
// PLUR_EVAL_STORE.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const mode = process.env.PLUR_EVAL_STORE ?? ''
if (mode) {
  const here = dirname(fileURLToPath(import.meta.url))
  const core = await import(pathToFileURL(join(here, '..', '..', 'packages', 'core', 'dist', 'index.js')).href)
  const hang = () => new Promise(() => { setInterval(() => {}, 1_000) })
  const proto = core.Plur.prototype
  if (mode === 'hang-hybrid' || mode === 'hang-all') proto.injectHybrid = hang
  if (mode === 'hang-all') proto.inject = hang
}
