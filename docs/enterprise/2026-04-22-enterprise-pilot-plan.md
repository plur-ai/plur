# PLUR Enterprise Pilot — Implementation Plan (v2, security-hardened)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the critical path for a 10-user enterprise pilot: Postgres+AGE storage, HTTP/SSE MCP server, token-based auth, and permission enforcement — with security as the #1 priority.

**Architecture:** Separate `plur-ai/enterprise` repository. Depends on published `@plur-ai/core` and `@plur-ai/mcp` npm packages. PostgresStore lives in the enterprise repo (not in core). All enterprise components share one PostgreSQL instance with AGE (graph) + pgvector (embeddings) extensions. Multi-org schema isolation is built in from day one, including per-org AGE graphs.

**Tech Stack:** TypeScript, Vitest, PostgreSQL 16 + Apache AGE + pgvector, Express + helmet, @modelcontextprotocol/sdk (SSE transport), node-postgres (pg), jsonwebtoken, express-rate-limit, pino (structured logging)

**Spec:** `docs/enterprise/plur-enterprise-proposal.md`

**Security review:** Plan evaluated by 3 independent reviewers (security audit, pen-test, architecture). 5 CRITICAL, 14 HIGH, 15 MEDIUM findings identified and addressed in this version.

---

## Repository Structure

This is a **separate repository** (`plur-ai/enterprise`), not a package in the plur monorepo.

```
enterprise/                              # plur-ai/enterprise repo
  package.json                           # @plur-ai/enterprise
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                             # Entry point: startServer()
    server.ts                            # Express app + SSE transport + middleware stack
    config.ts                            # Enterprise config schema (Zod validated)
    db/
      pool.ts                            # Shared Postgres connection pool
      postgres-store.ts                  # PostgresStore implementing EngramStore
      graph.ts                           # AGE graph layer (parameterized queries)
      tenant.ts                          # Multi-org schema isolation
      migrations/
        001-base-schema.sql              # Users, orgs, audit_log, engrams tables
        002-age-graph.sql                # Per-org AGE graph setup
        003-pgvector.sql                 # Vector column + index
      migrate.ts                         # Migration runner CLI
    auth/
      token.ts                           # Token generation + verification (HS256 locked)
      middleware.ts                      # requireAuth, requireAdmin middleware
      roles.ts                           # Role definitions and checks
      types.ts                           # AuthUser, AuthContext, TokenPayload types
    permissions/
      resolver.ts                        # Resolve user scopes from graph
      validator.ts                       # Input validation (engrams, scopes, IDs)
      types.ts                           # Scope, Permission types
    gitlab/
      client.ts                          # GitLab API client (groups, projects, members)
      oauth.ts                           # OAuth2 authorization code flow with PKCE
      sync.ts                            # Full + incremental org graph sync
      webhook.ts                         # Webhook handler for membership changes
      types.ts                           # GitLab API response types
    admin/
      routes.ts                          # Admin API (users, tokens, audit, health)
    middleware/
      rate-limit.ts                      # Rate limiting configuration
      security.ts                        # helmet, CORS, body limits, error handler
      session.ts                         # Session management, binding, limits
    logging/
      logger.ts                          # Pino structured logger
      audit.ts                           # Audit log writer
  test/
    db/postgres-store.test.ts
    db/graph.test.ts
    db/tenant.test.ts
    auth/token.test.ts
    auth/middleware.test.ts
    permissions/resolver.test.ts
    gitlab/client.test.ts
    gitlab/sync.test.ts
    gitlab/oauth.test.ts
    gitlab/webhook.test.ts
    security/injection.test.ts           # Injection attack test suite
    security/auth-bypass.test.ts         # Auth bypass test suite
    security/tenant-isolation.test.ts    # Cross-tenant leakage tests
    e2e/pilot.test.ts
    fixtures/
      seed.ts                            # Test data seeding
      test-guard.ts                      # Prevents running against production DBs
  docker/
    docker-compose.yml
    Dockerfile.postgres
    init.sql
  infrastructure/
    DROPLET-SETUP.md
    deploy.sh
```

**Dependency on plur core:** Published npm packages, not workspace links:
```json
{
  "dependencies": {
    "@plur-ai/core": "^0.8.3",
    "@plur-ai/mcp": "^0.8.3"
  }
}
```

For local development iteration against unpublished core changes, use `pnpm link`.

---

## Security-First Task Order

Tasks are reordered to build security foundations first:

```
Task 0:   Infrastructure (Docker Compose + DO instructions)
Task 1:   Repo scaffold + dependency setup (pinned deps, GitLab config parsing, gitlab_enabled flag)
Task 2:   Input validation + sanitization library (path normalization, schema validators)
Task 3:   Structured logging + audit log writer (retention policy, PII pseudonymization)
Task 4:   PostgresStore (CRUD + search + vectors) — in enterprise repo
Task 4b:  Plur core DI — PR to plur repo adding store injection to Plur constructor [BLOCKER]
Task 5:   AGE graph layer — parameterized queries, per-org graphs, full interface (incl remove*)
Task 6:   Multi-org schema isolation + migration runner CLI [BLOCKER fix: migrate.ts]
Task 7:   GitLab API client + OAuth2 flow + encrypted token storage [BLOCKER fix: gitlab_tokens]
Task 8:   GitLab org sync + ensureUserSynced + sync CLI [BLOCKER fix: undefined function]
Task 9:   GitLab webhook handler — constant-time validation, replay protection, orgId from config
Task 10:  Auth: GitLab OAuth + dual-secret JWT rotation + startup sync gate (503 until ready)
Task 11:  HTTP server + security middleware stack (rate limits on /auth/*, /webhook/*)
Task 12:  Session management (user-bound, limited, expiring, 503 pre-sync)
Task 13:  Permission enforcement (scope resolver + write guards)
Task 13b: Enterprise MCP tool allowlist + write permission wrapper [CRITICAL: R1-R9]
Task 14:  Security test suite (injection, auth, tenants, sessions, MCP tools, failure modes)
Task 15:  E2E integration tests (GitLab auth, sync, permission flow, tool restrictions)
Task 16:  DO droplet deployment + GITLAB-SETUP.md
```

---

## Task 0: Infrastructure

### Task 0a: Docker Compose for local development

**Files:**
- Create: `docker/Dockerfile.postgres`
- Create: `docker/docker-compose.yml`
- Create: `docker/init.sql`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
# docker/Dockerfile.postgres
# Pin to specific digest for supply chain security
FROM apache/age:PG16_v1.5.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential postgresql-server-dev-16 git ca-certificates && \
    git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && make && make install && \
    rm -rf /tmp/pgvector && \
    apt-get remove -y build-essential postgresql-server-dev-16 git && \
    apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Create init.sql**

```sql
-- docker/init.sql
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS vector;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
SELECT extname, extversion FROM pg_extension WHERE extname IN ('age', 'vector');
```

- [ ] **Step 3: Create docker-compose.yml — bind to localhost only**

```yaml
# docker/docker-compose.yml
version: "3.9"
services:
  postgres:
    build:
      context: .
      dockerfile: Dockerfile.postgres
    ports:
      - "127.0.0.1:5432:5432"   # SECURITY: localhost only, not 0.0.0.0
    environment:
      POSTGRES_USER: plur_test
      POSTGRES_PASSWORD: plur_test_only
      POSTGRES_DB: plur_enterprise_test
    volumes:
      - ./init.sql:/docker-entrypoint-initdb.d/01-init.sql
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U plur_test -d plur_enterprise_test"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  pgdata:
```

- [ ] **Step 4: Build and verify extensions**

```bash
cd docker && docker compose up -d --build
docker compose exec postgres psql -U plur_test -d plur_enterprise_test \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('age', 'vector');"
```

Expected: Two rows with version numbers.

- [ ] **Step 5: Verify AGE Cypher works**

```bash
docker compose exec postgres psql -U plur_test -d plur_enterprise_test -c "
  LOAD 'age';
  SET search_path = ag_catalog, \"\\\$user\", public;
  SELECT create_graph('test_graph');
  SELECT * FROM cypher('test_graph', \$\$CREATE (n:Test {name: 'hello'}) RETURN n\$\$) as (n agtype);
  SELECT drop_graph('test_graph', true);
"
```

Expected: Node created and returned, graph cleaned up.

- [ ] **Step 6: Commit**

```bash
git add docker/ && git commit -m "infra: Docker Compose for Postgres + AGE + pgvector (localhost only)"
```

### Task 0b: DO Droplet Setup Instructions

**Files:** Create: `infrastructure/DROPLET-SETUP.md`

The instructions are the same as v1 with these security fixes:

- [ ] **Step 1: Write hardened droplet instructions**

Key changes from v1:
- **Restricted sudo**: `deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart plur-enterprise, /bin/systemctl stop plur-enterprise, /bin/systemctl status plur-enterprise` — no blanket NOPASSWD
- **Separate SSH keys**: Generate fresh keys for deploy user, don't copy root's authorized_keys
- **Postgres auth**: `scram-sha-256` in pg_hba.conf, reject `CHANGE_ME` passwords
- **Auto-generate secrets at deploy time**: `deploy.sh` generates JWT_SECRET if missing: `openssl rand -base64 48`
- **File permissions**: `.env` is `chmod 600`, owned by `deploy:deploy`
- **Postgres SSL**: Enable SSL for database connections (self-signed cert for pilot, Let's Encrypt for prod)
- **Firewall**: Port 5432 NOT open (Postgres is localhost only)
- **Caddy** handles TLS termination (auto Let's Encrypt)
- **Daily backups**: `pg_dump` cron job, 7-day retention

- [ ] **Step 2: Commit**

```bash
git add infrastructure/ && git commit -m "infra: hardened DO droplet setup instructions"
```

---

## Task 1: Repo Scaffold

**Files:** Create standard project files

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@plur-ai/enterprise",
  "version": "0.1.0",
  "private": true,
  "description": "PLUR Enterprise — multi-user server with auth and permissions",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:security": "vitest run test/security/",
    "dev": "tsx src/index.ts",
    "migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "@plur-ai/core": "^0.8.3",
    "@plur-ai/mcp": "^0.8.3",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.0",
    "helmet": "^8.0.0",
    "cors": "^2.8.5",
    "pg": "^8.13.0",
    "jsonwebtoken": "^9.0.2",
    "pino": "^9.0.0",
    "pino-http": "^10.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/pg": "^8.11.0",
    "tsup": "^8.0.0",
    "tsx": "^4.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json, vitest.config.ts** (same as v1)

- [ ] **Step 3: Create test guard — prevents running against production**

```typescript
// test/fixtures/test-guard.ts
export function assertTestDatabase(url: string): void {
  const parsed = new URL(url)
  const dbName = parsed.pathname.slice(1)
  if (!dbName.includes('test') && !dbName.includes('dev')) {
    throw new Error(
      `SAFETY: Refusing to run tests against database "${dbName}". ` +
      `Database name must contain "test" or "dev". Got: ${url}`
    )
  }
}
```

- [ ] **Step 4: Create config.ts — validated, secure defaults**

```typescript
// src/config.ts
import { z } from 'zod'

const WEAK_SECRETS = ['CHANGE_ME', 'secret', 'password', 'test', 'dev']

export const EnterpriseConfigSchema = z.object({
  port: z.number().default(3000),
  database_url: z.string().url(),
  jwt_secret: z.string().min(32).refine(
    (s) => !WEAK_SECRETS.some(w => s.toLowerCase().includes(w.toLowerCase())),
    'JWT_SECRET must not contain common placeholder words'
  ),
  org_id: z.string().regex(/^[a-z][a-z0-9_]{2,30}$/, 'org_id must be lowercase alphanumeric'),
  org_name: z.string().min(1).max(100),
  cors_origins: z.array(z.string().url()).default([]),  // SECURITY: empty default, not '*'
  node_env: z.enum(['development', 'production', 'test']).default('development'),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // GitLab integration
  gitlab_url: z.string().url(),                         // e.g. https://gitlab.company.com
  gitlab_client_id: z.string().min(1),                  // OAuth application ID
  gitlab_client_secret: z.string().min(1),              // OAuth application secret
  gitlab_redirect_uri: z.string().url(),                // e.g. https://plur.company.com/auth/callback
  gitlab_webhook_secret: z.string().min(16),            // Webhook verification token
  gitlab_sync_interval_minutes: z.number().default(60), // Periodic full sync interval (0=disabled)
})

export type EnterpriseConfig = z.infer<typeof EnterpriseConfigSchema>

export function loadEnterpriseConfig(): EnterpriseConfig {
  const result = EnterpriseConfigSchema.safeParse({
    port: parseInt(process.env.PORT || '3000', 10),
    database_url: process.env.DATABASE_URL,
    jwt_secret: process.env.JWT_SECRET,
    org_id: process.env.ORG_ID || 'default',
    org_name: process.env.ORG_NAME || 'Default Organization',
    cors_origins: process.env.CORS_ORIGINS?.split(',').filter(Boolean) || [],
    node_env: process.env.NODE_ENV || 'development',
    log_level: process.env.LOG_LEVEL || 'info',
  })

  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`)
    console.error('Configuration error:\n' + issues.join('\n'))
    process.exit(1)
  }

  return result.data
}
```

- [ ] **Step 5: Install, build, commit**

```bash
npm install && npm run build
git add . && git commit -m "feat: scaffold enterprise repo with secure config defaults"
```

---

## Task 2: Input Validation + Sanitization Library

Security foundation — used by every subsequent task.

**Files:** Create: `src/permissions/validator.ts`, `test/security/injection.test.ts`

- [ ] **Step 1: Write injection attack tests (test-first security)**

```typescript
// test/security/injection.test.ts
import { describe, it, expect } from 'vitest'
import { validateIdentifier, sanitizeCypherValue, validateEngramSize } from '../../src/permissions/validator.js'

describe('Input Validation — Injection Prevention', () => {
  describe('validateIdentifier', () => {
    it('accepts valid identifiers', () => {
      expect(validateIdentifier('alice')).toBe(true)
      expect(validateIdentifier('backend-api')).toBe(true)
      expect(validateIdentifier('project_123')).toBe(true)
      expect(validateIdentifier('alice@acme.com')).toBe(true)
    })

    it('rejects Cypher injection payloads', () => {
      expect(validateIdentifier("alice'})-[:X]->(:Y) //")).toBe(false)
      expect(validateIdentifier("'; DROP GRAPH plur; --")).toBe(false)
      expect(validateIdentifier('x$$y')).toBe(false)
      expect(validateIdentifier("x' OR '1'='1")).toBe(false)
    })

    it('rejects SQL injection payloads', () => {
      expect(validateIdentifier("x; DROP TABLE engrams; --")).toBe(false)
      expect(validateIdentifier("x' UNION SELECT * FROM users --")).toBe(false)
    })

    it('rejects empty and oversized values', () => {
      expect(validateIdentifier('')).toBe(false)
      expect(validateIdentifier('a'.repeat(256))).toBe(false)
    })
  })

  describe('sanitizeCypherValue', () => {
    it('escapes single quotes', () => {
      expect(sanitizeCypherValue("it's")).toBe("it\\'s")
    })

    it('escapes backslashes', () => {
      expect(sanitizeCypherValue('path\\to')).toBe('path\\\\to')
    })

    it('strips null bytes', () => {
      expect(sanitizeCypherValue('hello\x00world')).toBe('helloworld')
    })
  })

  describe('validateEngramSize', () => {
    it('accepts engrams under 64KB', () => {
      expect(validateEngramSize(JSON.stringify({ statement: 'short' }))).toBe(true)
    })

    it('rejects engrams over 64KB', () => {
      const huge = JSON.stringify({ statement: 'x'.repeat(100000) })
      expect(validateEngramSize(huge)).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run tests — expected to fail**

```bash
npm test -- test/security/injection.test.ts
```

- [ ] **Step 3: Implement validators**

```typescript
// src/permissions/validator.ts

/** Strict identifier pattern: alphanumeric, hyphens, underscores, dots, @.
 *  No quotes, braces, semicolons, dollars, or whitespace. */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._@\/-]{0,254}$/

/** Characters that are dangerous in Cypher string literals */
const CYPHER_DANGEROUS = /['{}\\\$;]/

/** Characters that are dangerous in SQL identifiers */
const SQL_DANGEROUS = /[;'"\\`\0]/

export function validateIdentifier(value: string): boolean {
  if (!value || value.length > 255) return false
  if (CYPHER_DANGEROUS.test(value)) return false
  if (SQL_DANGEROUS.test(value)) return false
  return SAFE_IDENTIFIER.test(value)
}

export function sanitizeCypherValue(value: string): string {
  return value
    .replace(/\0/g, '')        // strip null bytes
    .replace(/\\/g, '\\\\')   // escape backslashes first
    .replace(/'/g, "\\'")      // escape single quotes
}

export function validateEngramSize(serialized: string): boolean {
  return serialized.length <= 65536 // 64KB max
}

export function validateEmbedding(embedding: unknown): embedding is number[] {
  if (!Array.isArray(embedding)) return false
  if (embedding.length === 0 || embedding.length > 2048) return false
  return embedding.every(v => typeof v === 'number' && Number.isFinite(v))
}

export function validateScope(scope: string): boolean {
  // Scopes follow pattern: type:identifier
  // Types: user, group, project, org, global
  if (scope === 'global') return true
  const match = scope.match(/^(user|group|project|org):(.+)$/)
  if (!match) return false
  return validateIdentifier(match[2])
}
```

- [ ] **Step 4: Run tests — expected to pass**

```bash
npm test -- test/security/injection.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/permissions/validator.ts test/security/injection.test.ts
git commit -m "feat: input validation and sanitization library (injection prevention)"
```

---

## Task 3: Structured Logging + Audit Log Writer

**Files:** Create: `src/logging/logger.ts`, `src/logging/audit.ts`

- [ ] **Step 1: Write audit log test**

```typescript
// test/logging/audit.test.ts (outline — full test code omitted for brevity)
// Tests:
// - audit.log() writes to audit_log table with correct fields
// - audit.log() includes userId, action, targetType, targetId, details, timestamp
// - audit.logAuth() logs authentication events (success + failure)
// - audit.logTokenGen() logs token generation with recipient userId
// - logs are queryable by userId and time range
```

- [ ] **Step 2: Implement logger**

```typescript
// src/logging/logger.ts
import pino from 'pino'
import type { EnterpriseConfig } from '../config.js'

export function createLogger(config: EnterpriseConfig) {
  return pino({
    level: config.log_level,
    ...(config.node_env === 'production' ? {} : { transport: { target: 'pino-pretty' } }),
    redact: ['req.headers.authorization', 'database_url', 'jwt_secret'], // Never log secrets
  })
}
```

- [ ] **Step 3: Implement audit writer**

```typescript
// src/logging/audit.ts
import type pg from 'pg'

export class AuditLog {
  constructor(private pool: pg.Pool, private schema: string) {}

  async log(entry: {
    userId: string
    action: string
    targetType?: string
    targetId?: string
    details?: Record<string, unknown>
    ip?: string
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.audit_log (user_id, action, target_type, target_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.userId, entry.action, entry.targetType, entry.targetId,
       entry.details ? JSON.stringify(entry.details) : null, entry.ip]
    )
  }

  async logAuth(userId: string, success: boolean, ip: string): Promise<void> {
    await this.log({ userId, action: success ? 'auth.success' : 'auth.failure', ip })
  }

  async logTokenGen(adminId: string, targetUserId: string, ip: string): Promise<void> {
    await this.log({
      userId: adminId,
      action: 'token.generate',
      targetType: 'user',
      targetId: targetUserId,
      ip,
    })
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/logging/ test/logging/
git commit -m "feat: structured logging (pino) + audit log writer with secret redaction"
```

---

## Task 4: PostgresStore (in enterprise repo)

Implements `EngramStore` interface from `@plur-ai/core` against PostgreSQL. Includes full-text search (tsvector) and vector search (pgvector).

**Files:** Create: `src/db/postgres-store.ts`, `test/db/postgres-store.test.ts`

This task is the same as v1 Tasks 2+3+4 combined, with these security fixes:

- [ ] **Key security changes from v1:**

1. **Shared pool**: `PostgresStore` accepts a `pg.Pool` instance, not a connection string. The pool is owned by the server, shared across all Plur instances. Prevents 50x connection multiplication.

```typescript
export class PostgresStore implements EngramStore {
  constructor(private pool: pg.Pool, private schema: string = 'public') {}
  // All queries use: `${this.schema}.engrams` for table references
}
```

2. **Schema-scoped**: Every query references `${this.schema}.engrams` to support multi-org isolation.

3. **LIMIT parameterized**: No string interpolation for LIMIT:
```typescript
const result = await this.pool.query(
  `SELECT data FROM ${this.schema}.engrams ... ORDER BY rank DESC LIMIT $${paramIdx}`,
  [...values, limit]
)
```

4. **Engram size validation**: Calls `validateEngramSize()` before INSERT.

5. **Embedding validation**: Calls `validateEmbedding()` before vector INSERT. Uses parameterized vector cast.

6. **Test guard**: Every test file calls `assertTestDatabase(TEST_DB_URL)` in `beforeAll`.

- [ ] **Step 1-N**: Same TDD flow as v1 — tests first, implementation, verify. All v1 CRUD + search + vector tests apply, with the above fixes.

- [ ] **Commit**

```bash
git commit -m "feat: PostgresStore with shared pool, schema scoping, input validation"
```

---

## Task 5: AGE Graph Layer — Parameterized Queries, Per-Org Graphs

This is the AGE validation spike AND the implementation. **All Cypher queries use parameterized inputs or validated identifiers — no raw string interpolation.**

**Files:** Create: `src/db/graph.ts`, `test/db/graph.test.ts`

- [ ] **Key security changes from v1:**

1. **Per-org graphs**: Graph name includes org ID: `plur_${orgId}`. Each org gets its own isolated graph. No cross-org traversal possible.

2. **All inputs validated**: Every method calls `validateIdentifier()` before constructing queries. Invalid inputs throw immediately.

3. **Parameterized where possible**: AGE supports Cypher parameters via the SQL layer. Where it doesn't, inputs are validated against strict allowlists.

```typescript
// SAFE: validate before interpolation
async createUser(id: string, email: string): Promise<void> {
  if (!validateIdentifier(id)) throw new Error(`Invalid user ID: ${id}`)
  if (!validateIdentifier(email)) throw new Error(`Invalid email: ${email}`)

  const safeId = sanitizeCypherValue(id)
  const safeEmail = sanitizeCypherValue(email)

  await this.cypher(
    `CREATE (:User {id: '${safeId}', email: '${safeEmail}'})`,
    'v agtype'
  )
}
```

4. **Graph name validated**: `this.graphName` is computed once in constructor from `validateIdentifier(orgId)`.

5. **Injection test suite** tests every GraphLayer method with malicious payloads:

```typescript
// test/security/injection.test.ts (addition)
describe('GraphLayer injection prevention', () => {
  it('rejects Cypher injection in createUser', async () => {
    await expect(
      graph.createUser("alice'})-[:X]->(:Y) //", 'x@x.com')
    ).rejects.toThrow('Invalid user ID')
  })

  it('rejects Cypher injection in addMembership', async () => {
    await expect(
      graph.addMembership("alice", "backend'}); MATCH (n) DETACH DELETE n //", 'dev')
    ).rejects.toThrow('Invalid group ID')
  })
})
```

6. **SQL fallback ready**: If AGE parameterization proves inadequate, `GraphLayer` internals swap to standard SQL (same public interface, same tests pass).

- [ ] **Step 1-N**: Same TDD flow — graph setup, permission resolution, subgroup hierarchy, isolation tests. Every test also verifies injection prevention.

- [ ] **Commit**

```bash
git commit -m "feat: AGE graph layer with per-org isolation, validated inputs, injection prevention"
```

---

## Task 6: Multi-Org Schema Isolation (TenantManager)

Same as v1 Task 10, with these fixes:

- [ ] **Key security changes:**

1. **Quoted schema names**: All DDL uses double-quoted identifiers:
```typescript
await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
await client.query(`SET LOCAL search_path TO "${schema}", public, ag_catalog`)
```

2. **SET LOCAL, not SET**: `SET LOCAL search_path` resets automatically at transaction end. Prevents search_path leaking across pooled connections.

3. **Schema name collision detection**: Before `CREATE SCHEMA`, check no existing schema maps from a different orgId.

4. **OrgId validated**: `validateIdentifier(orgId)` called before any operation.

5. **Test for cross-tenant leakage**:

```typescript
// test/security/tenant-isolation.test.ts
it('should not leak data across tenants via connection reuse', async () => {
  await manager.createOrg('alpha')
  await manager.createOrg('beta')

  // Insert into alpha
  const alphaClient = await manager.getOrgClient('alpha')
  await alphaClient.query("INSERT INTO engrams (id, status, scope, data) VALUES ('secret', 'active', 'global', '{}'::jsonb)")
  alphaClient.release()

  // Query from beta — must not see alpha's data
  const betaClient = await manager.getOrgClient('beta')
  const result = await betaClient.query('SELECT count(*)::int AS c FROM engrams')
  betaClient.release()

  expect(result.rows[0].c).toBe(0)
})
```

- [ ] **Commit**

```bash
git commit -m "feat: TenantManager with quoted identifiers, SET LOCAL, collision detection"
```

---

## Task 7: GitLab API Client + OAuth2 Flow

**Files:** Create: `src/gitlab/client.ts`, `src/gitlab/oauth.ts`, `src/gitlab/types.ts`, `test/gitlab/client.test.ts`, `test/gitlab/oauth.test.ts`

This task builds the GitLab API layer. The client is used by the sync task (Task 8) and the OAuth flow replaces token-only auth for developers.

### Task 7a: GitLab API Client

- [ ] **Step 1: Write failing test for GitLab API client**

```typescript
// test/gitlab/client.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { GitLabClient } from '../../src/gitlab/client.js'

// These tests run against a real GitLab instance or mock
// Set GITLAB_URL and GITLAB_TOKEN for integration tests
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com'
const GITLAB_TOKEN = process.env.GITLAB_TOKEN // Optional — skip integration tests if missing

describe('GitLabClient', () => {
  describe('unit tests (no network)', () => {
    it('constructs with base URL and normalizes trailing slash', () => {
      const client = new GitLabClient('https://gitlab.example.com/', 'token')
      expect(client.baseUrl).toBe('https://gitlab.example.com')
    })

    it('rejects non-HTTPS URLs by default', () => {
      expect(() => new GitLabClient('http://gitlab.com', 'token'))
        .toThrow('GitLab URL must use HTTPS')
    })

    it('allows HTTP in development mode', () => {
      expect(() => new GitLabClient('http://localhost:3000', 'token', { allowInsecure: true }))
        .not.toThrow()
    })
  })

  // Integration tests — only run with real credentials
  describe.skipIf(!GITLAB_TOKEN)('integration (requires GITLAB_TOKEN)', () => {
    let client: GitLabClient

    beforeAll(() => {
      client = new GitLabClient(GITLAB_URL, GITLAB_TOKEN!)
    })

    it('should fetch current user profile', async () => {
      const user = await client.getCurrentUser()
      expect(user.id).toBeDefined()
      expect(user.username).toBeDefined()
      expect(user.email).toBeDefined()
    })

    it('should list groups with pagination', async () => {
      const groups = await client.listUserGroups()
      expect(Array.isArray(groups)).toBe(true)
      // Each group should have id, path, full_path
      if (groups.length > 0) {
        expect(groups[0].id).toBeDefined()
        expect(groups[0].full_path).toBeDefined()
      }
    })

    it('should list projects with pagination', async () => {
      const projects = await client.listUserProjects()
      expect(Array.isArray(projects)).toBe(true)
      if (projects.length > 0) {
        expect(projects[0].id).toBeDefined()
        expect(projects[0].path_with_namespace).toBeDefined()
        expect(projects[0].namespace).toBeDefined()
      }
    })
  })
})
```

- [ ] **Step 2: Implement GitLab API client**

```typescript
// src/gitlab/types.ts
export interface GitLabUser {
  id: number
  username: string
  email: string
  name: string
  state: string
  avatar_url: string | null
}

export interface GitLabGroup {
  id: number
  name: string
  path: string
  full_name: string
  full_path: string
  parent_id: number | null
  visibility: string
}

export interface GitLabProject {
  id: number
  name: string
  path: string
  path_with_namespace: string
  namespace: {
    id: number
    name: string
    path: string
    kind: string         // 'group' | 'user'
    full_path: string
    parent_id: number | null
  }
  visibility: string
  archived: boolean
  permissions?: {
    project_access?: { access_level: number }
    group_access?: { access_level: number }
  }
}

export interface GitLabMember {
  id: number
  username: string
  name: string
  state: string
  access_level: number   // 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner
  email?: string
}

/** GitLab access levels */
export const ACCESS_LEVELS = {
  GUEST: 10,
  REPORTER: 20,
  DEVELOPER: 30,
  MAINTAINER: 40,
  OWNER: 50,
} as const
```

```typescript
// src/gitlab/client.ts
import type { GitLabUser, GitLabGroup, GitLabProject, GitLabMember } from './types.js'
import type { Logger } from 'pino'

export class GitLabClient {
  readonly baseUrl: string
  private token: string
  private logger?: Logger

  constructor(baseUrl: string, token: string, options?: { requireHttps?: boolean; logger?: Logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.logger = options?.logger

    if (options?.requireHttps && !this.baseUrl.startsWith('https://')) {
      throw new Error('GitLab URL must use HTTPS')
    }
  }

  /** Paginated GET — follows keyset pagination, returns all results */
  private async paginatedGet<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = []
    let url = `${this.baseUrl}/api/v4${path}?per_page=100&${new URLSearchParams(params || {}).toString()}`

    while (url) {
      this.logger?.debug({ url }, 'GitLab API request')

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      })

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10)
        this.logger?.warn({ retryAfter }, 'GitLab rate limited, waiting')
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        continue // retry same URL
      }

      if (!res.ok) {
        throw new Error(`GitLab API error: ${res.status} ${res.statusText} on ${url}`)
      }

      const data = await res.json() as T[]
      results.push(...data)

      // Follow pagination via Link header
      const linkHeader = res.headers.get('Link')
      const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/)
      url = nextMatch ? nextMatch[1] : ''
    }

    return results
  }

  async getCurrentUser(): Promise<GitLabUser> {
    const res = await fetch(`${this.baseUrl}/api/v4/user`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`GitLab API error: ${res.status}`)
    return res.json() as Promise<GitLabUser>
  }

  async listUserGroups(): Promise<GitLabGroup[]> {
    return this.paginatedGet<GitLabGroup>('/groups', { membership: 'true' })
  }

  async listUserProjects(options?: { minAccessLevel?: number }): Promise<GitLabProject[]> {
    const params: Record<string, string> = { membership: 'true' }
    if (options?.minAccessLevel) params.min_access_level = options.minAccessLevel.toString()
    return this.paginatedGet<GitLabProject>('/projects', params)
  }

  async listGroupMembers(groupId: number): Promise<GitLabMember[]> {
    return this.paginatedGet<GitLabMember>(`/groups/${groupId}/members/all`)
  }

  async listGroupSubgroups(groupId: number): Promise<GitLabGroup[]> {
    return this.paginatedGet<GitLabGroup>(`/groups/${groupId}/subgroups`)
  }

  /** Update the token (e.g., after OAuth refresh) */
  updateToken(newToken: string): void {
    this.token = newToken
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- test/gitlab/client.test.ts
```

Expected: Unit tests PASS. Integration tests skip without GITLAB_TOKEN.

- [ ] **Step 4: Commit**

```bash
git add src/gitlab/ test/gitlab/
git commit -m "feat: GitLab API client with pagination, rate limit handling"
```

### Task 7b: GitLab OAuth2 Flow (with PKCE)

- [ ] **Step 1: Write failing test**

```typescript
// test/gitlab/oauth.test.ts
import { describe, it, expect } from 'vitest'
import { GitLabOAuth, generatePKCE } from '../../src/gitlab/oauth.js'

describe('GitLab OAuth', () => {
  const oauth = new GitLabOAuth({
    gitlabUrl: 'https://gitlab.example.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://plur.example.com/auth/callback',
  })

  it('generates a valid authorization URL with PKCE', () => {
    const { url, state, codeVerifier } = oauth.getAuthorizationUrl()
    expect(url).toContain('gitlab.example.com/oauth/authorize')
    expect(url).toContain('client_id=test-client-id')
    expect(url).toContain('response_type=code')
    expect(url).toContain('scope=read_api+openid+profile+email')
    expect(url).toContain('code_challenge=')
    expect(url).toContain('code_challenge_method=S256')
    expect(state).toBeTruthy()
    expect(codeVerifier).toBeTruthy()
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  it('generates unique state and PKCE per call', () => {
    const a = oauth.getAuthorizationUrl()
    const b = oauth.getAuthorizationUrl()
    expect(a.state).not.toBe(b.state)
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
  })
})

describe('PKCE', () => {
  it('generates code verifier of correct length and charset', () => {
    const { codeVerifier, codeChallenge } = generatePKCE()
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    expect(codeVerifier.length).toBeLessThanOrEqual(128)
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(codeChallenge).toBeTruthy()
  })
})
```

- [ ] **Step 2: Implement OAuth flow**

```typescript
// src/gitlab/oauth.ts
import crypto from 'node:crypto'

export interface GitLabOAuthConfig {
  gitlabUrl: string         // e.g. https://gitlab.example.com
  clientId: string
  clientSecret: string
  redirectUri: string       // e.g. https://plur.example.com/auth/callback
  scopes?: string[]
}

export interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  created_at: number
  scope: string
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(64).toString('base64url').slice(0, 128)
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return { codeVerifier, codeChallenge }
}

export class GitLabOAuth {
  private config: GitLabOAuthConfig

  constructor(config: GitLabOAuthConfig) {
    this.config = config
  }

  getAuthorizationUrl(): { url: string; state: string; codeVerifier: string } {
    const state = crypto.randomBytes(32).toString('hex')
    const { codeVerifier, codeChallenge } = generatePKCE()
    const scopes = this.config.scopes ?? ['read_api', 'openid', 'profile', 'email']

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      state,
      scope: scopes.join('+'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    return {
      url: `${this.config.gitlabUrl}/oauth/authorize?${params.toString()}`,
      state,
      codeVerifier,
    }
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokenResponse> {
    const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.config.redirectUri,
        code_verifier: codeVerifier,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GitLab token exchange failed: ${res.status} ${body}`)
    }

    return res.json() as Promise<OAuthTokenResponse>
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const res = await fetch(`${this.config.gitlabUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        redirect_uri: this.config.redirectUri,
      }),
    })

    if (!res.ok) throw new Error(`GitLab token refresh failed: ${res.status}`)
    return res.json() as Promise<OAuthTokenResponse>
  }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npm test -- test/gitlab/oauth.test.ts
git commit -m "feat: GitLab OAuth2 with PKCE flow"
```

---

## Task 8: GitLab Org Sync — Populate Graph from GitLab

**Files:** Create: `src/gitlab/sync.ts`, `test/gitlab/sync.test.ts`

This is the bridge between GitLab's org structure and PLUR's permission graph. It reads groups, projects, and memberships from GitLab and populates the AGE graph.

- [ ] **Step 1: Write failing test**

```typescript
// test/gitlab/sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitLabSync } from '../../src/gitlab/sync.js'

// Mock GitLab client for unit testing
const mockClient = {
  listUserGroups: vi.fn(),
  listUserProjects: vi.fn(),
  listGroupMembers: vi.fn(),
  listGroupSubgroups: vi.fn(),
}

// Mock graph layer
const mockGraph = {
  createOrg: vi.fn(),
  createGroup: vi.fn(),
  createProject: vi.fn(),
  createUser: vi.fn(),
  addMembership: vi.fn(),
  clear: vi.fn(),
  resolveUserScopes: vi.fn(),
}

describe('GitLabSync', () => {
  let sync: GitLabSync

  beforeEach(() => {
    vi.clearAllMocks()
    sync = new GitLabSync(mockClient as any, mockGraph as any, 'acme')
  })

  it('syncs groups from GitLab to graph', async () => {
    mockClient.listUserGroups.mockResolvedValue([
      { id: 1, full_path: 'acme/backend', parent_id: null, path: 'backend' },
      { id: 2, full_path: 'acme/frontend', parent_id: null, path: 'frontend' },
      { id: 3, full_path: 'acme/backend/payments', parent_id: 1, path: 'payments' },
    ])
    mockClient.listUserProjects.mockResolvedValue([])

    await sync.syncGroups()

    expect(mockGraph.createGroup).toHaveBeenCalledTimes(3)
    // Subgroup should reference parent
    expect(mockGraph.createGroup).toHaveBeenCalledWith(
      'acme/backend/payments', 'acme', 'acme/backend'
    )
  })

  it('syncs projects with their group ownership', async () => {
    mockClient.listUserProjects.mockResolvedValue([
      {
        id: 10, path_with_namespace: 'acme/backend/api', archived: false,
        namespace: { full_path: 'acme/backend', kind: 'group' },
      },
      {
        id: 11, path_with_namespace: 'acme/frontend/web', archived: false,
        namespace: { full_path: 'acme/frontend', kind: 'group' },
      },
    ])

    await sync.syncProjects()

    expect(mockGraph.createProject).toHaveBeenCalledTimes(2)
    expect(mockGraph.createProject).toHaveBeenCalledWith('acme/backend/api', 'acme/backend')
    expect(mockGraph.createProject).toHaveBeenCalledWith('acme/frontend/web', 'acme/frontend')
  })

  it('skips archived projects', async () => {
    mockClient.listUserProjects.mockResolvedValue([
      { id: 10, path_with_namespace: 'acme/old-project', archived: true,
        namespace: { full_path: 'acme', kind: 'group' } },
    ])

    await sync.syncProjects()

    expect(mockGraph.createProject).not.toHaveBeenCalled()
  })

  it('syncs group members with access levels', async () => {
    mockClient.listUserGroups.mockResolvedValue([
      { id: 1, full_path: 'acme/backend', parent_id: null, path: 'backend' },
    ])
    mockClient.listGroupMembers.mockResolvedValue([
      { id: 100, username: 'alice', name: 'Alice', access_level: 30, state: 'active' },
      { id: 101, username: 'bob', name: 'Bob', access_level: 40, state: 'active' },
      { id: 102, username: 'charlie', name: 'Charlie', access_level: 10, state: 'blocked' },
    ])

    await sync.syncMembers()

    // Should create users for active members
    expect(mockGraph.createUser).toHaveBeenCalledTimes(2) // charlie is blocked, skip
    expect(mockGraph.addMembership).toHaveBeenCalledWith('alice', 'acme/backend', 'developer')
    expect(mockGraph.addMembership).toHaveBeenCalledWith('bob', 'acme/backend', 'maintainer')
  })

  it('runs full sync in correct order', async () => {
    mockClient.listUserGroups.mockResolvedValue([])
    mockClient.listUserProjects.mockResolvedValue([])
    mockClient.listGroupMembers.mockResolvedValue([])

    const report = await sync.fullSync()

    expect(report.groups).toBe(0)
    expect(report.projects).toBe(0)
    expect(report.users).toBe(0)
    expect(report.memberships).toBe(0)
    expect(report.duration_ms).toBeDefined()
  })
})
```

- [ ] **Step 2: Implement GitLabSync**

```typescript
// src/gitlab/sync.ts
import type { GitLabClient } from './client.js'
import type { GraphLayer } from '../db/graph.js'
import { validateIdentifier } from '../permissions/validator.js'
import { ACCESS_LEVELS } from './types.js'
import type { Logger } from 'pino'

export interface SyncReport {
  groups: number
  projects: number
  users: number
  memberships: number
  skipped: { archived: number; blocked: number; invalid: number }
  errors: string[]
  duration_ms: number
}

function accessLevelToRole(level: number): string {
  if (level >= ACCESS_LEVELS.OWNER) return 'owner'
  if (level >= ACCESS_LEVELS.MAINTAINER) return 'maintainer'
  if (level >= ACCESS_LEVELS.DEVELOPER) return 'developer'
  if (level >= ACCESS_LEVELS.REPORTER) return 'reporter'
  return 'guest'
}

export class GitLabSync {
  private logger?: Logger

  constructor(
    private client: GitLabClient,
    private graph: GraphLayer,
    private orgId: string,
    options?: { logger?: Logger }
  ) {
    this.logger = options?.logger
  }

  async syncGroups(): Promise<{ count: number; skipped: number }> {
    const groups = await this.client.listUserGroups()
    let count = 0
    let skipped = 0

    // Sort by parent_id (null first) to ensure parents created before children
    const sorted = groups.sort((a, b) => (a.parent_id ?? 0) - (b.parent_id ?? 0))

    for (const group of sorted) {
      if (!validateIdentifier(group.full_path)) {
        this.logger?.warn({ group: group.full_path }, 'Skipping group with invalid path')
        skipped++
        continue
      }

      // Find parent group by parent_id
      const parent = group.parent_id
        ? groups.find(g => g.id === group.parent_id)
        : null

      await this.graph.createGroup(
        group.full_path,
        this.orgId,
        parent?.full_path
      )
      count++
    }

    return { count, skipped }
  }

  async syncProjects(): Promise<{ count: number; archived: number; skipped: number }> {
    const projects = await this.client.listUserProjects()
    let count = 0
    let archived = 0
    let skipped = 0

    for (const project of projects) {
      if (project.archived) { archived++; continue }
      if (project.namespace.kind !== 'group') { skipped++; continue }
      if (!validateIdentifier(project.path_with_namespace)) {
        this.logger?.warn({ project: project.path_with_namespace }, 'Skipping project with invalid path')
        skipped++
        continue
      }

      await this.graph.createProject(project.path_with_namespace, project.namespace.full_path)
      count++
    }

    return { count, archived, skipped }
  }

  async syncMembers(): Promise<{ users: number; memberships: number; blocked: number }> {
    const groups = await this.client.listUserGroups()
    const seenUsers = new Set<string>()
    let memberships = 0
    let blocked = 0

    for (const group of groups) {
      const members = await this.client.listGroupMembers(group.id)

      for (const member of members) {
        if (member.state !== 'active') { blocked++; continue }
        if (!validateIdentifier(member.username)) continue

        // Create user node only once
        if (!seenUsers.has(member.username)) {
          await this.graph.createUser(member.username, member.email || `${member.username}@unknown`)
          seenUsers.add(member.username)
        }

        // Add membership with role derived from access level
        const role = accessLevelToRole(member.access_level)
        await this.graph.addMembership(member.username, group.full_path, role)
        memberships++
      }
    }

    return { users: seenUsers.size, memberships, blocked }
  }

  async fullSync(): Promise<SyncReport> {
    const start = Date.now()
    const errors: string[] = []
    const report: SyncReport = {
      groups: 0, projects: 0, users: 0, memberships: 0,
      skipped: { archived: 0, blocked: 0, invalid: 0 },
      errors,
      duration_ms: 0,
    }

    try {
      // Create org node
      await this.graph.createOrg(this.orgId, this.orgId)

      // Sync in dependency order: groups → projects → members
      const groupResult = await this.syncGroups()
      report.groups = groupResult.count
      report.skipped.invalid += groupResult.skipped

      const projectResult = await this.syncProjects()
      report.projects = projectResult.count
      report.skipped.archived = projectResult.archived
      report.skipped.invalid += projectResult.skipped

      const memberResult = await this.syncMembers()
      report.users = memberResult.users
      report.memberships = memberResult.memberships
      report.skipped.blocked = memberResult.blocked
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }

    report.duration_ms = Date.now() - start
    this.logger?.info(report, 'GitLab sync complete')
    return report
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- test/gitlab/sync.test.ts
```

Expected: All PASS (unit tests with mocks).

- [ ] **Step 4: Commit**

```bash
git add src/gitlab/sync.ts test/gitlab/sync.test.ts
git commit -m "feat: GitLab org sync — groups, projects, members to permission graph"
```

---

## Task 9: GitLab Webhook Handler — Real-Time Membership Updates

**Files:** Create: `src/gitlab/webhook.ts`, `test/gitlab/webhook.test.ts`

Handles GitLab webhook events to keep the permission graph in sync without polling.

- [ ] **Step 1: Write failing test**

```typescript
// test/gitlab/webhook.test.ts
import { describe, it, expect, vi } from 'vitest'
import { GitLabWebhookHandler } from '../../src/gitlab/webhook.js'

const mockGraph = {
  createUser: vi.fn(),
  addMembership: vi.fn(),
  removeMembership: vi.fn(),
  createGroup: vi.fn(),
  removeGroup: vi.fn(),
}

describe('GitLabWebhookHandler', () => {
  const handler = new GitLabWebhookHandler(mockGraph as any, 'webhook-secret-token')

  it('validates webhook signature', () => {
    expect(handler.validateToken('webhook-secret-token')).toBe(true)
    expect(handler.validateToken('wrong-token')).toBe(false)
  })

  it('handles user_add_to_group event', async () => {
    await handler.handle({
      event_name: 'user_add_to_group',
      user_username: 'alice',
      user_email: 'alice@acme.com',
      user_id: 123,
      group_path: 'backend',
      group_id: 1,
      group_access: 'Developer',
    })

    expect(mockGraph.createUser).toHaveBeenCalledWith('alice', 'alice@acme.com')
    expect(mockGraph.addMembership).toHaveBeenCalledWith('alice', expect.any(String), 'developer')
  })

  it('handles user_remove_from_group event', async () => {
    await handler.handle({
      event_name: 'user_remove_from_group',
      user_username: 'alice',
      group_path: 'backend',
      group_id: 1,
    })

    expect(mockGraph.removeMembership).toHaveBeenCalledWith('alice', expect.any(String))
  })

  it('handles subgroup_create event', async () => {
    await handler.handle({
      event_name: 'subgroup_create',
      group_id: 5,
      name: 'payments',
      path: 'payments',
      full_path: 'acme/backend/payments',
      parent_group_id: 1,
    })

    expect(mockGraph.createGroup).toHaveBeenCalled()
  })

  it('rejects events with invalid token', () => {
    expect(handler.validateToken('wrong')).toBe(false)
  })

  it('ignores unknown event types gracefully', async () => {
    await expect(handler.handle({ event_name: 'push' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement webhook handler**

```typescript
// src/gitlab/webhook.ts
import type { GraphLayer } from '../db/graph.js'
import { validateIdentifier } from '../permissions/validator.js'
import type { Logger } from 'pino'

interface WebhookEvent {
  event_name: string
  [key: string]: unknown
}

export class GitLabWebhookHandler {
  constructor(
    private graph: GraphLayer,
    private secretToken: string,
    private logger?: Logger
  ) {}

  validateToken(token: string): boolean {
    // Constant-time comparison to prevent timing attacks
    if (token.length !== this.secretToken.length) return false
    let result = 0
    for (let i = 0; i < token.length; i++) {
      result |= token.charCodeAt(i) ^ this.secretToken.charCodeAt(i)
    }
    return result === 0
  }

  async handle(event: WebhookEvent): Promise<void> {
    this.logger?.info({ event_name: event.event_name }, 'GitLab webhook received')

    switch (event.event_name) {
      case 'user_add_to_group':
        await this.handleMemberAdd(event)
        break
      case 'user_remove_from_group':
        await this.handleMemberRemove(event)
        break
      case 'user_update_for_group':
        await this.handleMemberUpdate(event)
        break
      case 'subgroup_create':
        await this.handleSubgroupCreate(event)
        break
      case 'subgroup_destroy':
        await this.handleSubgroupDestroy(event)
        break
      default:
        this.logger?.debug({ event_name: event.event_name }, 'Ignoring unhandled webhook event')
    }
  }

  private async handleMemberAdd(event: WebhookEvent): Promise<void> {
    const username = event.user_username as string
    const email = event.user_email as string
    const groupPath = event.group_path as string
    const accessStr = (event.group_access as string).toLowerCase()

    if (!validateIdentifier(username) || !validateIdentifier(groupPath)) return

    await this.graph.createUser(username, email)
    await this.graph.addMembership(username, groupPath, accessStr)
  }

  private async handleMemberRemove(event: WebhookEvent): Promise<void> {
    const username = event.user_username as string
    const groupPath = event.group_path as string
    if (!validateIdentifier(username) || !validateIdentifier(groupPath)) return

    await this.graph.removeMembership(username, groupPath)
  }

  private async handleMemberUpdate(event: WebhookEvent): Promise<void> {
    // Remove and re-add with new access level
    await this.handleMemberRemove(event)
    await this.handleMemberAdd(event)
  }

  private async handleSubgroupCreate(event: WebhookEvent): Promise<void> {
    const fullPath = event.full_path as string
    const parentId = event.parent_group_id as number
    if (!validateIdentifier(fullPath)) return

    // We don't have parent's full_path from the event — need to resolve
    // For now, create the group. The periodic sync will fix parent linkage.
    await this.graph.createGroup(fullPath, 'unknown')
    this.logger?.info({ fullPath }, 'Subgroup created — run sync to fix parent linkage')
  }

  private async handleSubgroupDestroy(event: WebhookEvent): Promise<void> {
    const fullPath = event.full_path as string
    if (!validateIdentifier(fullPath)) return
    await this.graph.removeGroup(fullPath)
  }
}
```

- [ ] **Step 3: Add webhook route to Express server**

Add to `server.ts`:

```typescript
  // GitLab webhook endpoint — validates secret token
  app.post('/webhook/gitlab', express.json(), async (req, res) => {
    const token = req.headers['x-gitlab-token'] as string
    if (!webhookHandler.validateToken(token || '')) {
      logger.warn({ ip: req.ip }, 'GitLab webhook rejected — invalid token')
      res.status(403).json({ error: 'Invalid webhook token' })
      return
    }

    try {
      await webhookHandler.handle(req.body)
      await audit.log({ userId: 'gitlab-webhook', action: 'webhook.received',
        details: { event: req.body.event_name } })
      res.json({ ok: true })
    } catch (err) {
      logger.error({ err }, 'Webhook handler error')
      res.status(500).json({ error: 'Webhook processing failed' })
    }
  })
```

- [ ] **Step 4: Run tests, commit**

```bash
npm test -- test/gitlab/webhook.test.ts
git commit -m "feat: GitLab webhook handler for real-time membership updates"
```

---

### GitLab Integration — Security Hardening (from evaluator review)

The following security requirements apply across Tasks 7-9 and are enforced by the security test suite (Task 14):

**G1 — GitLab Token Storage (CRITICAL):** OAuth access/refresh tokens must be stored encrypted in the database, not in memory. Add a `gitlab_tokens` table per org schema:

```sql
CREATE TABLE gitlab_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Use envelope encryption with a key derived from (but not identical to) JWT_SECRET. Add a refresh flow that runs before any sync operation. If refresh fails (user deactivated on GitLab), revoke the PLUR session.

**G2 — Namespace User Identifiers (CRITICAL):** Graph user nodes store `orgId:username` (e.g., `acme:alice`), not bare `username`. This prevents cross-org identity confusion when a self-hosted GitLab admin crafts responses. The `resolveUserScopes()` query matches on the namespaced ID.

**G3 — Sync Locking (HIGH):** All sync operations acquire a PostgreSQL advisory lock per org: `SELECT pg_advisory_lock(hashtext($orgId))`. Webhook events received during sync are queued and replayed after sync completes. All graph mutations are idempotent (use MERGE/upsert, not CREATE).

**G4 — Permission Lag Mitigation (HIGH):** Write operations (learn, promote) check the user's GitLab group membership via a cached API call (30-second TTL). Read operations (recall, inject) use the graph cache (updated by sync + webhooks). This means a revoked user loses write access in 30 seconds and read access at next sync or webhook. Sync interval reduced to 15 minutes for the pilot.

**G5 — OAuth State Management (HIGH):** The `oauthStates` map enforces 5-minute TTL via a 60-second sweep interval. Map capped at 1000 entries; new flows rejected when full. Rate limit: 10 requests/min per IP on `/auth/*`.

**G6 — Rate Limiting on Auth/Webhook (HIGH):** `/auth/*` routes: 10 req/min per IP. `/webhook/gitlab`: 60 req/min per IP. Optional IP allowlisting for webhook endpoint (GitLab instance IP range).

**G7 — Error Sanitization (HIGH):** OAuth callback wraps all GitLab API calls in try/catch. Error responses from GitLab token endpoint are NEVER logged verbatim. Log only: `{ status, error_type }`, not the response body.

**G8 — Constant-Time Token Validation (MEDIUM):** Webhook `validateToken` uses `crypto.timingSafeEqual` with SHA-256 hashes of both values (fixed-length comparison eliminates length leakage).

**G9 — Path Normalization (MEDIUM):** Before `validateIdentifier`, paths are normalized: collapse `//`, reject `..` segments, strip leading/trailing `/`, reject null bytes.

**G10 — Response Schema Validation (MEDIUM):** All GitLab API responses are validated against Zod schemas before processing. Invalid responses are logged and skipped, not passed to graph operations.

**G11 — TLS Default (MEDIUM):** `GitLabClient` requires HTTPS by default. `allowInsecure: true` option available only for development.

**G12 — Async First-Login Sync (MEDIUM):** First login returns JWT immediately. Sync runs in background. User sees a "syncing permissions" status until complete. Sync scoped to max 50 groups per batch.

**G13 — JWT Role Is Advisory (MEDIUM):** The `role` field in JWT tokens is for UI display only. ALL permission enforcement goes through `PermissionResolver.resolveUserScopes()` which queries the live graph. JWT claims are NEVER the source of truth for access control.

---

## Task 10: Auth — GitLab OAuth + Token Management

Auth now supports TWO flows:
- **GitLab OAuth** (primary) — developer authenticates via GitLab, gets a PLUR session token backed by their GitLab identity. On first login, a full sync runs for that user's groups/projects.
- **Pre-provisioned tokens** (fallback) — admin generates tokens via CLI for clients that can't do OAuth (same as v1, but now with admin role enforcement).

**Files:** Create: `src/auth/token.ts`, `src/auth/middleware.ts`, `src/auth/roles.ts`

- [ ] **Key changes: OAuth callback route**

Add to `server.ts`:

```typescript
  // OAuth: initiate GitLab login
  app.get('/auth/gitlab', (req, res) => {
    const { url, state, codeVerifier } = gitlabOAuth.getAuthorizationUrl()
    // Store state + codeVerifier in short-lived server-side map (5 min TTL)
    oauthStates.set(state, { codeVerifier, createdAt: Date.now() })
    res.redirect(url)
  })

  // OAuth: callback from GitLab
  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query as { code: string; state: string }
    const pending = oauthStates.get(state)
    if (!pending) { res.status(400).json({ error: 'Invalid or expired state' }); return }
    oauthStates.delete(state)

    // Exchange code for GitLab access token
    const gitlabTokens = await gitlabOAuth.exchangeCode(code, pending.codeVerifier)

    // Get user profile from GitLab
    const gitlabClient = new GitLabClient(config.gitlab_url, gitlabTokens.access_token)
    const gitlabUser = await gitlabClient.getCurrentUser()

    // Ensure user exists in graph (first login triggers sync)
    await ensureUserSynced(gitlabUser, gitlabClient)

    // Issue PLUR JWT
    const plurToken = generateToken({
      userId: gitlabUser.username,
      email: gitlabUser.email,
      orgId: config.org_id,
      role: 'developer', // role resolved from graph memberships
    }, config.jwt_secret)

    // Return token (client stores it for MCP config)
    res.json({ token: plurToken, user: { id: gitlabUser.username, email: gitlabUser.email } })
  })
```

- [ ] **Key security features (same as v1):**

1. **Algorithm locked to HS256**:
```typescript
export function generateToken(payload: TokenInput, secret: string, options?: TokenOptions): string {
  return jwt.sign(
    { sub: payload.userId, email: payload.email, orgId: payload.orgId, role: payload.role },
    secret,
    { algorithm: 'HS256', expiresIn: options?.expiresIn ?? '30d', issuer: 'plur-enterprise' }
  )
}

export function verifyToken(token: string, secret: string, expectedOrgId: string): TokenPayload {
  const decoded = jwt.verify(token, secret, {
    algorithms: ['HS256'],   // SECURITY: reject all other algorithms
    issuer: 'plur-enterprise',
  }) as jwt.JwtPayload

  if (decoded.orgId !== expectedOrgId) {
    throw new Error('Token org mismatch')  // SECURITY: prevent cross-org token reuse
  }

  return { userId: decoded.sub!, email: decoded.email, orgId: decoded.orgId, role: decoded.role || 'developer' }
}
```

2. **Admin role required for /admin routes**:
```typescript
// src/auth/middleware.ts
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as AuthUser
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
```

3. **Org-binding enforced**: `verifyToken()` checks `orgId` matches server's `config.org_id`.

4. **Auth events audited**: Every auth success/failure logged via `AuditLog.logAuth()`.

5. **Bootstrap CLI is the only way to create the first admin token**. The `/admin/tokens` endpoint requires `requireAdmin`.

- [ ] **Test suite includes auth bypass tests**:

```typescript
// test/security/auth-bypass.test.ts
it('rejects token with alg:none', () => { /* ... */ })
it('rejects token from different org', () => { /* ... */ })
it('rejects expired token', () => { /* ... */ })
it('developer cannot access /admin/tokens', () => { /* ... */ })
it('admin can access /admin/tokens', () => { /* ... */ })
```

- [ ] **Commit**

```bash
git commit -m "feat: JWT auth with HS256 lock, admin roles, org-binding, audit logging"
```

---

## Task 11: HTTP Server + Security Middleware Stack

**Files:** Create: `src/server.ts`, `src/middleware/security.ts`, `src/middleware/rate-limit.ts`

- [ ] **Key security changes from v1:**

1. **Middleware stack** (order matters):
```typescript
app.use(helmet())                              // Security headers
app.use(cors({ origin: config.cors_origins, credentials: true }))
app.use(express.json({ limit: '1mb' }))        // Body size limit
app.use(pinoHttp({ logger }))                  // Structured request logging
app.use('/admin', adminRateLimit)              // 10 req/min on admin routes
app.use('/sse', sseRateLimit)                  // 5 concurrent per user
app.use('/messages', messageRateLimit)         // 100 req/min per session
```

2. **Global error handler** — no stack traces in production:
```typescript
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, reqId: req.id }, 'Unhandled error')
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' })
  }
})
```

3. **Health endpoint** — unauthenticated returns minimal info, authenticated returns full status:
```typescript
app.get('/health', async (req, res) => {
  const basic = { status: 'ok' }
  if (!(req as any).user) return res.json(basic)  // Unauthenticated: minimal

  // Authenticated: full status
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false)
  res.json({
    ...basic,
    version: '0.1.0',
    org: config.org_name,
    db: { connected: dbOk, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
    uptime: process.uptime(),
  })
})
```

4. **Graceful shutdown**:
```typescript
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...')
  httpServer.close()
  for (const [id, session] of sessions) {
    session.transport.close()
    sessions.delete(id)
  }
  await pool.end()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled rejection — shutting down')
  shutdown('unhandledRejection')
})
```

5. **Shared connection pool** — one pool for all users:
```typescript
const pool = new pg.Pool({ connectionString: config.database_url, max: 20 })
pool.on('error', (err) => logger.error({ err }, 'Pool error'))
```

- [ ] **Commit**

```bash
git commit -m "feat: HTTP server with security middleware, rate limiting, graceful shutdown"
```

---

## Task 12: Session Management

**Files:** Create: `src/middleware/session.ts`

- [ ] **Key security changes from v1:**

1. **Sessions bound to users**: Transport map stores `{ transport, userId, orgId, expiresAt }`.
2. **`/messages` validates session owner**:
```typescript
if (session.userId !== (req as any).user.id) {
  res.status(403).json({ error: 'Session belongs to another user' })
  return
}
```
3. **Per-user session limit**: Max 5 concurrent SSE sessions per user. New connections close the oldest.
4. **Session expiry**: Sessions expire when their JWT expires. Background sweep every 60s closes expired sessions.
5. **Global session limit**: Max 100 concurrent sessions total (sufficient for 10-user pilot with headroom).

- [ ] **Commit**

```bash
git commit -m "feat: session management — user-bound, limited, expiring, protected"
```

---

## Task 13: Permission Enforcement

Same as v1 Task 8, with these additions:

1. **Write permission checks**: `canWrite(userId, targetScope)` verifies user has the scope AND appropriate role (Developer+ for project scope, Maintainer+ for group scope).
2. **Scope validation**: All scope strings validated via `validateScope()` before database operations.
3. **Engram owner tracking**: Every engram stores `owner_id` from the authenticated user. Personal engrams (`user:X` scope) can only be created by user X.

- [ ] **Commit**

```bash
git commit -m "feat: permission enforcement with scope validation and write guards"
```

---

## Task 13b: Enterprise MCP Tool Allowlist + Permission Wrapper

**This is the most important security task in the plan.** The existing PLUR MCP server exposes 32 tools designed for single-user local operation. Many are dangerous in multi-user enterprise mode. This task defines which tools are available, which are disabled, and wraps all write tools with permission checks.

**Files:** Create: `src/mcp/tool-filter.ts`, `src/mcp/permission-wrapper.ts`, `test/mcp/tool-filter.test.ts`

### Enterprise Tool Policy

| Tool | Enterprise Status | Reason |
|------|------------------|--------|
| **ALLOWED (read, permission-filtered)** | | |
| `plur_session_start` | Allowed | Injection scoped by user's resolved permissions |
| `plur_session_end` | Allowed | Session cleanup |
| `plur_recall` | Allowed | Search filtered by user scopes |
| `plur_recall_hybrid` | Allowed + rate limited | 10 req/min/user (embedding computation) |
| `plur_inject` | Allowed | Injection scoped by user scopes |
| `plur_inject_hybrid` | Allowed + rate limited | 10 req/min/user |
| `plur_status` | Allowed | Returns user-scoped stats only |
| `plur_profile` | Allowed | User's own profile |
| `plur_timeline` | Allowed | User's own timeline |
| `plur_history` | Allowed | User's own history |
| `plur_tensions` | Allowed | User-scoped |
| `plur_packs_list` | Allowed | Read-only, org-scoped |
| `plur_packs_discover` | Allowed | Read-only |
| `plur_packs_preview` | Allowed | Read-only |
| **ALLOWED (write, permission-wrapped)** | | |
| `plur_learn` | Wrapped | **Scope validated**: user must have write access to target scope |
| `plur_feedback` | Wrapped | Rate limited + scope-gated for org/group engrams |
| `plur_forget` | Wrapped | User can only forget own engrams or engrams in writable scopes |
| `plur_promote` | Wrapped | Promotion requires target-scope write permission |
| `plur_capture` | Wrapped | Scope validated |
| `plur_ingest` | Wrapped | Max 10 auto-saved engrams, start as `candidate`, scope validated |
| **DISABLED (dangerous in multi-user)** | | |
| `plur_stores_add` | **DISABLED** | Filesystem access — arbitrary path read |
| `plur_stores_list` | **DISABLED** | Exposes filesystem paths |
| `plur_sync` | **DISABLED** | Git remote injection — data exfiltration |
| `plur_sync_status` | **DISABLED** | Git-based sync not used in enterprise |
| `plur_packs_install` | **DISABLED** | Filesystem path traversal |
| `plur_packs_export` | **DISABLED** | Filesystem write to arbitrary path |
| `plur_packs_uninstall` | **DISABLED** | Filesystem operation |
| `plur_extract_meta` | **DISABLED** | Accepts `llm_base_url` — SSRF |
| `plur_validate_meta` | **DISABLED** | Accepts `llm_base_url` — SSRF |
| `plur_meta_engrams` | **DISABLED** | Depends on LLM endpoint config |
| `plur_report_failure` | **DISABLED** | Accepts `llm_base_url` — SSRF |
| `plur_episode_to_engram` | **DISABLED** | LLM-dependent |

### Implementation

```typescript
// src/mcp/tool-filter.ts
const ENTERPRISE_ALLOWED_TOOLS = new Set([
  'plur_session_start', 'plur_session_end',
  'plur_recall', 'plur_recall_hybrid',
  'plur_inject', 'plur_inject_hybrid',
  'plur_status', 'plur_profile', 'plur_timeline', 'plur_history', 'plur_tensions',
  'plur_packs_list', 'plur_packs_discover', 'plur_packs_preview',
  'plur_learn', 'plur_feedback', 'plur_forget', 'plur_promote',
  'plur_capture', 'plur_ingest',
])

const ENTERPRISE_WRITE_TOOLS = new Set([
  'plur_learn', 'plur_feedback', 'plur_forget', 'plur_promote',
  'plur_capture', 'plur_ingest',
])

export function isToolAllowed(toolName: string): boolean {
  return ENTERPRISE_ALLOWED_TOOLS.has(toolName)
}

export function isWriteTool(toolName: string): boolean {
  return ENTERPRISE_WRITE_TOOLS.has(toolName)
}
```

```typescript
// src/mcp/permission-wrapper.ts
// Wraps MCP tool dispatch to enforce scope permissions on write tools
export async function enforceWritePermission(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  resolver: PermissionResolver
): Promise<void> {
  if (!isWriteTool(toolName)) return

  const scope = (args.scope as string) || `user:${userId}`  // Default to personal scope

  if (!validateScope(scope)) {
    throw new Error(`Invalid scope: ${scope}`)
  }

  const canWrite = await resolver.canWrite(userId, scope)
  if (!canWrite) {
    throw new Error(`Permission denied: cannot write to scope ${scope}`)
  }
}
```

### Tests

```typescript
// test/mcp/tool-filter.test.ts
it('blocks plur_stores_add', () => {
  expect(isToolAllowed('plur_stores_add')).toBe(false)
})

it('blocks plur_sync', () => {
  expect(isToolAllowed('plur_sync')).toBe(false)
})

it('allows plur_learn', () => {
  expect(isToolAllowed('plur_learn')).toBe(true)
})

it('identifies write tools', () => {
  expect(isWriteTool('plur_learn')).toBe(true)
  expect(isWriteTool('plur_recall')).toBe(false)
})

// Permission wrapper tests
it('rejects scope forgery — developer writing to org scope', async () => {
  // Mock resolver: alice has access to group:frontend only
  await expect(
    enforceWritePermission('plur_learn', { scope: 'org:acme' }, 'alice', mockResolver)
  ).rejects.toThrow('Permission denied')
})

it('allows write to own personal scope', async () => {
  await expect(
    enforceWritePermission('plur_learn', { scope: 'user:alice' }, 'alice', mockResolver)
  ).resolves.toBeUndefined()
})
```

- [ ] **Commit**

```bash
git commit -m "feat: enterprise MCP tool allowlist + write permission wrapper (closes R1-R9)"
```

---

## Task 14: Security Test Suite

Dedicated security tests that verify all fixes from the evaluator findings.

**Files:** `test/security/injection.test.ts` (extend), `test/security/auth-bypass.test.ts`, `test/security/tenant-isolation.test.ts`

- [ ] **Injection tests** — verify every GraphLayer and TenantManager method rejects injection payloads
- [ ] **Auth bypass tests** — alg:none, wrong org, expired, developer-as-admin
- [ ] **Tenant isolation tests** — cross-schema leakage, shared graph leakage, connection pool reuse leakage
- [ ] **Session hijacking tests** — session not bound to user, session limit enforcement
- [ ] **Rate limit tests** — verify limits trigger on rapid requests
- [ ] **Size limit tests** — oversized engrams, oversized request bodies

- [ ] **Commit**

```bash
git commit -m "test: comprehensive security test suite (injection, auth, tenants, sessions)"
```

---

## Task 15: E2E Integration Tests

Full stack test including GitLab OAuth flow: health check, OAuth initiation, callback token exchange, SSE connection with OAuth-issued token, permission-scoped recall, admin token generation (admin-only), webhook processing.

---

## Task 16: DO Droplet Deployment

Same as v1 Task 12 with hardened deployment script. Additional steps:
- Register GitLab OAuth application (on client's GitLab instance)
- Configure `GITLAB_URL`, `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITLAB_WEBHOOK_SECRET` in `.env`
- Set up GitLab group webhook (pointing to `https://plur-enterprise.domain/webhook/gitlab`)
- Run initial full sync: `tsx src/gitlab/cli/sync.ts`
- Verify sync report shows expected group/project/user counts

---

## Task Dependency Graph

```
Task 0:   Infrastructure ─────────────────────────────┐
Task 1:   Repo scaffold ─────────────────────────────-─┤
                                                       ▼
Task 2:   Input validation ───────────────────────────┤ (used by everything)
Task 3:   Structured logging + audit ─────────────────┤ (used by everything)
                                                       ▼
Task 4:   PostgresStore ──────────────────────────────┤
Task 4b:  Plur core DI (PR to plur repo) ────────────┤ (parallel with 4, merge before 11)
Task 5:   AGE graph (parameterized, per-org) ─────────┤
Task 6:   TenantManager + migration CLI ──────────────┤
                                                       ▼
Task 7:   GitLab client + OAuth + token storage ──────┤
Task 8:   GitLab sync + ensureUserSynced + CLI ───────┤ (requires 5+7)
Task 9:   GitLab webhooks (replay protection) ────────┤ (requires 5+7)
                                                       ▼
Task 10:  Auth (GitLab OAuth, dual-secret JWT, 503 gate) ─┤ (requires 7+8)
Task 11:  HTTP server + security middleware ──────────┤ (requires 4b)
Task 12:  Session management ─────────────────────────┤
Task 13:  Permission enforcement ─────────────────────┤
Task 13b: MCP tool allowlist + permission wrapper ────┤ (CRITICAL, requires 13)
                                                       ▼
Task 14:  Security test suite ────────────────────────┤
Task 15:  E2E integration tests ──→ Task 16: Deploy
```

**Parallelizable:**
- Tasks 2+3 (foundations) run in parallel
- Tasks 4+4b+5+6 (data layer) run in parallel after 2+3. Task 4b is a PR to the plur repo.
- Task 7 (GitLab client) can start in parallel with 4+5+6
- Tasks 8+9 (GitLab sync + webhooks) run in parallel after 5+7
- Tasks 11+12+13 (server layer) run in parallel after 10
- Task 13b (tool allowlist) requires 13 — this is on the critical path before E2E tests
- Task 14 (security tests) covers ALL implementation tasks including 13b

---

## AGE Validation Spike

Task 5 IS the validation spike. If AGE's Cypher cannot be secured against injection (parameterized queries don't work, validation is insufficient), the fallback:

1. Replace `GraphLayer` internals with standard SQL using relational tables (`groups`, `projects`, `users`, `memberships`) and JOINs/recursive CTEs
2. Same `GraphLayer` public interface — all tests pass identically
3. No changes to consumers (PermissionResolver, server)
4. Document specific AGE limitations for future reference

---

## Security Evaluator Findings — Resolution Matrix

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Cypher injection | CRITICAL | Task 2 (validator) + Task 5 (parameterized) |
| 2 | No admin auth on /admin/tokens | CRITICAL | Task 7 (requireAdmin middleware) |
| 3 | JWT secret in plaintext + sudo | CRITICAL | Task 0b (restricted sudo, auto-generated secret) |
| 4 | Wrong repo structure | CRITICAL | Entire plan restructured as separate repo |
| 5 | PostgresStore in wrong package | CRITICAL | Moved to enterprise repo (Task 4) |
| 6 | JWT algorithm confusion | HIGH | Task 7 (algorithms: ['HS256']) |
| 7 | Session hijacking | HIGH | Task 9 (user-bound sessions) |
| 8 | Token reuse across orgs | HIGH | Task 7 (org-binding in verifyToken) |
| 9 | No rate limiting | HIGH | Task 8 (express-rate-limit) |
| 10 | Unlimited SSE connections | HIGH | Task 9 (per-user + global limits) |
| 11 | Connection pool multiplication | HIGH | Task 4 (shared pool, not per-store) |
| 12 | No graceful shutdown | HIGH | Task 8 (SIGTERM handler) |
| 13 | No error boundaries | HIGH | Task 8 (global error handler) |
| 14 | Shared graph across tenants | HIGH | Task 5 (per-org graphs) |
| 15 | search_path leak on pool | HIGH | Task 6 (SET LOCAL) |
| 16 | Passwordless sudo | HIGH | Task 0b (restricted sudo) |
| 17 | CORS wildcard default | HIGH | Task 1 (empty default) |
| 18 | Health leaks info unauthenticated | HIGH | Task 8 (minimal public, full behind auth) |
| 19 | DB creds in plaintext | HIGH | Task 0b (chmod 600, scram-sha-256) |
| 20 | No token revocation | MEDIUM | Deferred — short-lived tokens in Phase 2 |
| 21 | No audit logging | MEDIUM | Task 3 (audit log writer) |
| 22 | No engram size validation | MEDIUM | Task 2 (validateEngramSize) |
| 23 | LIMIT interpolation | MEDIUM | Task 4 (parameterized) |
| 24 | Docker binds 0.0.0.0 | MEDIUM | Task 0a (127.0.0.1) |
| 25 | No migration strategy | MEDIUM | Task 6 (migrate.ts CLI) |
| 26 | No structured logging | MEDIUM | Task 3 (pino) |
| 27 | Superficial health check | MEDIUM | Task 8 (DB connectivity check) |
| 28 | Config validation UX | MEDIUM | Task 1 (safeParse + readable errors) |
| 29 | Embedding not validated | MEDIUM | Task 2 (validateEmbedding) |
| 30 | No body size limit | MEDIUM | Task 8 (express.json limit) |
| 31 | PostgresStore bypasses tenant | MEDIUM | Task 4 (schema parameter) |
| 32 | Schema name collision | MEDIUM | Task 6 (collision detection) |
| 33 | require() in ESM | MEDIUM | Fixed — top-level imports throughout |
| 34 | SSE session expiry | MEDIUM | Task 12 (background sweep) |
| | | | |
| **GitLab Integration Findings (v3)** | | |
| G1 | GitLab token storage undefined | CRITICAL | Encrypted `gitlab_tokens` table + refresh flow |
| G2 | User IDs not namespaced per org | CRITICAL | Graph stores `orgId:username` |
| G3 | Concurrent sync/webhook races | HIGH | `pg_advisory_lock` + idempotent ops |
| G4 | 60-min permission lag after revocation | HIGH | 30s cached membership check on writes |
| G5 | OAuth state map: no TTL, no cap | HIGH | 5-min sweep + 1000 entry cap |
| G6 | No rate limit on /auth/* and /webhook/* | HIGH | 10/min auth, 60/min webhook per IP |
| G7 | OAuth callback leaks GitLab errors in logs | HIGH | Sanitize — log status only, never body |
| G8 | Webhook token timing leak | MEDIUM | `crypto.timingSafeEqual` with hashed values |
| G9 | Path traversal in group names | MEDIUM | Normalize paths, reject `..` |
| G10 | GitLab responses not schema-validated | MEDIUM | Zod schemas for all API responses |
| G11 | Self-hosted TLS not enforced by default | MEDIUM | HTTPS default, `allowInsecure` for dev only |
| G12 | First-login sync blocks callback | MEDIUM | Async sync, return JWT immediately |
| G13 | JWT role used as permission source of truth | MEDIUM | Live `resolveUserScopes()` for all checks |
| | | | |
| **Round 3 — Final Review Findings** | | |
| | | | |
| **Blockers (QA)** | | |
| B1 | `loadEnterpriseConfig()` doesn't parse GitLab env vars | BLOCKER | Add all `GITLAB_*` env vars to safeParse (Task 1) |
| B2 | `ensureUserSynced()` called but never defined | BLOCKER | Define in `src/gitlab/sync.ts` — checks graph, triggers scoped sync if new user (Task 8) |
| B3 | No Plur core DI — can't inject PostgresStore into MCP tools | BLOCKER | New Task 4b: add `store?: EngramStore` to Plur constructor OR create `EnterprisePlur` wrapper. PR to plur repo. |
| B4 | `migrate.ts` CLI referenced but never created | BLOCKER | Add to Task 6: create `src/db/migrate.ts` that runs SQL migration files in order, tracks applied migrations in `schema_migrations` table |
| B5 | `gitlab_tokens` encrypted table — no implementing task | BLOCKER | Add to Task 7b: create migration, encryption functions, token refresh flow |
| | | | |
| **MCP Tool Security (Red Team)** | | |
| R1 | Scope forgery on plur_learn — user writes to org scope without permission | HIGH | New Task 10b: MCP tool permission wrapper (see below) |
| R2 | `plur_stores_add` exposes arbitrary filesystem read | CRITICAL | Enterprise tool allowlist — DISABLE in enterprise mode |
| R3 | `plur_packs_install/export` path traversal | HIGH | Enterprise tool allowlist — DISABLE filesystem pack tools |
| R4 | SSE session ID enumeration reveals active users | HIGH | Use `crypto.randomUUID()`, return 404 for both missing and wrong-user sessions |
| R5 | Feedback bombing suppresses org engrams | MEDIUM | Rate limit feedback, require write permission for org/group scope feedback, locked engrams immune |
| R6 | `plur_sync` exfiltrates engrams via attacker git remote | HIGH | Enterprise tool allowlist — DISABLE |
| R7 | Embedding computation DoS via parallel queries | MEDIUM | Rate limit hybrid recall to 10/min/user, 5s timeout on embeddings |
| R8 | SSRF via user-supplied `llm_base_url` in meta/validate tools | HIGH | Enterprise tool allowlist — DISABLE or strip `llm_base_url` param |
| R9 | `plur_ingest` mass knowledge poisoning | MEDIUM | Cap at 10 auto-saved engrams per call, start as `candidate` status |
| R10 | Webhook replay re-grants revoked permissions | MEDIUM | `processed_webhooks` table with payload hash dedup |
| R11 | AuditLog/PostgresStore constructors accept unvalidated schema | MEDIUM | Constructors call `validateIdentifier(schema)` |
| | | | |
| **Operational Security (Security Architect)** | | |
| F1 | JWT secret rotation causes hard outage | HIGH | Dual-secret verify: `JWT_SECRET` + optional `JWT_SECRET_PREVIOUS` |
| F2 | OAuth state lost on server restart | HIGH | Move to Postgres `oauth_pending` table with TTL |
| F3 | Code doesn't match stated fix for webhook timing | MEDIUM | Replace hand-rolled XOR with `crypto.timingSafeEqual` |
| F4 | Empty permissions before first sync | HIGH | Return 503 with `Retry-After` until first sync completes |
| F5 | No pagination limit on GitLab API | MEDIUM | `maxPages: 50` param on `paginatedGet()` |
| F6 | Audit log PII without retention policy | MEDIUM | 90-day retention cron + `pseudonymize_user()` for GDPR |
| F7 | npm deps use caret ranges | MEDIUM | Pin exact versions, commit lockfile, add `npm audit` to CI |
| F8 | No GDPR right-to-erasure | MEDIUM | `DELETE /admin/users/:userId` — purge all user data across tables + graph |
| F9 | GitLab token encryption key same as JWT secret | LOW | Separate `GITLAB_TOKEN_ENCRYPTION_KEY` env var |
| F10 | Docker image tag not digest-pinned | LOW | Pin `FROM apache/age@sha256:<digest>` |
| | | | |
| **Consistency Fixes (QA)** | | |
| C1 | `GitLabClient` constructor: test uses `allowInsecure`, impl uses `requireHttps` | IMPORTANT | Align to `allowInsecure` with HTTPS-by-default |
| C2 | `GraphLayer` missing methods: `removeMembership`, `removeGroup` | IMPORTANT | Task 5 must define full interface |
| C3 | Resolution matrix has v1 task numbers, not v2 | IMPORTANT | Update all references |
| C4 | `pool.ts` in structure but never created | MINOR | Remove from structure, keep inline in server.ts |
| C5 | `src/gitlab/cli/sync.ts` referenced in Task 16 but never created | IMPORTANT | Add to Task 8 or Task 16 |
| C6 | G2 (namespaced user IDs) stated but not implemented in sync/webhook code | IMPORTANT | Implement `${orgId}:${username}` in Task 8/9 code |
| C7 | `handleSubgroupCreate` passes `'unknown'` as orgId | MINOR | Pass `config.org_id` from constructor |
| C8 | GitLab OAuth app registration not in DROPLET-SETUP.md | IMPORTANT | Add GITLAB-SETUP.md section |
| C9 | No tests for: GitLab unreachable, DB failures, malformed MCP, token refresh failure, concurrent sessions | IMPORTANT | Add to Task 14 security test suite |
| C10 | GitLab config fields should be optional with `gitlab_enabled` flag for dev mode | MINOR | Add `gitlab_enabled: z.boolean().default(false)` |
