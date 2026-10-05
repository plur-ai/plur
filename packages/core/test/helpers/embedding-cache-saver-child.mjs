// #1586 round 6 (L1): one of several processes adding DIFFERENT vectors to the
// same embedding cache at the same time. Each save is one entry, so the
// processes interleave as much as they can.
const job = JSON.parse(process.argv[2])
const core = await import(job.dist)
const save = core._appendEmbeddingCacheEntries
if (typeof save !== 'function') { console.error('no saver'); process.exit(2) }
for (let i = 0; i < job.count; i++) {
  const id = `${job.prefix}-${i}`
  const embedding = Array.from({ length: 4 }, (_, k) => (i + k) / 10)
  let ok = false
  for (let attempt = 0; attempt < 50 && !ok; attempt++) ok = save(job.cachePath, job.embedder, { [id]: { hash: `h${i}`, embedding } })
  if (!ok) { console.error(`not saved: ${id}`); process.exit(3) }
}
