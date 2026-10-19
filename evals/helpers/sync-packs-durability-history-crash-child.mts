// Child process for DUR-2: saves memories in a loop until it is killed.
//
// Usage: node --import <tsx loader> this-file.ts <storeDir> <round>
//
// It prints "ACK <statement>" on stdout only after learn() has resolved, i.e.
// after PLUR acknowledged the save. The parent kills it with SIGKILL at a
// moment of its choosing and then checks the store.
//
// A slow disk is simulated so a kill reliably lands in the middle of writing a
// file: every file write is split into 20 pieces with a 10 ms pause between
// them. This changes timing only, never what is written or where.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const realOpen = fs.openSync
const realWrite = fs.writeSync
const realClose = fs.closeSync
const realWriteFile = fs.writeFileSync
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

fs.writeFileSync = function slowWriteFileSync(target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) {
  const isFd = typeof target === 'number'
  if (!isFd && !String(target).includes('engrams.yaml')) return realWriteFile(target, data, options)
  const enc = (typeof options === 'string' ? options : options?.encoding) ?? 'utf8'
  const buf = typeof data === 'string' ? Buffer.from(data, enc as BufferEncoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const fd = isFd ? target : realOpen(target as fs.PathLike, 'w')
  try {
    const piece = Math.max(1, Math.ceil(buf.length / 20))
    for (let off = 0; off < buf.length; off += piece) {
      realWrite(fd, buf, off, Math.min(piece, buf.length - off))
      pause(10)
    }
  } finally {
    if (!isFd) realClose(fd)
  }
} as typeof fs.writeFileSync
syncBuiltinESMExports()

const [storeDir, round] = process.argv.slice(2)
const { Plur } = await import('../../packages/core/src/index.js')
const { setEmbeddingsEnabled } = await import('../../packages/core/src/embeddings.js')
setEmbeddingsEnabled(false, 'eval child: embeddings off')
const plur = new Plur({ path: storeDir, autoDiscover: false })
await plur.ready()
for (let i = 0; ; i++) {
  const statement = `Crash round ${round} save ${i}: keep the ledger entry for item r${round}x${i}`
  await plur.learn(statement, { scope: 'global' })
  process.stdout.write(`ACK ${statement}\n`)
}
