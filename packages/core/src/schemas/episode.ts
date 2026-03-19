import { z } from 'zod'

export const EpisodeSchema = z.object({
  id: z.string(),
  summary: z.string(),
  agent: z.string().optional(),
  channel: z.string().optional(),
  session_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  timestamp: z.string(),
})

export type Episode = z.infer<typeof EpisodeSchema>
