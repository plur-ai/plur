export interface PublishOptions {
  hub: string
  agentName: string
  title: string
  domain: string
  productType: string
  price: string
  contentPath: string
}

export async function publish(opts: PublishOptions): Promise<{ listingId: string; url: string }> {
  throw new Error('Not yet implemented — use Hub API directly for MVP')
}
