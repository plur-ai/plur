import type { FolderPolicy, Plur } from '@plur-ai/core'

/** Optional diagnostics must not discard successfully injected memory. */
export async function cachedServerLines(plur: Plur, dir: string, policy: FolderPolicy): Promise<string[]> {
  try { return await plur.serverSessionLines(dir, policy) }
  catch { return ['PLUR → server · ⚠ cached status could not be read; run plur doctor'] }
}
