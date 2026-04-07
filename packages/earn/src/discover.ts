import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { parse as parseYaml } from 'yaml'

export interface DiscoverOptions {
  sources: Array<{ type: 'plur' | 'directory'; path: string }>
}

export interface DiscoverSuggestion {
  domain: string
  type: 'engram-pack' | 'zettel-collection' | 'research-report' | 'dataset' | 'agent-config'
  items: number
  suggestedPrice: string  // USDC 6 decimals
  description: string
  sourcePaths: string[]
}

interface ContentItem {
  source: 'plur' | 'directory'
  domain: string
  tags: string[]
  text: string
  path: string
}

interface EngramData {
  id: string
  statement: string
  scope?: string
  type?: string
  domain?: string
  tags?: string[]
  strength?: number
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverSuggestion[]> {
  const allContent: ContentItem[] = []

  for (const source of opts.sources) {
    if (source.type === 'plur') {
      allContent.push(...scanPlurStore(source.path))
    } else if (source.type === 'directory') {
      allContent.push(...scanDirectory(source.path))
    }
  }

  return clusterAndSuggest(allContent)
}

function scanPlurStore(path: string): ContentItem[] {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const data = parseYaml(raw) as { engrams?: EngramData[] }
    if (!data?.engrams) return []
    return data.engrams.map(e => ({
      source: 'plur' as const,
      domain: e.domain || e.scope || 'general',
      tags: e.tags || [],
      text: e.statement,
      path,
    }))
  } catch {
    return []
  }
}

function scanDirectory(dirPath: string): ContentItem[] {
  if (!existsSync(dirPath)) return []
  const results: ContentItem[] = []
  const textExts = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.org'])

  function walk(dir: string) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory() && !entry.startsWith('.')) {
        walk(full)
      } else if (stat.isFile() && textExts.has(extname(entry).toLowerCase()) && stat.size < 100_000) {
        try {
          const text = readFileSync(full, 'utf-8')
          const domain = extractDomainFromPath(full, dirPath)
          const tags = extractTagsFromContent(text)
          results.push({ source: 'directory', domain, tags, text: text.slice(0, 2000), path: full })
        } catch { /* skip unreadable */ }
      }
    }
  }

  walk(dirPath)
  return results
}

function extractDomainFromPath(filePath: string, basePath: string): string {
  const relative = filePath.replace(basePath, '').replace(/^\//, '')
  const parts = relative.split('/').filter(p => !p.startsWith('.'))
  // Exclude the filename (last part) — only use directory components
  const dirs = parts.slice(0, -1)
  if (dirs.length >= 2) {
    return dirs.slice(0, 2).join('/').toLowerCase().replace(/[^a-z0-9/-]/g, '')
  }
  if (dirs.length === 1) {
    return dirs[0].toLowerCase().replace(/[^a-z0-9/-]/g, '')
  }
  return 'general'
}

function extractTagsFromContent(text: string): string[] {
  const tags: string[] = []
  const hashTags = text.match(/#[a-zA-Z][a-zA-Z0-9-]*/g)
  if (hashTags) tags.push(...hashTags.map(t => t.slice(1).toLowerCase()))
  const keywords = ['trading', 'wyckoff', 'risk', 'health', 'longevity', 'ai', 'crypto', 'defi', 'data', 'privacy', 'security']
  const lower = text.toLowerCase().slice(0, 500)
  for (const kw of keywords) {
    if (lower.includes(kw)) tags.push(kw)
  }
  return [...new Set(tags)]
}

function clusterAndSuggest(content: ContentItem[]): DiscoverSuggestion[] {
  const clusters = new Map<string, ContentItem[]>()
  for (const item of content) {
    const domain = item.domain || 'general'
    if (!clusters.has(domain)) clusters.set(domain, [])
    clusters.get(domain)!.push(item)
  }

  const suggestions: DiscoverSuggestion[] = []

  for (const [domain, items] of clusters) {
    if (domain === 'general' || items.length < 3) continue

    const isPlur = items.some(i => i.source === 'plur')
    const type: DiscoverSuggestion['type'] = isPlur ? 'engram-pack' : 'zettel-collection'

    // Pricing: $0.10 per 10 items, min $0.10, max $2.00
    const price = Math.min(2.0, Math.max(0.1, Math.round(items.length / 10) * 0.1 || 0.1))

    // Top tags for description
    const tagCounts = new Map<string, number>()
    for (const item of items) {
      for (const tag of item.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
      }
    }
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t)
    const description = `${items.length} ${type === 'engram-pack' ? 'engrams' : 'notes'} on ${topTags.join(', ') || domain}`

    suggestions.push({
      domain: domain.replace(/[^a-z0-9/-]/g, ''),
      type,
      items: items.length,
      suggestedPrice: String(Math.round(price * 1_000_000)),
      description,
      sourcePaths: [...new Set(items.map(i => i.path))],
    })
  }

  return suggestions.sort((a, b) => b.items - a.items)
}
