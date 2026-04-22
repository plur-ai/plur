# PLUR Enterprise Pilot — Plan v6 Amendments

> These amendments apply on top of v5. Each section identifies the v5 location to amend and provides the exact replacement text or insertion. Where a finding requires a new section, the insertion point is specified.

---

## Amendment A — Finding 2 (CRITICAL): Single-Tenant Pilot Clarification

**Location:** Replace the v5 `**Architecture:**` paragraph at the top of the plan.

**Replace:**
```
**Architecture:** Separate `plur-ai/enterprise` repository. Depends on published `@plur-ai/core` (^0.8.3) and `@plur-ai/mcp` (^0.8.3) via npm. One PostgreSQL instance with AGE (graph) + pgvector (embeddings). Multi-org schema isolation from day one. GitLab as identity provider and permission source. MCP tools filtered and permission-wrapped for multi-user safety.
```

**With:**
```
**Architecture:** Separate `plur-ai/enterprise` repository. Depends on published `@plur-ai/core` (^0.8.3) and `@plur-ai/mcp` (^0.8.3) via npm. One PostgreSQL instance with AGE (graph) + pgvector (embeddings). GitLab as identity provider and permission source. MCP tools filtered and permission-wrapped for multi-user safety.

**Deployment model:** This is a **single-tenant pilot** — one server instance serves one organization (`config.org_id`). The per-org schema isolation (`org_${orgId}` PostgreSQL schema) is forward-looking architecture for Phase 2 multi-tenancy but is NOT exercised here. Do not attempt to serve multiple orgs from one instance in v1 — the startup sync, session state, and permission resolver are all scoped to a single `config.org_id` loaded at boot.

**Phase 2 (out of scope for pilot):** Multi-org support on a shared instance requires per-request org routing, separate JWT issuers per org, and a multi-org sync scheduler. None of that is in scope here.
```

---

## Amendment B — Finding 12 (HIGH): Identity Contract

**Location:** Insert as a new section after the `## Repository Structure` section and before `## Security-First Task Order`.

**Insert entire section:**

```markdown
## Identity Contract (v6 — ALL tasks must follow)

This contract defines canonical identifiers used across the entire system. Violations cause cross-org token reuse, permission resolver mismatches, and test failures. All tasks must follow these formats exactly.

### Canonical formats

| Concept | Format | Example | Used in |
|---------|--------|---------|---------|
| **Internal userId** | `username` (bare) | `alice` | JWT `sub`, `req.user.username`, permission resolver calls |
| **Graph node ID (User)** | `${orgId}:${username}` | `acme:alice` | AGE vertex `.id`, `users` table PK, graph Cypher queries |
| **Personal scope** | `user:${orgId}:${username}` | `user:acme:alice` | Engram scope field, permission checks |
| **Group scope** | `group:${orgId}/${path}` | `group:acme/backend` | Engram scope field, permission checks |
| **Project scope** | `project:${orgId}/${path}` | `project:acme/backend/api` | Engram scope field, permission checks |
| **Org scope** | `org:${orgId}` | `org:acme` | Admin-only writes, org-wide engrams |

### AuthUser shape on `req.user`

Auth middleware (Task 10) must attach:

```typescript
interface AuthUser {
  username: string   // bare username — "alice", not "acme:alice"
  orgId: string      // "acme"
  email: string
  role: string       // advisory only (G13)
}
```

> **v5 bug:** `src/auth/types.ts` defines `AuthUser.id` as `orgId:username` (composite). This is wrong — it conflates the graph node ID with the request principal. Fix: rename `id` to `username` and store bare username.

### JWT payload

```typescript
// generateToken() call in OAuth callback
generateToken({
  userId: gitlabUser.username,   // BARE — not `${orgId}:${username}`
  email: gitlabUser.email,
  orgId: config.org_id,
  role: 'developer',
}, config.jwt_secret)
```

> **v5 bug:** The OAuth callback currently calls `generateToken({ userId: \`${config.org_id}:${gitlabUser.username}\`, ... })`. Remove the org prefix from userId.

### Permission resolver signature

```typescript
// PermissionResolver methods take bare username
resolver.canWrite('alice', 'group:acme/backend')   // correct
resolver.canRead('alice', 'user:acme:alice')        // correct

// NOT:
resolver.canWrite('acme:alice', ...)               // wrong — composite in userId param
```

### Graph node IDs

`GraphLayer.createUser(username, email)` stores the node with `id: \`${orgId}:${username}\`` internally (namespaced to prevent cross-org collision, G2). The graph's `resolveUserScopes(username)` takes bare username and prepends orgId internally. The graph already does this correctly.

### Scope construction in permission-wrapper

`enforceWritePermission` defaults to `user:${orgId}:${username}` when no scope is provided, not `user:${userId}`:

```typescript
// src/mcp/permission-wrapper.ts — correct default scope
const scope = (args.scope as string) || `user:${orgId}:${username}`
```

The `orgId` comes from `req.user.orgId`, passed into the wrapper alongside `username`.

### Task-by-task checklist

| Task | Identity contract impact |
|------|------------------------|
| Task 10 auth/types.ts | Rename `id` → `username` in `AuthUser`. Update middleware to set `req.user.username`. |
| Task 10 OAuth callback | `generateToken({ userId: gitlabUser.username, ... })` — bare, no org prefix. |
| Task 10 audit log | `audit.logAuth(gitlabUser.username, ...)` — log bare username + orgId separately. |
| Task 13 resolver tests | Test with `canWrite('alice', 'user:acme:alice')` — not `canWrite('acme:alice', ...)`. |
| Task 13b permission-wrapper | Default scope: `user:${orgId}:${username}`. Accept orgId as second param. |
| Task 11 MCP SSE route | Pass `req.user.username` and `req.user.orgId` to `EnterprisePlur` adapter. |
```

---

## Amendment C — Finding 13 (HIGH): Task Sequencing Fix

**Location:** Replace the `## Security-First Task Order` task list in v5.

**Replace the existing task list:**

```
Task 11:  HTTP server + security middleware (helmet, CORS, rate limits, error handler, graceful shutdown)
Task 12:  Session management (user-bound, limited, expiring, 503 pre-sync)
Task 13:  Permission enforcement (scope resolver, write guards, live graph check)
Task 13b: Enterprise MCP tool allowlist + write permission wrapper
```

**With:**

```
Task 11a: Express scaffold + security middleware (helmet, CORS, rate limits, error handler, health endpoint)
          — NO MCP routes yet. Tool-filter and permission-wrapper do NOT exist at this point.
Task 12:  Session management (user-bound, limited, expiring, 503 pre-sync)
Task 13:  Permission enforcement (scope resolver, write guards, live graph check)
Task 13b: Enterprise MCP tool allowlist + write permission wrapper
          — tool-filter.ts and permission-wrapper.ts NOW exist.
Task 11b: MCP server + SSE route + message route
          — imports tool-filter and permission-wrapper (they exist from 13b).
```

**Also replace the dependency graph at the bottom of the plan:**

```
Task 11a: Express + security middleware ──────────┐
Task 12:  Session management ─────────────────────┤  (parallel after 10)
Task 13:  Permission enforcement ─────────────────┤  (parallel after 5+10)
Task 13b: MCP tool allowlist + permission wrapper ┤  (requires 13)
Task 11b: MCP server + SSE + message routes ──────┘  (requires 12, 13b, and 4b merged)
```

**Also update Task 10 scope:** Task 10 handles only token generation/verification and the auth middleware factory. OAuth callback routes (`/auth/gitlab`, `/auth/callback`) remain in server.ts (Task 11a). Task 10 must NOT reference `SSEServerTransport` or any route-mounting code.

---

## Amendment D — Finding 14 (HIGH): MCP Server Implementation

**Location:** Add a new task `Task 11b` after Task 13b in the plan. The existing Task 11 becomes Task 11a (Express scaffold only — remove its MCP-related imports and session creation from `server.ts`).

### Task 11a changes (amend existing Task 11)

In the `server.ts` Step 4 code, remove the following from the imports and from `createApp`:

- Remove: `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'`
- Remove: `import { isToolAllowed, isWriteTool } from './mcp/tool-filter.js'`
- Remove: `import { enforceWritePermission } from './mcp/permission-wrapper.js'`
- Remove: `interface SessionEntry { ... }` (move to `src/middleware/session.ts` — already in Task 12)
- Remove: `const sessions = new Map<string, SessionEntry>()` (sessions owned by `SessionManager`)
- Change: `createApp` return type removes `sessions` — it returns `{ app, httpServer, pool }`
- Keep all security middleware, health endpoint, GitLab OAuth routes, webhook route, and graceful shutdown.

Add `SessionManager` to the shutdown handler:

```typescript
// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...')
  httpServer.close()
  sessionManager.destroy()   // closes all SSE sessions (from Task 12)
  await pool.end()
  process.exit(0)
}
```

### Task 11b: MCP Server + SSE Transport (NEW — insert after Task 13b)

**Goal:** Wire the actual MCP server to Express with SSE transport. This is the task that makes `GET /sse` and `POST /messages` work. Imports `tool-filter` (Task 13b) and `SessionManager` (Task 12).

**Files:**
- Amend: `src/server.ts` — add `/sse` and `/messages` routes
- Create: `src/mcp/enterprise-server.ts` — MCP `Server` instance factory
- Create: `test/mcp/enterprise-server.test.ts`

**Security requirements addressed:** Finding 14 (actual MCP server), R1 (write permission via wrapper), R4 (session ID enumeration — crypto.randomUUID), R7 (hybrid tool rate limit)

#### Step 1: Create enterprise-server.ts

```typescript
// src/mcp/enterprise-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { filterToolDefinitions } from './tool-filter.js'
import { enforceWritePermission } from './permission-wrapper.js'
import type { PermissionResolver } from '../permissions/resolver.js'
import type { AuthUser } from '../auth/types.js'

/**
 * Factory that creates one MCP Server instance per process.
 *
 * PLUR's published @plur-ai/mcp package exposes its tool definitions.
 * We import those definitions, filter to the enterprise allowlist,
 * and wrap write tools with permission enforcement.
 *
 * The Server is shared (one instance), but auth context is injected
 * per-request via the request handler closures in server.ts.
 */

// Import PLUR's tool definitions from the published @plur-ai/mcp package.
// getToolDefinitions() returns the array of { name, description, inputSchema }
// objects that would normally be registered with the MCP server.
// NOTE: This import requires @plur-ai/mcp ^0.8.3 to export getToolDefinitions().
// If the current version does not export it, use the workaround in the note below.
import { getToolDefinitions } from '@plur-ai/mcp'

export interface EnterpriseRequestContext {
  user: AuthUser
  resolver: PermissionResolver
}

/**
 * Create the enterprise MCP Server instance.
 *
 * Returns a Server with the enterprise-filtered tool set.
 * The server handles protocol framing and tool dispatch; permission
 * enforcement happens in the request handler wrapper (see createRequestHandler).
 */
export function createEnterpriseMcpServer(): Server {
  const allTools = getToolDefinitions()
  const enterpriseTools = filterToolDefinitions(allTools)

  const server = new Server(
    { name: 'plur-enterprise', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register only enterprise-allowed tools
  server.setRequestHandler('tools/list', async () => ({
    tools: enterpriseTools,
  }))

  return server
}

/**
 * Create a per-request tool call handler that enforces permissions.
 *
 * This wraps the underlying PLUR tool execution with:
 * 1. Allowlist check (belt-and-suspenders after filterToolDefinitions)
 * 2. Write permission enforcement via PermissionResolver
 * 3. Tool execution via the underlying PLUR engine
 *
 * Called from the POST /messages route after session lookup.
 */
export function createPermissionEnforcingHandler(
  user: AuthUser,
  resolver: PermissionResolver,
  // The underlying tool executor from @plur-ai/mcp (scoped to this user's store)
  executeToolFn: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  return async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    // Belt-and-suspenders: re-check allowlist at dispatch time (not just at registration)
    const { isToolAllowed } = await import('./tool-filter.js')
    if (!isToolAllowed(toolName)) {
      throw Object.assign(new Error(`Tool not available in enterprise mode: ${toolName}`), {
        code: -32601,  // MCP MethodNotFound
      })
    }

    // Enforce write permissions (mutates args for plur_ingest caps)
    await enforceWritePermission(toolName, args, user.username, resolver)

    // Execute via the PLUR engine
    return executeToolFn(toolName, args)
  }
}

/**
 * NOTE: If @plur-ai/mcp does not yet export getToolDefinitions():
 *
 * Define the tool list manually using the allowlist from tool-filter.ts.
 * This is a compatibility shim until the core package exports tool defs.
 *
 * export function getToolDefinitions() {
 *   // Minimal shim — descriptions/schemas pulled from @plur-ai/mcp source
 *   return ENTERPRISE_ALLOWED_TOOLS_ARRAY  // defined inline here
 * }
 */
```

#### Step 2: Add SSE and message routes to server.ts (Task 11b addition)

Add the following to `createApp()` in `src/server.ts`, **after** all other route registrations and **before** the global error handler. This code requires `SessionManager` (from Task 12) and `createEnterpriseMcpServer` (above):

```typescript
// src/server.ts — Task 11b additions to createApp()

// Add to imports at top of file:
// import { Server } from '@modelcontextprotocol/sdk/server/index.js'
// import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
// import { createEnterpriseMcpServer, createPermissionEnforcingHandler } from './mcp/enterprise-server.js'
// import { SessionManager } from './middleware/session.js'
// import { PermissionResolver } from './permissions/resolver.js'
// import { isToolAllowed } from './mcp/tool-filter.js'
// import { enforceWritePermission } from './mcp/permission-wrapper.js'

// Add to createApp() — create shared instances:
const mcpServer = createEnterpriseMcpServer()
const sessionManager = new SessionManager()
const graph = new GraphLayer(pool, config.org_id)   // or reuse from GitLab section
const permissionResolver = new PermissionResolver(graph)

// Session expiry (30 days — matches JWT expiry)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

// --- MCP SSE route ---
// GET /sse — initiates an SSE connection. Creates MCP transport and session.
// Authenticated. One persistent connection per client.
app.get('/sse', requireAuth, async (req, res) => {
  const user = (req as any).user as AuthUser

  // Create SSE transport bound to this HTTP response
  const transport = new SSEServerTransport('/messages', res)

  // Register session (enforces per-user + global limits — finding 10, R4)
  let sessionId: string
  try {
    sessionId = sessionManager.create(
      transport,
      user.username,
      user.orgId,
      new Date(Date.now() + SESSION_TTL_MS),
    )
  } catch (err) {
    res.status(503).json({ error: (err as Error).message })
    return
  }

  // Respond with the session ID in a custom header so the client knows
  // which session ID to include in POST /messages
  res.setHeader('X-Session-Id', sessionId)

  // Connect the MCP Server to this transport.
  // mcpServer.connect() registers this transport as the active channel.
  // From this point, the MCP protocol runs over SSE.
  await mcpServer.connect(transport)

  // Log session creation
  logger.info({ userId: user.username, sessionId }, 'MCP SSE session opened')

  // Cleanup on client disconnect
  res.on('close', () => {
    sessionManager.close(sessionId)
    logger.info({ userId: user.username, sessionId }, 'MCP SSE session closed')
  })
})

// --- MCP message route ---
// POST /messages — receives JSON-RPC messages from the MCP client.
// The client includes the session ID (from X-Session-Id header or ?sessionId= query param).
app.post('/messages', requireAuth, messageRateLimit, async (req, res) => {
  const user = (req as any).user as AuthUser

  // Get session ID from query param (MCP SDK convention) or header
  const sessionId = (req.query.sessionId as string) || req.headers['x-session-id'] as string
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId' })
    return
  }

  // Validate session exists and belongs to this user (R4 — no enumeration)
  const session = sessionManager.get(sessionId, user.username)
  if (!session) {
    // Deliberate: same response for missing AND wrong-user (R4)
    res.status(404).json({ error: 'Session not found' })
    return
  }

  // Validate session org matches token org (belt-and-suspenders)
  if (session.orgId !== user.orgId) {
    logger.warn({ userId: user.username, sessionOrgId: session.orgId, tokenOrgId: user.orgId }, 'Org mismatch on message route')
    res.status(403).json({ error: 'Session org mismatch' })
    return
  }

  // Intercept tool/call requests to enforce permissions before dispatch.
  // The MCP SDK's handlePostMessage() will invoke mcpServer's request handlers.
  // We pre-validate permission here for write tools; the handler in
  // enterprise-server.ts also re-validates (defence in depth).
  const body = req.body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
  if (body.method === 'tools/call' && body.params?.name) {
    const toolName = body.params.name
    const toolArgs = body.params.arguments ?? {}

    try {
      await enforceWritePermission(toolName, toolArgs, user.username, permissionResolver)
      // Mutated args (e.g., plur_ingest caps) are written back to body.params.arguments
      body.params.arguments = toolArgs
    } catch (err) {
      res.status(403).json({
        jsonrpc: '2.0',
        id: (req.body as any).id,
        error: { code: -32603, message: (err as Error).message },
      })
      return
    }
  }

  // Forward the message to the transport for protocol handling
  try {
    await session.transport.handlePostMessage(req, res, body)
  } catch (err) {
    logger.error({ err: (err as Error).message, sessionId }, 'MCP message handler error')
    if (!res.headersSent) {
      res.status(500).json({ error: 'Message handling failed' })
    }
  }
})

// Export sessionManager for shutdown handler
// In shutdown():
//   sessionManager.destroy()
```

#### Step 3: Update createApp return value

```typescript
// src/server.ts — updated return
return { app, httpServer, pool, sessionManager }
```

#### Step 4: Update graceful shutdown in server.ts

```typescript
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...')
  httpServer.close()
  sessionManager.destroy()  // closes all active SSE connections
  await pool.end()
  process.exit(0)
}
```

#### Step 5: Test

```typescript
// test/mcp/enterprise-server.test.ts
import { describe, it, expect } from 'vitest'
import { createEnterpriseMcpServer } from '../../src/mcp/enterprise-server.js'

describe('createEnterpriseMcpServer', () => {
  it('creates a Server instance', () => {
    const server = createEnterpriseMcpServer()
    expect(server).toBeDefined()
    expect(typeof server.connect).toBe('function')
  })
})
```

```bash
npx vitest run test/mcp/enterprise-server.test.ts
```

#### Step 6: Commit

```bash
git add src/mcp/enterprise-server.ts src/server.ts test/mcp/enterprise-server.test.ts
git commit -m "feat: MCP SSE transport + /sse + /messages routes with permission enforcement"
```

---

## Amendment E — Finding 17 (HIGH): First-Login Sync Scope Fix

**Location:** Replace the `ensureUserSynced` implementation in Task 8 (around line 3846 in v5).

**Replace the existing `ensureUserSynced` function with:**

```typescript
// src/gitlab/sync.ts

/**
 * First-login sync — called from OAuth callback.
 *
 * SECURITY: Regular developers cannot enumerate all group members.
 * Only sync the authenticated user's own memberships using their token.
 * Full org sync (all members, all groups) requires admin token and runs
 * on a separate schedule (see Task 16b / GITLAB_SYNC_INTERVAL_MINUTES).
 *
 * Addresses B2 (ensureUserSynced defined).
 * Addresses Finding 17 (scoped sync only — no full org enumeration on user token).
 * Addresses G12 (async — returns immediately, sync runs in background).
 *
 * What this does:
 * 1. Upsert the user row in the relational users table
 * 2. Create/update the user node in the AGE graph
 * 3. Fetch the user's own group memberships (GET /groups?min_access_level=10)
 * 4. Fetch the user's own project memberships (GET /projects?membership=true)
 * 5. Create those group/project nodes and membership edges in the graph
 *
 * What this does NOT do:
 * - Does NOT enumerate other group members (requires admin token)
 * - Does NOT call fullSync() (that's the periodic admin cron)
 */
export async function ensureUserSynced(
  gitlabUser: GitLabUser,
  gitlabClient: GitLabClient,
  graph: GraphLayer,
  orgId: string,
  pool: pg.Pool,
  schema: string,
): Promise<void> {
  // Upsert user in relational table
  await pool.query(
    `INSERT INTO "${schema}".users (id, email, display_name, gitlab_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = $2, display_name = $3, gitlab_id = $4, updated_at = NOW()`,
    [`${orgId}:${gitlabUser.username}`, gitlabUser.email, gitlabUser.name, gitlabUser.id]
  )

  // Upsert user node in graph
  await graph.createUser(gitlabUser.username, gitlabUser.email)

  // Run membership sync in background (G12 — don't block OAuth callback)
  syncUserMemberships(gitlabUser.username, gitlabClient, graph, orgId).catch((err) => {
    // Log but do not fail login — user will have limited scope until next sync
    console.error({ err: (err as Error).message, username: gitlabUser.username }, 'User membership sync failed')
  })
}

/**
 * Sync this user's own group and project memberships.
 *
 * Uses the user's OAuth token, so only accessible resources are returned —
 * no admin privilege required.
 */
async function syncUserMemberships(
  username: string,
  gitlabClient: GitLabClient,
  graph: GraphLayer,
  orgId: string,
): Promise<void> {
  // Fetch groups the user has at least Guest access to
  // GET /api/v4/groups?min_access_level=10
  const groups = await gitlabClient.getUserGroups({ minAccessLevel: 10 })
  for (const group of groups) {
    // Upsert group node
    await graph.createGroup(group.full_path, group.name)
    // Add membership edge
    await graph.addMembership(username, group.full_path, group.access_level)
  }

  // Fetch projects the user is a member of
  // GET /api/v4/projects?membership=true
  const projects = await gitlabClient.getUserProjects({ membership: true })
  for (const project of projects) {
    // Upsert project node (associate with namespace group if present)
    await graph.createProject(project.path_with_namespace, project.name)
    // Link project to its parent group if the group is already in the graph
    if (project.namespace?.kind === 'group') {
      await graph.createProjectEdge(project.namespace.full_path, project.path_with_namespace)
    }
  }
}
```

**Also add to GitLabClient (Task 7) — these two methods are required:**

```typescript
// src/gitlab/client.ts — add to GitLabClient class

/** Fetch groups the authenticated user belongs to. */
async getUserGroups(opts: { minAccessLevel?: number } = {}): Promise<GitLabGroup[]> {
  const params = new URLSearchParams()
  if (opts.minAccessLevel) params.set('min_access_level', String(opts.minAccessLevel))
  params.set('per_page', '100')
  return this.paginatedGet<GitLabGroup>(`/groups?${params}`, 50)
}

/** Fetch projects the authenticated user is a member of. */
async getUserProjects(opts: { membership?: boolean } = {}): Promise<GitLabProject[]> {
  const params = new URLSearchParams()
  if (opts.membership) params.set('membership', 'true')
  params.set('per_page', '100')
  return this.paginatedGet<GitLabProject>(`/projects?${params}`, 50)
}
```

---

## Amendment F — Finding 18 (HIGH): Operational Gaps — Periodic Sync + Metrics

**Location:** Add a new `Task 16b` after Task 16 (Deploy). Also update the deploy section's mention of `GITLAB_SYNC_INTERVAL_MINUTES` to explain it is wired.

### Task 16b: Operational Monitoring + Periodic Sync (NEW)

**Goal:** Wire `GITLAB_SYNC_INTERVAL_MINUTES` to an actual `setInterval`, add pino-based metrics, expose `/admin/metrics`, and flag stale-sync users.

**Files:**
- Amend: `src/server.ts` — add `setInterval` for periodic sync
- Create: `src/logging/metrics.ts` — request counter, latency histogram, error rate
- Amend: `src/admin/routes.ts` — add `/admin/metrics` endpoint

**Security requirements addressed:** Finding 18 (GITLAB_SYNC_INTERVAL_MINUTES unused, no monitoring)

#### Step 1: Create metrics.ts

```typescript
// src/logging/metrics.ts
import type { Logger } from 'pino'

/**
 * In-process metrics using simple counters and a ring buffer for p99 latency.
 * Not a replacement for Prometheus — sufficient for a 10-user pilot.
 * Expose via /admin/metrics (behind admin auth).
 */
export class Metrics {
  private requestCount = 0
  private errorCount = 0
  private latencySamples: number[] = []
  private readonly maxSamples = 1000

  recordRequest(latencyMs: number, isError: boolean): void {
    this.requestCount++
    if (isError) this.errorCount++
    this.latencySamples.push(latencyMs)
    if (this.latencySamples.length > this.maxSamples) {
      this.latencySamples.shift()
    }
  }

  getP99LatencyMs(): number {
    if (this.latencySamples.length === 0) return 0
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * 0.99)
    return sorted[idx] ?? sorted[sorted.length - 1]
  }

  snapshot() {
    return {
      request_count: this.requestCount,
      error_count: this.errorCount,
      error_rate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      p99_latency_ms: this.getP99LatencyMs(),
      sample_size: this.latencySamples.length,
    }
  }
}
```

#### Step 2: Add metrics middleware to server.ts

```typescript
// src/server.ts — add after pinoHttp middleware
const metrics = new Metrics()

app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    metrics.recordRequest(Date.now() - start, res.statusCode >= 500)
  })
  next()
})
```

#### Step 3: Wire periodic sync in server.ts

Add inside the `if (config.gitlab_enabled)` block, after the initial sync completes:

```typescript
// src/server.ts — inside gitlab_enabled block, after firstSyncComplete = true

// Periodic full sync — wires GITLAB_SYNC_INTERVAL_MINUTES (Finding 18)
// Requires admin service account token stored in GITLAB_ADMIN_TOKEN.
// If no admin token, periodic sync is skipped (webhooks remain active).
if (process.env.GITLAB_ADMIN_TOKEN && config.gitlab_sync_interval_minutes > 0) {
  const syncIntervalMs = config.gitlab_sync_interval_minutes * 60 * 1000
  const periodicSync = setInterval(async () => {
    try {
      const adminClient = new GitLabClient(
        config.gitlab_url!,
        process.env.GITLAB_ADMIN_TOKEN!,
        { allowInsecure: config.node_env === 'development' }
      )
      const sync = new GitLabSync(adminClient, graph, config.org_id)
      const report = await sync.fullSync()
      logger.info(report, `Periodic GitLab sync complete (interval: ${config.gitlab_sync_interval_minutes}min)`)

      // Invalidate all permission caches after sync (G4)
      permissionResolver.invalidateAll()
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Periodic GitLab sync failed')
    }
  }, syncIntervalMs)

  // Clean up on shutdown
  process.on('SIGTERM', () => clearInterval(periodicSync))
  process.on('SIGINT', () => clearInterval(periodicSync))

  logger.info({ interval_minutes: config.gitlab_sync_interval_minutes }, 'Periodic GitLab sync scheduled')
} else {
  logger.warn('GITLAB_ADMIN_TOKEN not set — periodic sync disabled. Relying on webhooks only.')
}
```

#### Step 4: Add /admin/metrics route to admin/routes.ts

```typescript
// src/admin/routes.ts — add metrics endpoint
import type { Metrics } from '../logging/metrics.js'
import type { SessionManager } from '../middleware/session.js'
import type { pg } from 'pg'

export function createAdminRouter(
  pool: pg.Pool,
  metrics: Metrics,
  sessionManager: SessionManager,
  config: EnterpriseConfig,
) {
  const router = express.Router()

  // GET /admin/metrics — pino-structured metrics snapshot (behind requireAdmin)
  router.get('/metrics', async (req, res) => {
    const snap = metrics.snapshot()
    const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false)

    res.json({
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      ...snap,
      sessions: {
        active: sessionManager.size,
      },
      database: {
        connected: dbOk,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      },
      sync: {
        interval_minutes: config.gitlab_sync_interval_minutes,
        // Stale-user detection: users not synced in > 2x sync interval
        stale_threshold_minutes: config.gitlab_sync_interval_minutes * 2,
      },
    })
  })

  return router
}
```

#### Step 5: Stale permission detection query

Add to admin routes (informational — does not block requests):

```typescript
// GET /admin/sync-health — users not synced recently
router.get('/sync-health', async (req, res) => {
  const staleThreshold = config.gitlab_sync_interval_minutes * 2
  const result = await pool.query(
    `SELECT id, email, updated_at,
            EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS minutes_since_sync
     FROM "${schema}".users
     WHERE updated_at < NOW() - INTERVAL '${staleThreshold} minutes'
     ORDER BY updated_at ASC`,
  )
  res.json({
    stale_users: result.rows,
    threshold_minutes: staleThreshold,
    count: result.rows.length,
  })
})
```

> **Note:** The `${staleThreshold}` interpolation above is safe because `staleThreshold` is a number derived from config (integer minutes from env), not from user input. Add a runtime assertion: `if (!Number.isInteger(staleThreshold) || staleThreshold < 0) throw new Error('Invalid stale threshold')`.

#### Step 6: Commit

```bash
git add src/logging/metrics.ts src/server.ts src/admin/routes.ts
git commit -m "feat: periodic GitLab sync, pino metrics, /admin/metrics, stale sync detection"
```

---

## Amendment G — Finding 19 (HIGH): Build/Deploy Fix

**Location:** Replace `Step 1: Create deploy.sh` in Task 16.

**Replace:**

```bash
# Install deps
npm ci --production

# Build
npm run build
```

**With:**

```bash
# Two-stage build: full install (includes devDeps) → compile → prune
npm ci                     # full install — devDeps needed for tsup/tsc
npm run build              # compile TypeScript (requires tsup in devDeps)
npm prune --production     # remove devDeps after build artifact is on disk
```

**Also add a Dockerfile for CI builds (insert before Step 1 as a new sub-step):**

```dockerfile
# infrastructure/Dockerfile
# Multi-stage build — avoids shipping devDeps to production image

# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci                  # full install including devDeps
COPY . .
RUN npm run build           # compile with tsup

# Stage 2: runtime
FROM node:20-alpine AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --production     # production deps only
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Also update the `package.json` scripts note in Task 1:** Ensure `tsup` and `typescript` are in `devDependencies`, not `dependencies`. The deploy script's `npm prune --production` will remove them after build. Add a CI check:

```bash
# Verify build artifact exists before pruning
npm run build && ls -la dist/index.js || (echo "Build failed" && exit 1)
npm prune --production
```

---

## Amendment H — Consolidated Corrected Task Order

The revised task order incorporating all sequencing fixes (Amendment C) and new tasks (Amendments D, F):

```
Task 0:   Infrastructure (Docker Compose + DO + GitLab setup instructions)
Task 1:   Repo scaffold (pinned deps, complete config with GitLab, gitlab_enabled flag)
Task 2:   Input validation + path normalization + Zod response schemas
Task 3:   Structured logging + audit log writer + PII pseudonymization
Task 4:   PostgresStore (CRUD + tsvector search + pgvector) with shared pool, schema-scoped
Task 4b:  Plur core DI — PR adding store injection (show exact diff)
Task 5:   AGE graph layer — ALL methods, parameterized, per-org graphs, namespaced user IDs
Task 6:   TenantManager + migrate.ts CLI + SQL migration files
Task 7:   GitLab API client (HTTPS default, pagination limit, Zod response validation)
          + getUserGroups() and getUserProjects() methods (Amendment E)
Task 7b:  GitLab OAuth2 with PKCE + encrypted token storage + refresh flow
Task 8:   GitLab org sync + ensureUserSynced() (user-scoped only) + sync CLI
          (AMENDED: ensureUserSynced does NOT call fullSync — see Amendment E)
Task 9:   GitLab webhook handler (timingSafeEqual, replay protection, orgId from config)
Task 10:  Auth — token.ts + middleware.ts + roles.ts + types.ts
          (AMENDED: JWT userId is bare username, NOT orgId:username — see Amendment B)
          (AMENDED: OAuth callback routes stay in server.ts, not here)
Task 11a: Express scaffold + security middleware (helmet, CORS, rate limits, health, OAuth routes)
          (AMENDED: NO MCP imports — tool-filter and permission-wrapper don't exist yet)
Task 12:  Session management (user-bound, limited, expiring, enumeration-resistant)
Task 13:  Permission enforcement (scope resolver, write guards, live graph check)
Task 13b: Enterprise MCP tool allowlist + write permission wrapper
          (tool-filter.ts and permission-wrapper.ts created here)
Task 11b: MCP Server + SSE transport + /sse + /messages routes
          (AMENDED: NEW task — actual MCP integration, imports 13b output)
Task 14:  Security test suite
Task 15:  E2E integration tests
Task 16:  DO droplet deployment + GITLAB-SETUP.md (AMENDED: two-stage build)
Task 16b: Operational monitoring — periodic sync, metrics, /admin/metrics (NEW)
```

### Updated dependency graph

```
Task 0 ──────────────────────────────────────────────────────────────────────┐
Task 1 ──────────────────────────────────────────────────────────────────────┤
                                                                              ▼
Task 2 (validation) ─────────────────────────────────────────────────────────┤ (used by all)
Task 3 (logging) ────────────────────────────────────────────────────────────┤ (used by all)
                                                                              ▼
Task 4 (PostgresStore) ──────────────────────────────────────────────────────┤
Task 4b (Plur core DI PR) ───────────────────────────────────────────────────┤ (merge before 11b)
Task 5 (AGE graph) ──────────────────────────────────────────────────────────┤
Task 6 (TenantManager + migrations) ─────────────────────────────────────────┤
                                                                              ▼
Task 7 (GitLab client) ──────────────────────────────────────────────────────┤
Task 7b (GitLab OAuth + token store) ────────────────────────────────────────┤ (parallel with 7)
Task 8 (sync + ensureUserSynced) ────────────────────────────────────────────┤ (requires 5+7)
Task 9 (webhooks) ───────────────────────────────────────────────────────────┤ (requires 5+7)
                                                                              ▼
Task 10 (token + middleware — no OAuth routes) ───────────────────────────────┤
Task 11a (Express + security + OAuth routes) ────────────────────────────────┤ (parallel with 10)
Task 12 (SessionManager) ────────────────────────────────────────────────────┤ (parallel)
Task 13 (PermissionResolver) ────────────────────────────────────────────────┤ (parallel)
Task 13b (tool-filter + permission-wrapper) ──────────────────────────────────┤ (requires 13)
Task 11b (MCP server + /sse + /messages) ────────────────────────────────────┤ (requires 12, 13b, 4b)
                                                                              ▼
Task 14 (security tests) ────────────────────────────────────────────────────┤
Task 15 (E2E tests) ─────────────────────────────────────────────────────────┤
Task 16 (deploy) ────────────────────────────────────────────────────────────┤
Task 16b (monitoring + periodic sync) ───────────────────────────────────────┘
```

---

## Summary of v5 → v6 Changes

| Finding | Severity | Amendment | What changes |
|---------|----------|-----------|-------------|
| Finding 2 | CRITICAL | A | Plan header: single-tenant pilot, no multi-org in v1 |
| Finding 12 | HIGH | B | New "Identity Contract" section: bare username in JWT, `req.user.username`, correct scope format |
| Finding 13 | HIGH | C | Task 11 split into 11a/11b; 13b moved before 11b; Task 10 loses OAuth routes |
| Finding 14 | HIGH | D | New Task 11b: `enterprise-server.ts`, `/sse` route, `/messages` route with permission enforcement |
| Finding 17 | HIGH | E | `ensureUserSynced` rewritten: user-scoped only, no `fullSync()` on user token |
| Finding 18 | HIGH | F | New Task 16b: `setInterval` for periodic sync, `Metrics` class, `/admin/metrics` route |
| Finding 19 | HIGH | G | `deploy.sh` two-stage build; Dockerfile multi-stage; devDep placement |

---

## Codex Audit Round 4 — Amendments (Findings CA5–CA16)

These amendments were added after a Codex security audit of the plan code. They cover six additional findings that the earlier review rounds missed. Add these to the implementation checklist and update the resolution matrix accordingly.

---

## Amendment CA5 — Finding CA5 (CRITICAL): 503 bypass on sync failure

**Summary:** In `createApp()`, the startup sync `catch` block sets `firstSyncComplete = true` even when `fullSync()` throws. This converts the 503 safety gate into a no-op — a server that fails to load permissions silently starts accepting requests with a stale or empty graph.

**Tasks modified:** Task 11 (`src/server.ts`) and Task 10 (`src/auth/middleware.ts`)

### Old code

In `src/server.ts`, the startup IIFE (around the "Initial sync on startup" comment):

```typescript
;(async () => {
  try {
    // ...
    firstSyncComplete = true
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Initial sync failed — server will return 503')
    // Don't crash — allow health checks. Operator can fix and trigger manual sync.
    firstSyncComplete = true // Allow operation even if sync fails    ← BUG
  }
})()
```

### New code

Replace the startup IIFE and add a `syncFailed` flag alongside `firstSyncComplete`:

```typescript
// In createApp(), alongside `let firstSyncComplete = false`:
let syncFailed = false
const MAX_SYNC_RETRIES = 3
const SYNC_RETRY_DELAY_MS = 15_000

// Initial sync on startup — with retry and hard failure gate
;(async () => {
  for (let attempt = 1; attempt <= MAX_SYNC_RETRIES; attempt++) {
    try {
      const tenant = new TenantManager(pool)
      await tenant.createOrg(config.org_id)
      await graph.initialize()

      if (process.env.GITLAB_ADMIN_TOKEN) {
        const adminClient = new GitLabClient(
          config.gitlab_url!,
          process.env.GITLAB_ADMIN_TOKEN,
          { allowInsecure: config.node_env === 'development' }
        )
        const sync = new GitLabSync(adminClient, graph, config.org_id)
        const report = await sync.fullSync()
        logger.info(report, 'Initial GitLab sync complete')
      }

      // Only mark complete on actual success
      firstSyncComplete = true
      syncFailed = false
      return
    } catch (err) {
      logger.error(
        { err: (err as Error).message, attempt, maxRetries: MAX_SYNC_RETRIES },
        'Initial sync failed'
      )
      if (attempt < MAX_SYNC_RETRIES) {
        logger.warn({ retryIn: SYNC_RETRY_DELAY_MS }, 'Retrying sync...')
        await new Promise(resolve => setTimeout(resolve, SYNC_RETRY_DELAY_MS))
      }
    }
  }

  // All retries exhausted — lock in degraded mode
  syncFailed = true
  logger.fatal(
    { retries: MAX_SYNC_RETRIES },
    'GitLab sync failed after all retries — server locked in degraded mode. Contact admin.'
  )
})()
```

Update `createAuthMiddleware` signature and body in `src/auth/middleware.ts`:

```typescript
// OLD signature:
export function createAuthMiddleware(config: EnterpriseConfig, syncCompleted: () => boolean)

// NEW signature:
export function createAuthMiddleware(
  config: EnterpriseConfig,
  syncCompleted: () => boolean,
  syncFailed: () => boolean,
) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (syncFailed()) {
      res.status(503)
        .set('Retry-After', '60')
        .json({ error: 'GitLab sync failed — contact admin', code: 'SYNC_FAILED' })
      return
    }
    if (!syncCompleted()) {
      res.status(503)
        .set('Retry-After', '30')
        .json({ error: 'Server starting — GitLab sync in progress', code: 'SYNC_PENDING', retry_after: 30 })
      return
    }
    // ... rest of auth logic unchanged
  }
}
```

Update the call site:

```typescript
// OLD:
const requireAuth = createAuthMiddleware(config, () => firstSyncComplete)

// NEW:
const requireAuth = createAuthMiddleware(config, () => firstSyncComplete, () => syncFailed)
```

### New test cases — add to `test/security/failure-modes.test.ts`

```typescript
describe('503 gate — sync failure modes', () => {
  it('returns 503 SYNC_PENDING while sync is running', () => {
    const mw = createAuthMiddleware(config, () => false, () => false)
    const { req, res, next } = mockExpressContext({ authorization: 'Bearer valid-token' })
    mw(req, res, next)
    expect(res.statusCode).toBe(503)
    expect(res.body.code).toBe('SYNC_PENDING')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 503 SYNC_FAILED with distinct message after all retries exhausted', () => {
    const mw = createAuthMiddleware(config, () => false, () => true)
    const { req, res, next } = mockExpressContext({ authorization: 'Bearer valid-token' })
    mw(req, res, next)
    expect(res.statusCode).toBe(503)
    expect(res.body.code).toBe('SYNC_FAILED')
    expect(res.body.error).toContain('contact admin')
    expect(next).not.toHaveBeenCalled()
  })

  it('never sets firstSyncComplete=true when fullSync() throws every attempt', async () => {
    // After MAX_SYNC_RETRIES failures: syncFailed must be true, firstSyncComplete must be false
    let sc = false
    let sf = false
    // Simulate the startup IIFE with a mock fullSync that always rejects
    // Verify final state: sc=false, sf=true
  })
})
```

---

## Amendment CA6 — Finding CA6 (CRITICAL): OAuth CSRF / session swap + wrong content-type for token exchange

**Summary:** Two independent bugs:
1. The OAuth `state` is stored server-side but not bound to the originating browser session. Any valid in-flight `state` can be replayed from a different browser tab or machine (CSRF / session swap).
2. `exchangeCode()` and `refreshToken()` in `src/gitlab/oauth.ts` send `Content-Type: application/json` to GitLab's `/oauth/token` endpoint, which requires `application/x-www-form-urlencoded`.

**Tasks modified:**
- Task 7b (`src/gitlab/oauth.ts` — both methods)
- Task 11a (`src/server.ts` — `/auth/gitlab` and `/auth/callback`)
- Task 6 (`src/db/migrations/005-oauth-pending.sql` — add `cookie_nonce_hash` column)

### Fix 1: Token exchange content-type (Task 7b)

In `src/gitlab/oauth.ts`, replace both methods:

```typescript
// OLD — uses application/json (rejected by GitLab):
async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
  const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: ..., code, ... }),
  })
  // ...
}

// NEW — uses application/x-www-form-urlencoded:
async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: this.config.clientId,
    client_secret: this.config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: this.config.redirectUri,
    code_verifier: codeVerifier,
  })
  const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`GitLab token exchange failed: ${res.status}`)
  }
  return res.json() as Promise<OAuthTokenResponse>
}

// OLD refreshToken — same problem:
async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: ..., refresh_token: refreshToken, ... }),
  })
  // ...
}

// NEW refreshToken:
async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    client_id: this.config.clientId,
    client_secret: this.config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: this.config.redirectUri,
  })
  const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`GitLab token refresh failed: ${res.status}`)
  }
  return res.json() as Promise<OAuthTokenResponse>
}
```

### Fix 2: Cookie nonce binding (Tasks 11a + 6)

**Update `005-oauth-pending.sql`** to add the nonce column:

```sql
-- src/db/migrations/005-oauth-pending.sql
CREATE TABLE IF NOT EXISTS oauth_pending (
  state              TEXT PRIMARY KEY,
  code_verifier      TEXT NOT NULL,
  cookie_nonce_hash  TEXT NOT NULL,   -- SHA-256(httpOnly cookie nonce) — binds state to browser
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS oauth_pending_expires_idx ON oauth_pending (expires_at);
```

**Add `cookie-parser` dependency** in `package.json` and mount before routes in `src/server.ts`:

```json
"cookie-parser": "1.4.6",
"@types/cookie-parser": "1.4.7"
```

```typescript
// src/server.ts — add import and mount before all routes
import cookieParser from 'cookie-parser'
// ...
app.use(cookieParser())
```

**Update `/auth/gitlab` route** in `src/server.ts`:

```typescript
// OLD:
app.get('/auth/gitlab', async (req, res) => {
  // ...cap and cleanup checks...
  const { url, state, codeVerifier } = gitlabOAuth.getAuthorizationUrl()
  await pool.query(
    `INSERT INTO "${schema}".oauth_pending (state, code_verifier) VALUES ($1, $2)`,
    [state, codeVerifier]
  )
  res.redirect(url)
})

// NEW:
app.get('/auth/gitlab', async (req, res) => {
  const stateCount = await pool.query(`SELECT count(*)::int AS c FROM "${schema}".oauth_pending`)
  if (stateCount.rows[0].c >= 1000) {
    res.status(429).json({ error: 'Too many pending auth flows' })
    return
  }
  await pool.query(`DELETE FROM "${schema}".oauth_pending WHERE expires_at < NOW()`)

  const { url, state, codeVerifier } = gitlabOAuth.getAuthorizationUrl()

  // Generate a random nonce, store its hash server-side, send raw nonce in httpOnly cookie
  const nonce = crypto.randomBytes(32).toString('hex')
  const nonceHash = crypto.createHash('sha256').update(nonce).digest('hex')

  await pool.query(
    `INSERT INTO "${schema}".oauth_pending (state, code_verifier, cookie_nonce_hash) VALUES ($1, $2, $3)`,
    [state, codeVerifier, nonceHash]
  )

  res.cookie('oauth_nonce', nonce, {
    httpOnly: true,
    secure: config.node_env !== 'development',
    sameSite: 'strict',
    maxAge: 5 * 60 * 1000,   // 5 min — matches oauth_pending TTL
    path: '/auth/callback',
  })
  res.redirect(url)
})
```

**Update `/auth/callback` route** in `src/server.ts`:

```typescript
// OLD:
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query as { code: string; state: string }
  try {
    const pending = await pool.query(
      `DELETE FROM "${schema}".oauth_pending WHERE state = $1 AND expires_at > NOW() RETURNING code_verifier`,
      [state]
    )
    if (pending.rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired state' })
      return
    }
    const codeVerifier = pending.rows[0].code_verifier
    // ...
  }
})

// NEW:
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query as { code: string; state: string }
  try {
    const cookieNonce = req.cookies?.oauth_nonce
    if (!cookieNonce) {
      res.status(400).json({ error: 'Missing auth session cookie' })
      return
    }
    const cookieNonceHash = crypto.createHash('sha256').update(cookieNonce).digest('hex')

    // Verify state AND cookie nonce — prevents CSRF / session swap
    const pending = await pool.query(
      `DELETE FROM "${schema}".oauth_pending
       WHERE state = $1 AND cookie_nonce_hash = $2 AND expires_at > NOW()
       RETURNING code_verifier`,
      [state, cookieNonceHash]
    )
    if (pending.rows.length === 0) {
      res.status(400).json({ error: 'Invalid or expired state' })
      return
    }
    res.clearCookie('oauth_nonce', { path: '/auth/callback' })
    const codeVerifier = pending.rows[0].code_verifier
    // ...rest of callback unchanged...
  }
})
```

### New test cases

Add to `test/gitlab/oauth.test.ts`:

```typescript
it('uses application/x-www-form-urlencoded for token exchange', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_in: 7200, created_at: 0, scope: 'read_api' }),
  } as any)
  await oauth.exchangeCode('mycode', 'myverifier')
  const [, options] = fetchSpy.mock.calls[0]
  expect((options as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
  const body = (options as RequestInit).body as string
  expect(body).toContain('grant_type=authorization_code')
  expect(body).toContain('code=mycode')
  fetchSpy.mockRestore()
})

it('uses application/x-www-form-urlencoded for token refresh', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ access_token: 'new', refresh_token: 'newref', token_type: 'Bearer', expires_in: 7200, created_at: 0, scope: 'read_api' }),
  } as any)
  await oauth.refreshToken('old-refresh')
  const [, options] = fetchSpy.mock.calls[0]
  expect((options as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
  fetchSpy.mockRestore()
})
```

Add to `test/security/auth-bypass.test.ts`:

```typescript
describe('OAuth CSRF protection', () => {
  it('rejects callback with valid state but wrong nonce cookie', async () => {
    // Insert pending state bound to nonce 'correct-nonce'
    // Call /auth/callback with correct state but cookie for a different nonce
    // Expect 400
  })

  it('rejects callback with no nonce cookie', async () => {
    // Call /auth/callback with no oauth_nonce cookie
    // Expect 400 'Missing auth session cookie'
  })

  it('accepts callback when state and cookie nonce match', async () => {
    // Full happy path — expect 200 with token
  })
})
```

---

## Amendment CA7 — Finding CA7 (CRITICAL): Webhook dedup record inserted before graph mutation

**Summary:** `isDuplicate()` inserts the dedup hash into `processed_webhooks` before the graph mutation runs. A crash or thrown error after the insert but before the mutation permanently suppresses that webhook — the dedup record exists but the graph was never updated. The event is silently un-retryable.

**Task modified:** Task 9 (`src/gitlab/webhook.ts`)

### Old code

```typescript
// src/gitlab/webhook.ts

private async isDuplicate(event: WebhookEvent): Promise<boolean> {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')
  const result = await this.pool.query(
    `INSERT INTO "${this.schema}".processed_webhooks (payload_hash, event_name)
     VALUES ($1, $2)
     ON CONFLICT (payload_hash) DO NOTHING`,
    [payloadHash, event.event_name]
  )
  return (result.rowCount ?? 0) === 0   // 0 rows = duplicate
}

async handle(event: WebhookEvent): Promise<void> {
  const knownEvents = [/* ... */]
  if (!knownEvents.includes(event.event_name)) return

  if (await this.isDuplicate(event)) return  // insert happens HERE

  switch (event.event_name) {                // mutation happens AFTER — crash window exists
    case 'user_add_to_group': await this.handleMemberAdd(event); break
    // ...
  }
}
```

### New code

Remove `isDuplicate()`. Replace `handle()` with a transactional version. Extract graph mutations into a private `mutateGraph()` method.

```typescript
// src/gitlab/webhook.ts

async handle(event: WebhookEvent): Promise<void> {
  const knownEvents = [
    'user_add_to_group', 'user_remove_from_group', 'user_update_for_group',
    'subgroup_create', 'subgroup_destroy',
  ]
  if (!knownEvents.includes(event.event_name)) return

  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex')

  const client = await this.pool.connect()
  try {
    await client.query('BEGIN')

    // Acquire transaction-scoped advisory lock — prevents sync/webhook races (G3, CA8)
    await this.graph.acquireXactLock(client)

    // Check for duplicate (read, no write yet)
    const existing = await client.query(
      `SELECT 1 FROM "${this.schema}".processed_webhooks WHERE payload_hash = $1`,
      [payloadHash]
    )
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      return
    }

    // Perform graph mutation
    await this.mutateGraph(event)

    // Insert dedup record AFTER successful mutation — within same transaction
    await client.query(
      `INSERT INTO "${this.schema}".processed_webhooks (payload_hash, event_name) VALUES ($1, $2)`,
      [payloadHash, event.event_name]
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err   // Re-throw — GitLab will retry on 500
  } finally {
    client.release()
  }
}

/** Pure graph mutations — no dedup table interaction */
private async mutateGraph(event: WebhookEvent): Promise<void> {
  switch (event.event_name) {
    case 'user_add_to_group':     await this.handleMemberAdd(event);    break
    case 'user_remove_from_group': await this.handleMemberRemove(event); break
    case 'user_update_for_group':
      await this.handleMemberRemove(event)
      await this.handleMemberAdd(event)
      break
    case 'subgroup_create':   await this.handleSubgroupCreate(event);  break
    case 'subgroup_destroy':  await this.handleSubgroupDestroy(event); break
  }
}
```

### New test cases — update `test/gitlab/webhook.test.ts`

```typescript
it('does not insert dedup record when graph mutation fails', async () => {
  vi.clearAllMocks()
  mockGraph.createUser.mockRejectedValueOnce(new Error('graph unavailable'))

  const event = {
    event_name: 'user_add_to_group',
    user_username: 'alice', user_email: 'alice@acme.com', user_id: 1,
    group_path: 'acme/eng', group_id: 1, group_access: 'Developer',
  }

  await expect(handler.handle(event)).rejects.toThrow('graph unavailable')

  // Dedup record must NOT exist — event stays retryable
  // (verify pool.query for INSERT into processed_webhooks was NOT called)
  const insertCalls = mockPool.query.mock.calls.filter(
    ([sql]: [string]) => typeof sql === 'string' && sql.includes('processed_webhooks') && sql.includes('INSERT')
  )
  expect(insertCalls).toHaveLength(0)
})

it('is retryable after graph failure', async () => {
  vi.clearAllMocks()
  mockGraph.createUser.mockRejectedValueOnce(new Error('transient'))
  mockGraph.createUser.mockResolvedValueOnce(undefined)
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })

  const event = {
    event_name: 'user_add_to_group',
    user_username: 'bob', user_email: 'b@x.com', user_id: 2,
    group_path: 'acme/ops', group_id: 2, group_access: 'Developer',
  }

  await expect(handler.handle(event)).rejects.toThrow('transient')
  // Second attempt — should succeed
  await expect(handler.handle(event)).resolves.toBeUndefined()
  expect(mockGraph.createUser).toHaveBeenCalledTimes(2)
})
```

---

## Amendment CA8 — Finding CA8 (HIGH): Webhooks don't acquire advisory lock

**Summary:** `fullSync()` acquires `pg_advisory_lock` to prevent concurrent sync runs, but the webhook handler mutates the same graph without any lock. A full sync running concurrently with a webhook event creates a race where the sync's rebuild can overwrite or conflict with the webhook's incremental update.

**Tasks modified:** Task 5 (`src/db/graph.ts`) and Task 9 (`src/gitlab/webhook.ts` — already updated in CA7)

### Fix: add `acquireXactLock` to GraphLayer (Task 5)

Add the following alongside `acquireSyncLock` / `releaseSyncLock` in `src/db/graph.ts`:

```typescript
// src/db/graph.ts — add to GraphLayer class

/**
 * Acquire a transaction-scoped advisory lock using the same key as fullSync().
 * Auto-released when the calling transaction commits or rolls back.
 *
 * Use this inside webhook transactions to prevent sync/webhook races (G3, CA8).
 * fullSync() uses the session-scoped variant (pg_advisory_lock); webhooks use
 * this transaction-scoped variant (pg_advisory_xact_lock) because they always
 * run inside a transaction.
 */
async acquireXactLock(client: pg.PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [this.orgId])
}
```

The `GitLabWebhookHandler` constructor already accepts `graph: GraphLayer`, so `acquireXactLock(client)` is called from inside `handle()` with no constructor changes. See Amendment CA7 for the full `handle()` implementation showing the lock call.

### New test cases — add to `test/gitlab/webhook.test.ts`

```typescript
it('acquires advisory xact lock before graph mutation', async () => {
  vi.clearAllMocks()
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })
  const lockSpy = vi.spyOn(mockGraph, 'acquireXactLock').mockResolvedValue(undefined)

  await handler.handle({
    event_name: 'user_add_to_group',
    user_username: 'alice', user_email: 'alice@acme.com', user_id: 1,
    group_path: 'acme/eng', group_id: 1, group_access: 'Developer',
  })

  expect(lockSpy).toHaveBeenCalledTimes(1)
})
```

Add a concurrency integration test to `test/security/failure-modes.test.ts`:

```typescript
it('webhook and fullSync serialize via advisory lock (no interleaving)', async () => {
  // Integration test — requires TEST_DATABASE_URL.
  // Start fullSync() (holds advisory lock).
  // Concurrently fire a webhook event.
  // Webhook must block until sync commits, then process.
  // Final graph state must be consistent.
})
```

---

## Amendment CA9 — Finding CA9 (HIGH): SET LOCAL outside transaction in getOrgClient()

**Summary:** `TenantManager.getOrgClient()` runs `SET LOCAL search_path` on a bare pooled client without an active transaction. `SET LOCAL` is transaction-scoped by PostgreSQL definition — it has no effect outside a transaction and the `search_path` immediately reverts to the pool default. The method returns a client with a silently unconfigured schema context.

**Task modified:** Task 6 (`src/db/tenant.ts`)

### Recommended fix: remove getOrgClient(), use fully-qualified table names

The correct pattern — already used by `PostgresStore` and `AuditLog` — is to pass the schema name and use `"${schema}".tablename` in all queries. No `SET LOCAL` or `SET search_path` is needed.

**Remove `getOrgClient()` from `TenantManager`:**

```typescript
// DELETE this method from TenantManager:
// async getOrgClient(orgId: string): Promise<pg.PoolClient> {
//   this.validateOrgId(orgId)
//   const schema = this.schemaName(orgId)
//   const client = await this.pool.connect()
//   await client.query(`SET LOCAL search_path TO "${schema}", public, ag_catalog`)
//   return client
// }
```

Replace with a transactional helper for callers that need schema context within a transaction:

```typescript
/**
 * Execute a callback inside a transaction.
 * Passes the client and the schema name so callers can use fully-qualified names.
 * No SET LOCAL needed — callers use "${schema}".tablename directly.
 */
async withOrgTransaction<T>(
  orgId: string,
  fn: (client: pg.PoolClient, schema: string) => Promise<T>
): Promise<T> {
  this.validateOrgId(orgId)
  const schema = this.schemaName(orgId)
  const client = await this.pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client, schema)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

**Also remove `SET LOCAL` from `createOrg()`** — it already runs inside an explicit transaction, and all migration SQL uses explicit schema qualifiers, so the `SET LOCAL` line is a no-op safety blanket:

```typescript
// In createOrg(), REMOVE this line:
await client.query(`SET LOCAL search_path TO "${schema}", public, ag_catalog`)
```

### Update the test

```typescript
// test/db/tenant.test.ts

// REMOVE this test — behaviour is now guaranteed by design:
// it('uses SET LOCAL for search_path (resets at transaction end)', ...)

// ADD these tests:
it('getOrgClient() does not exist on TenantManager', () => {
  const manager = new TenantManager(pool)
  expect((manager as any).getOrgClient).toBeUndefined()
})

it('withOrgTransaction provides schema name to callback', async () => {
  const manager = new TenantManager(pool)
  const captured: string[] = []
  await manager.withOrgTransaction('alpha', async (_client, schema) => {
    captured.push(schema)
  })
  expect(captured[0]).toBe('org_alpha')
})

it('withOrgTransaction rolls back on callback error', async () => {
  const manager = new TenantManager(pool)
  await expect(
    manager.withOrgTransaction('alpha', async () => {
      throw new Error('deliberate failure')
    })
  ).rejects.toThrow('deliberate failure')
  // Verify no partial writes escaped — check pool state if needed
})
```

---

## Amendment CA15 — Finding CA15 (HIGH): Admin auth trusts advisory JWT role field

**Summary:** `requireAdmin()` checks `req.user.role === 'admin'`, where `role` is read directly from the JWT payload. The plan's own annotation says "JWT role is advisory only" (G13). Any validly-signed token containing `role: admin` bypasses this check — no database lookup, no live verification.

**Tasks modified:** Task 10 (`src/auth/middleware.ts`, `src/auth/roles.ts`) and Task 1 (`src/config.ts`)

### Fix: admin list from config, live check at runtime

**Add `admin_users` to config schema** (`src/config.ts`):

```typescript
// In the EnterpriseConfig Zod schema, add:
admin_users: z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s: string) => s.trim()).filter(Boolean) : []),
  z.array(z.string())
).default([]),
```

```bash
# .env.example
ADMIN_USERS=alice,bob   # comma-separated bare GitLab usernames
```

**Update `src/auth/roles.ts`:**

```typescript
export const ROLES = {
  admin: 'admin',
  developer: 'developer',
} as const

export type Role = keyof typeof ROLES

/**
 * Check whether a user is in the configured admin list.
 * Matches on both bare username ("alice") and full orgId:username ("acme:alice").
 * This is the authoritative admin check — do not use JWT role for this.
 */
export function isAdminUser(userId: string, adminUsers: string[]): boolean {
  const username = userId.includes(':') ? userId.split(':').slice(1).join(':') : userId
  return adminUsers.includes(userId) || adminUsers.includes(username)
}
```

**Replace `requireAdmin` in `src/auth/middleware.ts`:**

```typescript
// OLD:
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as AuthUser
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}

// NEW — factory, takes config so admin list is live from env:
import { isAdminUser } from './roles.js'

export function createRequireAdmin(config: EnterpriseConfig) {
  return function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const user = (req as any).user as AuthUser
    // JWT role is advisory (G13) — check live admin list, not token role
    if (!isAdminUser(user.id, config.admin_users)) {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  }
}
```

**Update call sites** in `src/server.ts` (and `src/admin/routes.ts`):

```typescript
// OLD:
import { requireAdmin } from './auth/middleware.js'
app.use('/admin', requireAuth, requireAdmin)

// NEW:
import { createRequireAdmin } from './auth/middleware.js'
const requireAdmin = createRequireAdmin(config)
app.use('/admin', requireAuth, requireAdmin)
```

### New test cases — add to `test/auth/middleware.test.ts`

```typescript
describe('requireAdmin — config-based (CA15)', () => {
  const adminConfig = { ...baseConfig, admin_users: ['alice', 'acme:bob'] }
  const requireAdmin = createRequireAdmin(adminConfig)

  it('allows user in admin_users by bare username', () => {
    const { req, res, next } = mockRequest({ user: { id: 'acme:alice', role: 'developer' } })
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows user in admin_users by full orgId:username', () => {
    const { req, res, next } = mockRequest({ user: { id: 'acme:bob', role: 'developer' } })
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('rejects JWT with role=admin when user is not in admin_users', () => {
    const { req, res, next } = mockRequest({ user: { id: 'acme:evil', role: 'admin' } })
    requireAdmin(req, res, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects user not in admin_users regardless of role', () => {
    const { req, res, next } = mockRequest({ user: { id: 'acme:charlie', role: 'developer' } })
    requireAdmin(req, res, next)
    expect(res.statusCode).toBe(403)
  })
})
```

Add to `test/security/auth-bypass.test.ts`:

```typescript
it('crafted JWT with role=admin cannot access /admin routes', async () => {
  const token = generateToken(
    { userId: 'acme:attacker', email: 'x@x.com', orgId: 'acme', role: 'admin' },
    config.jwt_secret
  )
  const res = await request(app).get('/admin/users').set('Authorization', `Bearer ${token}`)
  expect(res.status).toBe(403)
})
```

---

## Amendment CA16 — Finding CA16 (HIGH): Dollar-quote injection in Cypher

**Summary:** `sanitizeCypherValue()` escapes single quotes and backslashes but not `$`. The `cypher()` and `cypherVoid()` helper methods wrap all Cypher queries in `$$...$$` dollar-quoting. An input containing `$$` terminates the dollar-quoted string early, enabling arbitrary Cypher injection. `createOrg()` is the clearest example — `name` comes from sync data and is interpolated directly into the dollar-quoted Cypher string.

**Tasks modified:** Task 2 (`src/permissions/validator.ts`) and Task 5 (`src/db/graph.ts`)

### Fix 1: Escape `$` in `sanitizeCypherValue` (Task 2)

```typescript
// src/permissions/validator.ts

// OLD:
export function sanitizeCypherValue(value: string): string {
  return value
    .replace(/\0/g, '')        // strip null bytes
    .replace(/\\/g, '\\\\')   // escape backslashes first
    .replace(/'/g, "\\'")      // escape single quotes
}

// NEW:
export function sanitizeCypherValue(value: string): string {
  return value
    .replace(/\0/g, '')        // strip null bytes
    .replace(/\\/g, '\\\\')   // escape backslashes first
    .replace(/'/g, "\\'")      // escape single quotes
    .replace(/\$/g, '\\$')     // escape dollar signs — prevents $$ delimiter breakout
}
```

### Fix 2: Use a randomized dollar-quote tag in `cypher()` and `cypherVoid()` (Task 5)

Even with `$` escaped in values, use a random tag as defense-in-depth so no user input can ever construct a matching delimiter:

```typescript
// src/db/graph.ts — add import at top
import crypto from 'node:crypto'

// OLD cypher():
private async cypher<T = unknown>(query: string, returnType: string): Promise<T[]> {
  const client = await this.pool.connect()
  try {
    await client.query("LOAD 'age'")
    await client.query('SET search_path = ag_catalog, "$user", public')
    const result = await client.query(
      `SELECT * FROM cypher('${this.graphName}', $$${query}$$) as (${returnType})`
    )
    return result.rows as T[]
  } finally {
    client.release()
  }
}

// NEW cypher():
private async cypher<T = unknown>(query: string, returnType: string): Promise<T[]> {
  const client = await this.pool.connect()
  const tag = `plur_${crypto.randomBytes(8).toString('hex')}`
  try {
    await client.query("LOAD 'age'")
    await client.query('SET search_path = ag_catalog, "$user", public')
    const result = await client.query(
      `SELECT * FROM cypher('${this.graphName}', $${tag}$${query}$${tag}$) as (${returnType})`
    )
    return result.rows as T[]
  } finally {
    client.release()
  }
}

// OLD cypherVoid():
private async cypherVoid(query: string): Promise<void> {
  const client = await this.pool.connect()
  try {
    await client.query("LOAD 'age'")
    await client.query('SET search_path = ag_catalog, "$user", public')
    await client.query(
      `SELECT * FROM cypher('${this.graphName}', $$${query}$$) as (v agtype)`
    )
  } finally {
    client.release()
  }
}

// NEW cypherVoid():
private async cypherVoid(query: string): Promise<void> {
  const client = await this.pool.connect()
  const tag = `plur_${crypto.randomBytes(8).toString('hex')}`
  try {
    await client.query("LOAD 'age'")
    await client.query('SET search_path = ag_catalog, "$user", public')
    await client.query(
      `SELECT * FROM cypher('${this.graphName}', $${tag}$${query}$${tag}$) as (v agtype)`
    )
  } finally {
    client.release()
  }
}
```

### New test cases — add to `test/security/injection.test.ts`

```typescript
describe('sanitizeCypherValue — dollar-quote injection (CA16)', () => {
  it('escapes dollar signs to prevent $$ delimiter breakout', () => {
    const evil = "$$') MATCH (n) DETACH DELETE n //"
    const safe = sanitizeCypherValue(evil)
    expect(safe).not.toContain('$$')
  })

  it('escapes single dollar sign', () => {
    expect(sanitizeCypherValue('$100')).toBe('\\$100')
  })

  it('escapes combined injection payload', () => {
    const payload = "x'\\$$ DETACH DELETE (n)"
    const safe = sanitizeCypherValue(payload)
    expect(safe).not.toMatch(/(?<!\\)'/)
    expect(safe).not.toContain('$$')
  })
})
```

Update `test/db/graph.test.ts` (or wherever `sanitizeCypherValue` tests live):

```typescript
// Add to existing describe('sanitizeCypherValue'):
it('escapes dollar signs', () => {
  expect(sanitizeCypherValue('$1')).toBe('\\$1')
  expect(sanitizeCypherValue('$$close$$')).toBe('\\$\\$close\\$\\$')
})
```

---

## Updated Resolution Matrix (Codex Round 4)

Append to the **Security Evaluator Findings** table in the plan:

| # | Finding | Severity | Resolution |
|---|---------|----------|-----------|
| **Codex Audit Round 4 (7 findings)** | | | |
| CA5 | 503 bypass on sync failure | CRITICAL | Amendment CA5 — retry loop + `syncFailed` flag + distinct 503 codes |
| CA6 | OAuth CSRF / session swap + wrong token exchange content-type | CRITICAL | Amendment CA6 — cookie nonce binding + `application/x-www-form-urlencoded` |
| CA7 | Webhook dedup record inserted before graph mutation | CRITICAL | Amendment CA7 — transactional handle(): insert dedup AFTER mutation |
| CA8 | Webhooks don't hold advisory lock during graph mutation | HIGH | Amendment CA8 — `pg_advisory_xact_lock` in webhook transaction |
| CA9 | SET LOCAL search_path has no effect outside transaction | HIGH | Amendment CA9 — remove `getOrgClient()`, use fully-qualified names + `withOrgTransaction` |
| CA15 | Admin auth trusts advisory JWT role field | HIGH | Amendment CA15 — `ADMIN_USERS` config list + `createRequireAdmin` factory |
| CA16 | Dollar-quote `$$` injection in Cypher | HIGH | Amendment CA16 — escape `$` in `sanitizeCypherValue` + randomized dollar-quote tag |

## Implementation Order for Codex Amendments

Implement in this order (dependencies first):

1. **CA16 with Task 2** — `sanitizeCypherValue` is in the validator file written by Task 2. Add the `$` escape when first writing the function. Also update `cypher()` / `cypherVoid()` tags in Task 5.
2. **CA9 with Task 6** — remove `getOrgClient()` and add `withOrgTransaction()` when writing `TenantManager`. All callers must use qualified names from the start — do not write `getOrgClient()` and then remove it.
3. **CA6 (migration column) with Task 6** — `005-oauth-pending.sql` gets `cookie_nonce_hash` added; the column must exist before the OAuth routes are written.
4. **CA7 + CA8 together in Task 9** — write `handle()` with the transaction and xact lock in a single pass. Do not write the original `isDuplicate()` pattern.
5. **CA15 with Task 10** — write `createRequireAdmin` factory from the start; never write the JWT-role-checking version.
6. **CA6 (routes) with Task 11a** — write the cookie-nonce binding into `/auth/gitlab` and `/auth/callback` when first implementing those routes.
7. **CA5 last, with Task 11a** — modify the startup IIFE after `GitLabSync` (Task 8) and `TenantManager` (Task 6) exist.
