/**
 * Publish filter — materialize the *publishable* subset of an engram set for a
 * public/shipped target (e.g. the committed `engrams.yaml` in the open-source
 * repo, or a public pack).
 *
 * This exists because of the 2026-06 leak: `.plur/engrams.yaml` shipped 67
 * engrams including prod droplet IPs and basic-auth for an internal host. The
 * blunt fix was to gitignore the file. The real fix is here — a two-gate filter
 * so the committed file can safely contain *only* what is meant to be public:
 *
 *   An engram is publishable IFF
 *     (1) visibility === 'public', AND
 *     (2) `detectSensitive` finds nothing in its serialized content.
 *
 * Gate (2) is not redundant with (1): in the leak, several of the worst engrams
 * were *mistagged* `public`. The content scan is the ground truth that the tag
 * is not. A `public`-tagged engram that trips the scan is rejected AND surfaced
 * as a mistag, never silently shipped.
 */
import { detectSensitive } from './secrets.js'
import type { Engram } from './schemas/engram.js'

export interface PublishReject {
  id: string
  visibility: string
  /** Why it was held back: non-public visibility and/or content-scan hits. */
  reasons: string[]
  /** True when the engram was tagged `public` but failed the content scan —
   *  a mistag that would have leaked. Worth a loud warning. */
  mistagged: boolean
}

export interface PublishResult {
  /** Public + content-clean, sorted by id for deterministic output. */
  publishable: Engram[]
  /** Everything held back, with reasons. */
  rejected: PublishReject[]
}

/** Serialize all of an engram's content for scanning (every field, not just the statement). */
function engramText(e: Engram): string {
  return JSON.stringify(e)
}

/**
 * Split an engram set into the publishable public subset and the rejected rest.
 * Pure and deterministic — no I/O, stable ordering — so callers (the `plur
 * publish` command and the pre-push hook) and tests share one source of truth.
 */
export function filterPublishable(engrams: Engram[]): PublishResult {
  const publishable: Engram[] = []
  const rejected: PublishReject[] = []

  for (const e of engrams) {
    const visibility = (e as { visibility?: string }).visibility ?? 'private'
    const reasons: string[] = []

    if (visibility !== 'public') {
      reasons.push(`visibility=${visibility} (not public)`)
    }

    const hits = detectSensitive(engramText(e))
    const failedScan = hits.length > 0
    if (failedScan) {
      reasons.push(`content scan: ${[...new Set(hits.map(h => h.pattern))].join(', ')}`)
    }

    if (reasons.length === 0) {
      publishable.push(e)
    } else {
      rejected.push({
        id: (e as { id?: string }).id ?? '(no id)',
        visibility,
        reasons,
        mistagged: visibility === 'public' && failedScan,
      })
    }
  }

  publishable.sort((a, b) => {
    const ai = (a as { id?: string }).id ?? ''
    const bi = (b as { id?: string }).id ?? ''
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })

  return { publishable, rejected }
}
