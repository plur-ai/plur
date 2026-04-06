export interface DiscoverOptions {
  sources: Array<{ type: 'plur' | 'directory'; path: string }>
}

export interface DiscoverSuggestion {
  domain: string
  type: string
  items: number
  suggestedPrice: string
  description: string
}

export async function discover(opts: DiscoverOptions): Promise<DiscoverSuggestion[]> {
  return [] // Implemented in Task 13
}
