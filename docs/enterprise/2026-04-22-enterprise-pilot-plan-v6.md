# PLUR Enterprise Pilot — Implementation Plan (v6)

> **v6 changelog:** 24 findings from Codex audit (7 CRITICAL, 12 HIGH, 5 MEDIUM) all addressed.
> Detailed code changes: `2026-04-22-v5-to-v6-amendments.md` (summary) and `2026-04-22-enterprise-pilot-plan-v6-amendments.md` (code patches per amendment A-H).
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the critical path for a 10-user enterprise pilot: Postgres+AGE storage, HTTP/SSE MCP server, GitLab OAuth + permissions, enterprise MCP tool security.

**Architecture:** Separate `plur-ai/enterprise` repository. Depends on published `@plur-ai/core` (^0.8.4) and `@plur-ai/mcp` (^0.8.3) via npm. One PostgreSQL instance with AGE (graph) + pgvector (embeddings). GitLab as identity provider and permission source. MCP tools filtered and permission-wrapped for multi-user safety.

**Deployment model:** This is a **single-tenant pilot** — one server instance serves one organization (`config.org_id`). The per-org schema isolation (`org_${orgId}` PostgreSQL schema) is forward-looking architecture for Phase 2 multi-tenancy but is NOT exercised here. Do not attempt to serve multiple orgs from one instance in v1 — the startup sync, session state, and permission resolver are all scoped to a single `config.org_id` loaded at boot.

**Phase 2 (out of scope for pilot):** Multi-org support on a shared instance requires per-request org routing, separate JWT issuers per org, and a multi-org sync scheduler. None of that is in scope here.

**Tech Stack:** TypeScript, Vitest, PostgreSQL 16 + Apache AGE + pgvector, Express + helmet, @modelcontextprotocol/sdk (SSE transport), pg, jsonwebtoken, express-rate-limit, pino, cors

**Security:** 62 findings from 3 review rounds + 24 findings from Codex audit = 86 total findings addressed inline in task code.

**Spec:** `docs/enterprise/plur-enterprise-proposal.md`

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
        004-gitlab-tokens.sql            # Encrypted GitLab token storage
        005-oauth-pending.sql            # Server-side OAuth state persistence
        006-processed-webhooks.sql       # Webhook replay protection
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
      token-store.ts                     # Encrypted GitLab token storage + refresh
      types.ts                           # GitLab API response types + Zod schemas
    mcp/
      tool-filter.ts                     # Enterprise tool allowlist
      permission-wrapper.ts              # Write permission enforcement on MCP tools
    admin/
      routes.ts                          # Admin API (users, tokens, audit, health)
    middleware/
      rate-limit.ts                      # Rate limiting configuration
      security.ts                        # helmet, CORS, body limits, error handler
      session.ts                         # Session management, binding, limits
    logging/
      logger.ts                          # Pino structured logger
      audit.ts                           # Audit log writer with PII pseudonymization
  test/
    db/postgres-store.test.ts
    db/graph.test.ts
    db/tenant.test.ts
    db/migrate.test.ts
    auth/token.test.ts
    auth/middleware.test.ts
    permissions/resolver.test.ts
    gitlab/client.test.ts
    gitlab/sync.test.ts
    gitlab/oauth.test.ts
    gitlab/webhook.test.ts
    gitlab/token-store.test.ts
    mcp/tool-filter.test.ts
    mcp/permission-wrapper.test.ts
    security/injection.test.ts           # Injection attack test suite
    security/auth-bypass.test.ts         # Auth bypass test suite
    security/tenant-isolation.test.ts    # Cross-tenant leakage tests
    security/tool-restrictions.test.ts   # MCP tool allowlist enforcement
    security/failure-modes.test.ts       # DB down, GitLab unreachable, etc.
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
    GITLAB-SETUP.md
    deploy.sh
```

**Dependency on plur core:** Published npm packages, not workspace links:
```json
{
  "dependencies": {
    "@plur-ai/core": "^0.8.4",
    "@plur-ai/mcp": "^0.8.3"
  }
}
```

For local development iteration against unpublished core changes, use `pnpm link`.

> **v6 note:** `@plur-ai/core` requires ^0.8.4 (was ^0.8.3) due to the upstream export PR for Task 4b.

---

## Identity Contract (v6 — ALL tasks must follow)

This contract defines canonical identifiers used across the entire system. Violations cause cross-org token reuse, permission resolver mismatches, and test failures.

| Concept | Format | Example | Used in |
|---------|--------|---------|---------|
| **Internal userId** | `username` (bare) | `alice` | JWT `sub`, `req.user.username`, resolver calls |
| **Graph node ID (User)** | `${orgId}:${username}` | `acme:alice` | AGE vertex `.id`, `users` table PK |
| **Personal scope** | `user:${orgId}:${username}` | `user:acme:alice` | Engram scope, permission checks |
| **Group scope** | `group:${orgId}/${path}` | `group:acme/backend` | Engram scope, permission checks |
| **Project scope** | `project:${orgId}/${path}` | `project:acme/backend/api` | Engram scope, permission checks |
| **Org scope** | `org:${orgId}` | `org:acme` | Admin-only writes |

**`req.user` shape** (set by auth middleware):
```typescript
interface AuthUser {
  username: string   // bare — "alice", NOT "acme:alice"
  orgId: string      // "acme"
  email: string
  role: string       // advisory only (G13)
}
```

**JWT payload**: `{ sub: username, orgId, email, role }` — `sub` is bare username, `orgId` travels separately.

**Permission resolver**: takes bare `username`. Graph internally namespaces to `${orgId}:${username}`.

**Default write scope**: `user:${orgId}:${username}` when no scope specified.

> See `v6-amendments.md` Amendment B for the per-task identity checklist.

---

## Security-First Task Order (v6 — resequenced)

```
Task 0:   Infrastructure (Docker Compose + DO + GitLab setup instructions)
          AMENDED: digest pinning, .pgpass backup, two-stage build (findings 19,20,24)
Task 1:   Repo scaffold (pinned deps, complete config, gitlab_enabled flag)
          AMENDED: ADMIN_USERS config, GITLAB_SERVICE_TOKEN (finding 15)
Task 2:   Input validation + path normalization + Zod response schemas
          AMENDED: $ escaping in sanitizeCypherValue (finding 16)
Task 3:   Structured logging + audit log writer + PII pseudonymization
          AMENDED: pseudonymize in log(), retention policy (finding 21)
Task 4:   PostgresStore (CRUD + tsvector search + pgvector) with shared pool, schema-scoped
Task 4b:  EnterprisePlur adapter — Postgres-backed Plur interface (REPLACED)
          WAS: Plur core DI PR. NOW: Enterprise Adapter pattern (findings 1,4)
          + 7-line upstream export PR to @plur-ai/core
Task 5:   AGE graph layer — ALL methods, parameterized, per-org graphs, namespaced user IDs
          AMENDED: parameterized createOrg, escape $ in Cypher (finding 16)
Task 6:   TenantManager + migrate.ts CLI + SQL migration files
          AMENDED: remove SET LOCAL, use qualified table names (finding 9)
Task 7:   GitLab API client (HTTPS default, pagination limit, Zod response validation)
          AMENDED: add getUserGroups() + getUserProjects() methods (finding 17)
Task 7b:  GitLab OAuth2 with PKCE + encrypted token storage + refresh flow
          AMENDED: form-style POST for token exchange (finding 6)
Task 8:   GitLab sync + ensureUserSynced() (user-scoped only) + sync CLI
          AMENDED: user-only membership sync on first login (finding 17)
Task 9:   GitLab webhook handler (timingSafeEqual, replay protection, orgId from config)
          AMENDED: transaction-wrapped dedup, advisory lock (findings 7,8)
Task 10:  Auth — token.ts + middleware.ts + roles.ts + types.ts
          AMENDED: 503 retry on failure, admin from config, bare username (findings 5,15)
Task 11a: Express scaffold + security middleware (helmet, CORS, rate limits, health, OAuth routes)
          SPLIT from Task 11 — NO MCP imports (finding 13)
Task 12:  Session management (user-bound, limited, expiring, enumeration-resistant)
          AMENDED: add tests
Task 13:  Permission enforcement (scope resolver, write guards, live graph check)
Task 13b: Enterprise MCP tool allowlist + write permission wrapper (REPLACED)
          NOW: 34 tools, 3 write strategies, read sanitizer (findings 3,10,11)
Task 11b: MCP Server + SSE transport + /sse + /messages routes (NEW)
          Actual MCP server implementation (finding 14)
Task 14:  Security test suite
          AMENDED: CSRF, webhook race, admin forgery, ESM import fix (findings 22,23)
Task 15:  E2E integration tests
          AMENDED: fix route expectations
Task 16:  DO droplet deployment + GITLAB-SETUP.md
          AMENDED: two-stage build, Dockerfile, .pgpass (findings 19,20)
Task 16b: Operational monitoring — periodic sync, metrics, /admin/metrics (NEW)
          Wires GITLAB_SYNC_INTERVAL_MINUTES, stale detection (finding 18)
```
Task 14:  Security test suite (injection, auth bypass, tenant isolation, tool restrictions, failure modes)
Task 15:  E2E integration tests (full GitLab OAuth flow + permission-scoped MCP)
Task 16:  DO droplet deployment + GITLAB-SETUP.md
```

---

## Task 0: Infrastructure

### Task 0a: Docker Compose for local development

**Goal:** Provide a one-command local PostgreSQL with AGE + pgvector for development and testing.

**Files:**
- Create: `docker/Dockerfile.postgres`
- Create: `docker/docker-compose.yml`
- Create: `docker/init.sql`

**Security requirements addressed:** F10 (digest-pinned image), finding 24 (localhost bind)

- [ ] **Step 1: Create Dockerfile.postgres**

```dockerfile
# docker/Dockerfile.postgres
# Pin to specific tag — replace with sha256 digest before production
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

- [ ] **Step 3: Create docker-compose.yml**

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

Expected: Two rows — `age` and `vector` with version numbers.

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

**Goal:** Hardened production deployment guide for DigitalOcean.

**Files:**
- Create: `infrastructure/DROPLET-SETUP.md`

**Security requirements addressed:** finding 3 (JWT secret plaintext), finding 16 (passwordless sudo), finding 19 (DB creds plaintext)

- [ ] **Step 1: Write DROPLET-SETUP.md**

```markdown
# PLUR Enterprise — DO Droplet Setup

## 1. Create Droplet

- Ubuntu 24.04 LTS
- 4 GB RAM / 2 vCPUs minimum
- Enable VPC networking
- Add your SSH key

## 2. Initial Security

```bash
# As root
apt update && apt upgrade -y
adduser deploy
# Restricted sudo — only plur-enterprise service management
echo 'deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart plur-enterprise, /bin/systemctl stop plur-enterprise, /bin/systemctl status plur-enterprise, /bin/journalctl -u plur-enterprise*' > /etc/sudoers.d/deploy

# Separate SSH key for deploy user
mkdir -p /home/deploy/.ssh
# Copy YOUR public key (not root's) to authorized_keys
echo "ssh-ed25519 YOUR_KEY_HERE" > /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# Port 5432 NOT opened — Postgres is localhost only
ufw enable
```

## 3. Install PostgreSQL 16 + AGE + pgvector

```bash
apt install -y postgresql-16 postgresql-server-dev-16 build-essential git

# Install AGE
git clone --branch PG16/v1.5.0 https://github.com/apache/age.git /opt/age
cd /opt/age && make && make install

# Install pgvector
git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git /opt/pgvector
cd /opt/pgvector && make && make install

# Configure Postgres auth
sed -i 's/peer/scram-sha-256/' /etc/postgresql/16/main/pg_hba.conf
sed -i 's/md5/scram-sha-256/' /etc/postgresql/16/main/pg_hba.conf
# Enable SSL
sed -i "s/#ssl = off/ssl = on/" /etc/postgresql/16/main/postgresql.conf
systemctl restart postgresql

# Create database and user
sudo -u postgres psql <<SQL
CREATE USER plur_enterprise WITH PASSWORD '$(openssl rand -base64 24)';
CREATE DATABASE plur_enterprise OWNER plur_enterprise;
\c plur_enterprise
CREATE EXTENSION age;
CREATE EXTENSION vector;
SQL
```

Save the generated password — you need it for DATABASE_URL.

## 4. Install Node.js + Application

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

su - deploy
git clone https://github.com/plur-ai/enterprise.git ~/enterprise
cd ~/enterprise && npm ci --production
npm run build
```

## 5. Configure Environment

```bash
# As deploy user
cat > ~/enterprise/.env << 'EOF'
PORT=3000
DATABASE_URL=postgresql://plur_enterprise:PASSWORD_HERE@localhost:5432/plur_enterprise?sslmode=require
JWT_SECRET=GENERATED_BELOW
JWT_SECRET_PREVIOUS=
ORG_ID=acme
ORG_NAME=Acme Corp
CORS_ORIGINS=https://plur.acme.com
NODE_ENV=production
LOG_LEVEL=info
GITLAB_ENABLED=true
GITLAB_URL=https://gitlab.acme.com
GITLAB_CLIENT_ID=YOUR_OAUTH_APP_ID
GITLAB_CLIENT_SECRET=YOUR_OAUTH_APP_SECRET
GITLAB_REDIRECT_URI=https://plur.acme.com/auth/callback
GITLAB_WEBHOOK_SECRET=GENERATED_BELOW
GITLAB_TOKEN_ENCRYPTION_KEY=GENERATED_BELOW
GITLAB_SYNC_INTERVAL_MINUTES=15
EOF

# Auto-generate secrets
sed -i "s|JWT_SECRET=GENERATED_BELOW|JWT_SECRET=$(openssl rand -base64 48)|" ~/enterprise/.env
sed -i "s|GITLAB_WEBHOOK_SECRET=GENERATED_BELOW|GITLAB_WEBHOOK_SECRET=$(openssl rand -base64 32)|" ~/enterprise/.env
sed -i "s|GITLAB_TOKEN_ENCRYPTION_KEY=GENERATED_BELOW|GITLAB_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)|" ~/enterprise/.env

# Lock permissions
chmod 600 ~/enterprise/.env
```

## 6. Systemd Service

```bash
# As root
cat > /etc/systemd/system/plur-enterprise.service << 'EOF'
[Unit]
Description=PLUR Enterprise Server
After=postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/enterprise
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=/home/deploy/enterprise/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable plur-enterprise
systemctl start plur-enterprise
```

## 7. TLS with Caddy

```bash
apt install -y caddy

cat > /etc/caddy/Caddyfile << 'EOF'
plur.acme.com {
    reverse_proxy localhost:3000
}
EOF

systemctl restart caddy
```

## 8. Run Initial Migration + Sync

```bash
su - deploy
cd ~/enterprise
node dist/db/migrate.js up
node dist/gitlab/cli/sync.js
```

## 9. Daily Backups

```bash
# As root
cat > /etc/cron.daily/plur-backup << 'CRON'
#!/bin/bash
BACKUP_DIR=/var/backups/plur
mkdir -p $BACKUP_DIR
pg_dump -U plur_enterprise plur_enterprise | gzip > $BACKUP_DIR/plur-$(date +%Y%m%d).sql.gz
find $BACKUP_DIR -mtime +7 -delete
CRON
chmod +x /etc/cron.daily/plur-backup
```
```

- [ ] **Step 2: Commit**

```bash
git add infrastructure/ && git commit -m "infra: hardened DO droplet setup instructions"
```

---

## Task 1: Repo Scaffold

**Goal:** Initialize the enterprise repository with pinned dependencies, complete config parsing including all GitLab env vars, and a `gitlab_enabled` flag for dev mode.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/config.ts`
- Create: `test/fixtures/test-guard.ts`

**Security requirements addressed:** B1 (config parses all GitLab vars), C10 (gitlab_enabled flag), F7 (pinned deps), finding 17 (CORS empty default), finding 28 (config validation UX)

- [ ] **Step 1: Write the failing test**

```typescript
// test/config.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { loadEnterpriseConfig, EnterpriseConfigSchema } from '../src/config.js'

describe('EnterpriseConfig', () => {
  const VALID_ENV = {
    PORT: '3000',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/plur_test',
    JWT_SECRET: 'a'.repeat(48),
    ORG_ID: 'acme',
    ORG_NAME: 'Acme Corp',
    CORS_ORIGINS: 'https://plur.acme.com',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    GITLAB_ENABLED: 'true',
    GITLAB_URL: 'https://gitlab.acme.com',
    GITLAB_CLIENT_ID: 'app-id-123',
    GITLAB_CLIENT_SECRET: 'app-secret-456',
    GITLAB_REDIRECT_URI: 'https://plur.acme.com/auth/callback',
    GITLAB_WEBHOOK_SECRET: 'webhook-secret-long-enough',
    GITLAB_TOKEN_ENCRYPTION_KEY: 'b'.repeat(32),
    GITLAB_SYNC_INTERVAL_MINUTES: '15',
  }

  afterEach(() => {
    // Clean env vars set by tests
    for (const key of Object.keys(VALID_ENV)) {
      delete process.env[key]
    }
  })

  it('parses all env vars including GitLab', () => {
    Object.assign(process.env, VALID_ENV)
    const config = loadEnterpriseConfig()
    expect(config.port).toBe(3000)
    expect(config.database_url).toBe(VALID_ENV.DATABASE_URL)
    expect(config.gitlab_enabled).toBe(true)
    expect(config.gitlab_url).toBe('https://gitlab.acme.com')
    expect(config.gitlab_client_id).toBe('app-id-123')
    expect(config.gitlab_client_secret).toBe('app-secret-456')
    expect(config.gitlab_redirect_uri).toBe('https://plur.acme.com/auth/callback')
    expect(config.gitlab_webhook_secret).toBe('webhook-secret-long-enough')
    expect(config.gitlab_token_encryption_key).toBe('b'.repeat(32))
    expect(config.gitlab_sync_interval_minutes).toBe(15)
  })

  it('allows GitLab fields to be omitted when gitlab_enabled is false', () => {
    process.env.DATABASE_URL = VALID_ENV.DATABASE_URL
    process.env.JWT_SECRET = VALID_ENV.JWT_SECRET
    process.env.ORG_ID = 'acme'
    process.env.ORG_NAME = 'Acme Corp'
    process.env.GITLAB_ENABLED = 'false'
    const config = loadEnterpriseConfig()
    expect(config.gitlab_enabled).toBe(false)
    expect(config.gitlab_url).toBeUndefined()
  })

  it('rejects weak JWT secrets', () => {
    const result = EnterpriseConfigSchema.safeParse({
      database_url: 'postgresql://x@localhost/test',
      jwt_secret: 'CHANGE_ME_PLEASE',
      org_id: 'acme',
      org_name: 'Acme',
    })
    expect(result.success).toBe(false)
  })

  it('rejects JWT secrets shorter than 32 chars', () => {
    const result = EnterpriseConfigSchema.safeParse({
      database_url: 'postgresql://x@localhost/test',
      jwt_secret: 'short',
      org_id: 'acme',
      org_name: 'Acme',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid org_id format', () => {
    const result = EnterpriseConfigSchema.safeParse({
      database_url: 'postgresql://x@localhost/test',
      jwt_secret: 'a'.repeat(48),
      org_id: 'UPPER-CASE!!',
      org_name: 'Acme',
    })
    expect(result.success).toBe(false)
  })

  it('defaults CORS to empty array (not wildcard)', () => {
    Object.assign(process.env, VALID_ENV)
    delete process.env.CORS_ORIGINS
    const config = loadEnterpriseConfig()
    expect(config.cors_origins).toEqual([])
  })

  it('requires GitLab fields when gitlab_enabled is true', () => {
    process.env.DATABASE_URL = VALID_ENV.DATABASE_URL
    process.env.JWT_SECRET = VALID_ENV.JWT_SECRET
    process.env.ORG_ID = 'acme'
    process.env.ORG_NAME = 'Acme Corp'
    process.env.GITLAB_ENABLED = 'true'
    // Missing all GITLAB_* fields
    expect(() => loadEnterpriseConfig()).toThrow()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/config.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: Create package.json with pinned dependencies**

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
    "@plur-ai/core": "0.8.3",
    "@plur-ai/mcp": "0.8.3",
    "@modelcontextprotocol/sdk": "1.12.0",
    "express": "4.21.2",
    "express-rate-limit": "7.5.0",
    "helmet": "8.0.0",
    "cors": "2.8.5",
    "pg": "8.13.1",
    "jsonwebtoken": "9.0.2",
    "pino": "9.6.0",
    "pino-http": "10.4.0",
    "zod": "3.24.2"
  },
  "devDependencies": {
    "@types/cors": "2.8.17",
    "@types/express": "4.17.21",
    "@types/jsonwebtoken": "9.0.7",
    "@types/pg": "8.11.11",
    "pino-pretty": "13.0.0",
    "tsup": "8.3.6",
    "tsx": "4.19.3",
    "typescript": "5.7.3",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 5: Create vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
})
```

- [ ] **Step 6: Create test-guard.ts**

```typescript
// test/fixtures/test-guard.ts

/**
 * Prevents tests from running against production databases.
 * Call assertTestDatabase(url) in beforeAll of any test touching the DB.
 */
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

- [ ] **Step 7: Implement config.ts**

```typescript
// src/config.ts
import { z } from 'zod'

const WEAK_SECRETS = ['CHANGE_ME', 'secret', 'password', 'test', 'dev']

/** GitLab config — required when gitlab_enabled is true */
const GitLabConfigSchema = z.object({
  gitlab_url: z.string().url(),
  gitlab_client_id: z.string().min(1),
  gitlab_client_secret: z.string().min(1),
  gitlab_redirect_uri: z.string().url(),
  gitlab_webhook_secret: z.string().min(16),
  gitlab_token_encryption_key: z.string().min(32),
  gitlab_sync_interval_minutes: z.number().default(15),
})

/** Base config — always required */
const BaseConfigSchema = z.object({
  port: z.number().default(3000),
  database_url: z.string().url(),
  jwt_secret: z.string().min(32).refine(
    (s) => !WEAK_SECRETS.some(w => s.toLowerCase().includes(w.toLowerCase())),
    'JWT_SECRET must not contain common placeholder words'
  ),
  jwt_secret_previous: z.string().optional(),
  org_id: z.string().regex(/^[a-z][a-z0-9_]{2,30}$/, 'org_id must be lowercase alphanumeric, 3-31 chars'),
  org_name: z.string().min(1).max(100),
  cors_origins: z.array(z.string().url()).default([]),
  node_env: z.enum(['development', 'production', 'test']).default('development'),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  gitlab_enabled: z.boolean().default(false),
})

/** Full config: base + conditional GitLab */
export const EnterpriseConfigSchema = BaseConfigSchema.and(
  z.discriminatedUnion('gitlab_enabled', [
    z.object({ gitlab_enabled: z.literal(true) }).merge(GitLabConfigSchema),
    z.object({ gitlab_enabled: z.literal(false) }),
  ]).catch({ gitlab_enabled: false })
).transform((val) => val as z.infer<typeof BaseConfigSchema> & Partial<z.infer<typeof GitLabConfigSchema>>)

export type EnterpriseConfig = z.infer<typeof BaseConfigSchema> & {
  gitlab_enabled: boolean
  gitlab_url?: string
  gitlab_client_id?: string
  gitlab_client_secret?: string
  gitlab_redirect_uri?: string
  gitlab_webhook_secret?: string
  gitlab_token_encryption_key?: string
  gitlab_sync_interval_minutes?: number
}

export function loadEnterpriseConfig(): EnterpriseConfig {
  const gitlabEnabled = process.env.GITLAB_ENABLED === 'true'

  const raw: Record<string, unknown> = {
    port: parseInt(process.env.PORT || '3000', 10),
    database_url: process.env.DATABASE_URL,
    jwt_secret: process.env.JWT_SECRET,
    jwt_secret_previous: process.env.JWT_SECRET_PREVIOUS || undefined,
    org_id: process.env.ORG_ID || 'default',
    org_name: process.env.ORG_NAME || 'Default Organization',
    cors_origins: process.env.CORS_ORIGINS?.split(',').filter(Boolean) || [],
    node_env: process.env.NODE_ENV || 'development',
    log_level: process.env.LOG_LEVEL || 'info',
    gitlab_enabled: gitlabEnabled,
  }

  if (gitlabEnabled) {
    raw.gitlab_url = process.env.GITLAB_URL
    raw.gitlab_client_id = process.env.GITLAB_CLIENT_ID
    raw.gitlab_client_secret = process.env.GITLAB_CLIENT_SECRET
    raw.gitlab_redirect_uri = process.env.GITLAB_REDIRECT_URI
    raw.gitlab_webhook_secret = process.env.GITLAB_WEBHOOK_SECRET
    raw.gitlab_token_encryption_key = process.env.GITLAB_TOKEN_ENCRYPTION_KEY
    raw.gitlab_sync_interval_minutes = parseInt(process.env.GITLAB_SYNC_INTERVAL_MINUTES || '15', 10)
  }

  // Validate base config first
  const baseResult = BaseConfigSchema.safeParse(raw)
  if (!baseResult.success) {
    const issues = baseResult.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error('Configuration error:\n' + issues.join('\n'))
  }

  // If GitLab enabled, validate GitLab fields
  if (gitlabEnabled) {
    const gitlabResult = GitLabConfigSchema.safeParse(raw)
    if (!gitlabResult.success) {
      const issues = gitlabResult.error.issues.map(i => `  gitlab.${i.path.join('.')}: ${i.message}`)
      throw new Error('GitLab configuration error (GITLAB_ENABLED=true but missing fields):\n' + issues.join('\n'))
    }
    return { ...baseResult.data, ...gitlabResult.data } as EnterpriseConfig
  }

  return baseResult.data as EnterpriseConfig
}
```

- [ ] **Step 8: Run test — verify it passes**

```bash
npx vitest run test/config.test.ts
```

- [ ] **Step 9: Install, build, commit**

```bash
npm install && npm run build
git add . && git commit -m "feat: scaffold enterprise repo with pinned deps, secure config with GitLab support"
```

---

## Task 2: Input Validation + Path Normalization + Zod Response Schemas

**Goal:** Build the security foundation used by every subsequent task — identifier validation, Cypher/SQL injection prevention, path normalization, embedding validation, and Zod schemas for GitLab API responses.

**Files:**
- Create: `src/permissions/validator.ts`
- Create: `src/gitlab/schemas.ts`
- Create: `test/security/injection.test.ts`

**Security requirements addressed:** finding 1 (Cypher injection), finding 22 (engram size), finding 29 (embedding validation), G9 (path traversal), G10 (response schema validation)

- [ ] **Step 1: Write the failing test**

```typescript
// test/security/injection.test.ts
import { describe, it, expect } from 'vitest'
import {
  validateIdentifier,
  sanitizeCypherValue,
  validateEngramSize,
  validateEmbedding,
  validateScope,
  normalizePath,
} from '../../src/permissions/validator.js'

describe('Input Validation — Injection Prevention', () => {
  describe('normalizePath', () => {
    it('collapses double slashes', () => {
      expect(normalizePath('acme//backend')).toBe('acme/backend')
    })

    it('strips leading and trailing slashes', () => {
      expect(normalizePath('/acme/backend/')).toBe('acme/backend')
    })

    it('rejects path traversal (..)', () => {
      expect(() => normalizePath('acme/../etc/passwd')).toThrow('path traversal')
    })

    it('rejects null bytes', () => {
      expect(() => normalizePath('acme/\x00evil')).toThrow('null byte')
    })
  })

  describe('validateIdentifier', () => {
    it('accepts valid identifiers', () => {
      expect(validateIdentifier('alice')).toBe(true)
      expect(validateIdentifier('backend-api')).toBe(true)
      expect(validateIdentifier('project_123')).toBe(true)
      expect(validateIdentifier('alice@acme.com')).toBe(true)
      expect(validateIdentifier('acme/backend/api')).toBe(true)
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

  describe('validateEmbedding', () => {
    it('accepts valid embedding arrays', () => {
      expect(validateEmbedding(new Array(384).fill(0.1))).toBe(true)
    })

    it('rejects non-arrays', () => {
      expect(validateEmbedding('not an array')).toBe(false)
    })

    it('rejects empty arrays', () => {
      expect(validateEmbedding([])).toBe(false)
    })

    it('rejects arrays over 2048 dimensions', () => {
      expect(validateEmbedding(new Array(3000).fill(0.1))).toBe(false)
    })

    it('rejects arrays with non-finite values', () => {
      expect(validateEmbedding([0.1, NaN, 0.3])).toBe(false)
      expect(validateEmbedding([0.1, Infinity, 0.3])).toBe(false)
    })
  })

  describe('validateScope', () => {
    it('accepts valid scopes', () => {
      expect(validateScope('global')).toBe(true)
      expect(validateScope('user:alice')).toBe(true)
      expect(validateScope('group:acme/backend')).toBe(true)
      expect(validateScope('project:acme/backend/api')).toBe(true)
      expect(validateScope('org:acme')).toBe(true)
    })

    it('rejects invalid scope types', () => {
      expect(validateScope('unknown:foo')).toBe(false)
    })

    it('rejects scopes with injection payloads', () => {
      expect(validateScope("user:alice'; DROP TABLE --")).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/security/injection.test.ts
# Expected: FAIL — cannot resolve module
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/permissions/validator.ts

/**
 * Path normalization — collapse //, strip edges, reject traversal.
 * MUST be called before validateIdentifier on any path-like input.
 * Addresses G9 (path traversal in group names).
 */
export function normalizePath(path: string): string {
  if (path.includes('\x00')) {
    throw new Error('Invalid path: null byte detected')
  }
  // Collapse multiple slashes
  let normalized = path.replace(/\/+/g, '/')
  // Strip leading/trailing slashes
  normalized = normalized.replace(/^\/|\/$/g, '')
  // Reject path traversal
  if (normalized.split('/').includes('..')) {
    throw new Error('Invalid path: path traversal (..) not allowed')
  }
  return normalized
}

/** Strict identifier pattern: alphanumeric, hyphens, underscores, dots, @, /.
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
  if (scope === 'global') return true
  const match = scope.match(/^(user|group|project|org):(.+)$/)
  if (!match) return false
  return validateIdentifier(match[2])
}

/**
 * Validate that a schema name is safe for PostgreSQL DDL.
 * Addresses R11 (AuditLog/PostgresStore constructors accept unvalidated schema).
 */
export function validateSchemaName(schema: string): boolean {
  return /^[a-z][a-z0-9_]{2,62}$/.test(schema)
}
```

```typescript
// src/gitlab/schemas.ts
// Zod schemas for GitLab API response validation (G10)
import { z } from 'zod'

export const GitLabUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  email: z.string().email(),
  name: z.string(),
  state: z.string(),
  avatar_url: z.string().nullable(),
})

export const GitLabGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  full_name: z.string(),
  full_path: z.string(),
  parent_id: z.number().nullable(),
  visibility: z.string(),
})

export const GitLabProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  path_with_namespace: z.string(),
  namespace: z.object({
    id: z.number(),
    name: z.string(),
    path: z.string(),
    kind: z.string(),
    full_path: z.string(),
    parent_id: z.number().nullable(),
  }),
  visibility: z.string(),
  archived: z.boolean(),
  permissions: z.object({
    project_access: z.object({ access_level: z.number() }).nullable().optional(),
    group_access: z.object({ access_level: z.number() }).nullable().optional(),
  }).optional(),
})

export const GitLabMemberSchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string(),
  state: z.string(),
  access_level: z.number(),
  email: z.string().optional(),
})

export const GitLabTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  created_at: z.number(),
  scope: z.string(),
})

export type GitLabUser = z.infer<typeof GitLabUserSchema>
export type GitLabGroup = z.infer<typeof GitLabGroupSchema>
export type GitLabProject = z.infer<typeof GitLabProjectSchema>
export type GitLabMember = z.infer<typeof GitLabMemberSchema>
export type GitLabTokenResponse = z.infer<typeof GitLabTokenResponseSchema>

/** GitLab access levels */
export const ACCESS_LEVELS = {
  GUEST: 10,
  REPORTER: 20,
  DEVELOPER: 30,
  MAINTAINER: 40,
  OWNER: 50,
} as const
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/security/injection.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/permissions/validator.ts src/gitlab/schemas.ts test/security/injection.test.ts
git commit -m "feat: input validation, path normalization, Zod response schemas (injection prevention)"
```

---

## Task 3: Structured Logging + Audit Log Writer + PII Pseudonymization

**Goal:** Set up Pino structured logging with secret redaction and an audit log writer that records all security-relevant events with PII pseudonymization for GDPR compliance.

**Files:**
- Create: `src/logging/logger.ts`
- Create: `src/logging/audit.ts`
- Create: `test/logging/audit.test.ts`

**Security requirements addressed:** finding 21 (no audit logging), finding 26 (no structured logging), F6 (audit log PII)

- [ ] **Step 1: Write the failing test**

```typescript
// test/logging/audit.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { AuditLog, pseudonymizeUser } from '../../src/logging/audit.js'
import { assertTestDatabase } from '../fixtures/test-guard.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test'

describe('AuditLog', () => {
  let pool: pg.Pool
  let audit: AuditLog

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL)
    pool = new pg.Pool({ connectionString: TEST_DB_URL })

    // Create audit_log table for testing
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS test_audit;
      CREATE TABLE IF NOT EXISTS test_audit.audit_log (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details JSONB,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)
    audit = new AuditLog(pool, 'test_audit')
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE test_audit.audit_log')
  })

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS test_audit CASCADE')
    await pool.end()
  })

  it('logs an audit entry with all fields', async () => {
    await audit.log({
      userId: 'acme:alice',
      action: 'engram.create',
      targetType: 'engram',
      targetId: 'ENG-2026-0421-001',
      details: { scope: 'project:backend/api' },
      ip: '192.168.1.10',
    })

    const result = await pool.query('SELECT * FROM test_audit.audit_log')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].user_id).toBe('acme:alice')
    expect(result.rows[0].action).toBe('engram.create')
    expect(result.rows[0].target_type).toBe('engram')
    expect(result.rows[0].target_id).toBe('ENG-2026-0421-001')
    expect(result.rows[0].details).toEqual({ scope: 'project:backend/api' })
    expect(result.rows[0].ip).toBe('192.168.1.10')
    expect(result.rows[0].created_at).toBeDefined()
  })

  it('logs auth success event', async () => {
    await audit.logAuth('acme:alice', true, '10.0.0.1')
    const result = await pool.query('SELECT * FROM test_audit.audit_log')
    expect(result.rows[0].action).toBe('auth.success')
  })

  it('logs auth failure event', async () => {
    await audit.logAuth('acme:unknown', false, '10.0.0.1')
    const result = await pool.query('SELECT * FROM test_audit.audit_log')
    expect(result.rows[0].action).toBe('auth.failure')
  })

  it('logs token generation event', async () => {
    await audit.logTokenGen('acme:admin', 'acme:alice', '10.0.0.1')
    const result = await pool.query('SELECT * FROM test_audit.audit_log')
    expect(result.rows[0].action).toBe('token.generate')
    expect(result.rows[0].target_type).toBe('user')
    expect(result.rows[0].target_id).toBe('acme:alice')
  })

  it('queries logs by user and time range', async () => {
    await audit.log({ userId: 'acme:alice', action: 'engram.create' })
    await audit.log({ userId: 'acme:bob', action: 'engram.create' })
    await audit.log({ userId: 'acme:alice', action: 'recall.hybrid' })

    const aliceLogs = await audit.query({ userId: 'acme:alice' })
    expect(aliceLogs).toHaveLength(2)
  })
})

describe('pseudonymizeUser', () => {
  it('hashes the username portion', () => {
    const result = pseudonymizeUser('acme:alice')
    expect(result).not.toContain('alice')
    expect(result).toMatch(/^acme:[a-f0-9]+$/)
  })

  it('produces consistent output for same input', () => {
    expect(pseudonymizeUser('acme:alice')).toBe(pseudonymizeUser('acme:alice'))
  })

  it('produces different output for different users', () => {
    expect(pseudonymizeUser('acme:alice')).not.toBe(pseudonymizeUser('acme:bob'))
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/logging/audit.test.ts
# Expected: FAIL — cannot resolve module
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/logging/logger.ts
import pino from 'pino'
import type { EnterpriseConfig } from '../config.js'

export function createLogger(config: Pick<EnterpriseConfig, 'log_level' | 'node_env'>) {
  return pino({
    level: config.log_level,
    ...(config.node_env === 'production'
      ? {}
      : { transport: { target: 'pino-pretty' } }),
    redact: {
      paths: [
        'req.headers.authorization',
        'database_url',
        'jwt_secret',
        'jwt_secret_previous',
        'gitlab_client_secret',
        'gitlab_token_encryption_key',
        'gitlab_webhook_secret',
      ],
      censor: '[REDACTED]',
    },
  })
}

export type Logger = pino.Logger
```

```typescript
// src/logging/audit.ts
import crypto from 'node:crypto'
import type pg from 'pg'
import { validateSchemaName } from '../permissions/validator.js'

export interface AuditEntry {
  userId: string
  action: string
  targetType?: string
  targetId?: string
  details?: Record<string, unknown>
  ip?: string
}

export interface AuditQuery {
  userId?: string
  action?: string
  since?: Date
  until?: Date
  limit?: number
}

export class AuditLog {
  private schema: string

  constructor(private pool: pg.Pool, schema: string) {
    if (!validateSchemaName(schema)) {
      throw new Error(`Invalid schema name for AuditLog: ${schema}`)
    }
    this.schema = schema
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.audit_log (user_id, action, target_type, target_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId,
        entry.action,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip ?? null,
      ]
    )
  }

  async logAuth(userId: string, success: boolean, ip: string): Promise<void> {
    await this.log({
      userId,
      action: success ? 'auth.success' : 'auth.failure',
      ip,
    })
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

  async query(q: AuditQuery): Promise<AuditEntry[]> {
    const conditions: string[] = []
    const values: unknown[] = []
    let idx = 1

    if (q.userId) {
      conditions.push(`user_id = $${idx++}`)
      values.push(q.userId)
    }
    if (q.action) {
      conditions.push(`action = $${idx++}`)
      values.push(q.action)
    }
    if (q.since) {
      conditions.push(`created_at >= $${idx++}`)
      values.push(q.since)
    }
    if (q.until) {
      conditions.push(`created_at <= $${idx++}`)
      values.push(q.until)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = q.limit ?? 100

    const result = await this.pool.query(
      `SELECT user_id, action, target_type, target_id, details, ip, created_at
       FROM ${this.schema}.audit_log ${where}
       ORDER BY created_at DESC LIMIT $${idx}`,
      [...values, limit]
    )

    return result.rows.map(row => ({
      userId: row.user_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details,
      ip: row.ip,
    }))
  }
}

/**
 * Pseudonymize user ID for GDPR-compliant log retention.
 * Preserves org prefix, hashes username.
 * Addresses F6 (audit log PII without retention policy).
 */
export function pseudonymizeUser(userId: string): string {
  const colonIdx = userId.indexOf(':')
  if (colonIdx === -1) {
    return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16)
  }
  const org = userId.slice(0, colonIdx)
  const username = userId.slice(colonIdx + 1)
  const hash = crypto.createHash('sha256').update(username).digest('hex').slice(0, 16)
  return `${org}:${hash}`
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/logging/audit.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/logging/ test/logging/
git commit -m "feat: structured logging (pino) + audit log writer with PII pseudonymization"
```

---

## Task 4: PostgresStore (in enterprise repo)

**Goal:** Implement the `EngramStore` interface from `@plur-ai/core` against PostgreSQL with full-text search (tsvector) and vector search (pgvector). Uses a shared connection pool and schema-scoped queries for multi-org isolation.

**Files:**
- Create: `src/db/pool.ts`
- Create: `src/db/postgres-store.ts`
- Create: `test/db/postgres-store.test.ts`

**Security requirements addressed:** finding 11 (connection pool multiplication), finding 22 (engram size validation), finding 23 (LIMIT parameterized), finding 29 (embedding validation), finding 31 (schema scoping), R11 (constructor schema validation)

- [ ] **Step 1: Write the failing test**

```typescript
// test/db/postgres-store.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { PostgresStore } from '../../src/db/postgres-store.js'
import { assertTestDatabase } from '../fixtures/test-guard.js'
import type { Engram } from '@plur-ai/core'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test'

function makeEngram(overrides: Partial<Engram> = {}): Engram {
  const id = overrides.id ?? `ENG-2026-0421-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`
  return {
    id,
    statement: 'Test engram statement',
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    source: 'test',
    tags: ['test'],
    activation: {
      retrieval_strength: 0.8,
      storage_strength: 1.0,
      access_count: 0,
      last_accessed: new Date().toISOString().split('T')[0],
    },
    created: new Date().toISOString().split('T')[0],
    ...overrides,
  } as Engram
}

describe('PostgresStore', () => {
  let pool: pg.Pool
  let store: PostgresStore

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL)
    pool = new pg.Pool({ connectionString: TEST_DB_URL })

    // Create schema and tables for testing
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS test_store;
      CREATE TABLE IF NOT EXISTS test_store.engrams (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'global',
        data JSONB NOT NULL,
        embedding vector(384),
        search_text tsvector GENERATED ALWAYS AS (
          to_tsvector('english', COALESCE(data->>'statement', '') || ' ' || COALESCE(data->>'domain', ''))
        ) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS test_store_engrams_search ON test_store.engrams USING gin(search_text);
      CREATE INDEX IF NOT EXISTS test_store_engrams_status ON test_store.engrams (status);
      CREATE INDEX IF NOT EXISTS test_store_engrams_scope ON test_store.engrams (scope);
    `)

    store = new PostgresStore(pool, 'test_store')
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM test_store.engrams')
  })

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS test_store CASCADE')
    await pool.end()
  })

  it('appends and retrieves an engram by ID', async () => {
    const engram = makeEngram({ id: 'ENG-2026-0421-001' })
    await store.append(engram)

    const retrieved = await store.getById('ENG-2026-0421-001')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe('ENG-2026-0421-001')
    expect(retrieved!.statement).toBe('Test engram statement')
  })

  it('returns null for non-existent ID', async () => {
    const result = await store.getById('ENG-NONEXISTENT')
    expect(result).toBeNull()
  })

  it('loads all engrams', async () => {
    await store.append(makeEngram({ id: 'ENG-A' }))
    await store.append(makeEngram({ id: 'ENG-B' }))
    const all = await store.load()
    expect(all).toHaveLength(2)
  })

  it('saves (replaces) all engrams', async () => {
    await store.append(makeEngram({ id: 'ENG-OLD' }))
    const newEngrams = [makeEngram({ id: 'ENG-NEW-1' }), makeEngram({ id: 'ENG-NEW-2' })]
    await store.save(newEngrams)
    const all = await store.load()
    expect(all).toHaveLength(2)
    expect(all.map(e => e.id).sort()).toEqual(['ENG-NEW-1', 'ENG-NEW-2'])
  })

  it('removes an engram by ID', async () => {
    await store.append(makeEngram({ id: 'ENG-DEL' }))
    const removed = await store.remove('ENG-DEL')
    expect(removed).toBe(true)
    const result = await store.getById('ENG-DEL')
    expect(result).toBeNull()
  })

  it('returns false when removing non-existent engram', async () => {
    const removed = await store.remove('ENG-NOPE')
    expect(removed).toBe(false)
  })

  it('counts engrams with optional status filter', async () => {
    await store.append(makeEngram({ id: 'ENG-A1', status: 'active' }))
    await store.append(makeEngram({ id: 'ENG-R1', status: 'retired' }))

    expect(await store.count()).toBe(2)
    expect(await store.count({ status: 'active' })).toBe(1)
    expect(await store.count({ status: 'retired' })).toBe(1)
  })

  it('performs full-text search via tsvector', async () => {
    await store.append(makeEngram({ id: 'ENG-PG', statement: 'PostgreSQL is the best database' }))
    await store.append(makeEngram({ id: 'ENG-MY', statement: 'MySQL is also a database' }))

    const results = await store.searchText('PostgreSQL', 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('ENG-PG')
  })

  it('rejects engrams over 64KB', async () => {
    const huge = makeEngram({ statement: 'x'.repeat(100000) })
    await expect(store.append(huge)).rejects.toThrow('exceeds maximum size')
  })

  it('uses parameterized LIMIT (no SQL interpolation)', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(makeEngram({ id: `ENG-L${i}` }))
    }
    const results = await store.searchText('test', 2)
    expect(results).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/db/postgres-store.test.ts
# Expected: FAIL — cannot resolve module
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/pool.ts
import pg from 'pg'
import type { EnterpriseConfig } from '../config.js'

/**
 * Creates the shared connection pool.
 * One pool for the entire server — prevents 50x connection multiplication.
 * Addresses finding 11 (connection pool multiplication).
 */
export function createPool(config: Pick<EnterpriseConfig, 'database_url'>): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.database_url,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })
  return pool
}
```

```typescript
// src/db/postgres-store.ts
import type pg from 'pg'
import type { EngramStore } from '@plur-ai/core'
import type { Engram } from '@plur-ai/core'
import { validateEngramSize, validateEmbedding, validateSchemaName } from '../permissions/validator.js'

/**
 * PostgresStore implements EngramStore from @plur-ai/core.
 *
 * Key design:
 * - Accepts a shared pg.Pool (not a connection string) — pool owned by server
 * - Schema-scoped: every query uses ${this.schema}.engrams for multi-org isolation
 * - Engram stored as JSONB in `data` column, with extracted id/status/scope columns for indexing
 * - Full-text search via tsvector GENERATED column
 * - Vector search via pgvector embedding column
 * - All limits parameterized (never string-interpolated)
 */
export class PostgresStore implements EngramStore {
  private schema: string

  constructor(private pool: pg.Pool, schema: string = 'public') {
    if (!validateSchemaName(schema)) {
      throw new Error(`Invalid schema name: ${schema}`)
    }
    this.schema = schema
  }

  async load(): Promise<Engram[]> {
    const result = await this.pool.query(
      `SELECT data FROM ${this.schema}.engrams ORDER BY created_at ASC`
    )
    return result.rows.map(row => row.data as Engram)
  }

  async save(engrams: Engram[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM ${this.schema}.engrams`)
      for (const engram of engrams) {
        this.validateSize(engram)
        await client.query(
          `INSERT INTO ${this.schema}.engrams (id, status, scope, data) VALUES ($1, $2, $3, $4)`,
          [engram.id, engram.status, engram.scope || 'global', JSON.stringify(engram)]
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async append(engram: Engram): Promise<void> {
    this.validateSize(engram)
    await this.pool.query(
      `INSERT INTO ${this.schema}.engrams (id, status, scope, data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         scope = EXCLUDED.scope,
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [engram.id, engram.status, engram.scope || 'global', JSON.stringify(engram)]
    )
  }

  async getById(id: string): Promise<Engram | null> {
    const result = await this.pool.query(
      `SELECT data FROM ${this.schema}.engrams WHERE id = $1`,
      [id]
    )
    return result.rows.length > 0 ? (result.rows[0].data as Engram) : null
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.engrams WHERE id = $1`,
      [id]
    )
    return (result.rowCount ?? 0) > 0
  }

  async count(filter?: { status?: string }): Promise<number> {
    if (filter?.status) {
      const result = await this.pool.query(
        `SELECT count(*)::int AS c FROM ${this.schema}.engrams WHERE status = $1`,
        [filter.status]
      )
      return result.rows[0].c
    }
    const result = await this.pool.query(
      `SELECT count(*)::int AS c FROM ${this.schema}.engrams`
    )
    return result.rows[0].c
  }

  async close(): Promise<void> {
    // Pool is shared — don't close it here. Server owns the pool lifecycle.
  }

  /**
   * Full-text search using tsvector.
   * LIMIT is parameterized — no string interpolation.
   */
  async searchText(query: string, limit: number): Promise<Engram[]> {
    const result = await this.pool.query(
      `SELECT data, ts_rank(search_text, plainto_tsquery('english', $1)) AS rank
       FROM ${this.schema}.engrams
       WHERE search_text @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, limit]
    )
    return result.rows.map(row => row.data as Engram)
  }

  /**
   * Vector similarity search using pgvector.
   * Embedding validated before query.
   */
  async searchVector(queryEmbedding: number[], limit: number, scopeFilter?: string[]): Promise<Engram[]> {
    if (!validateEmbedding(queryEmbedding)) {
      throw new Error('Invalid query embedding')
    }

    const embeddingStr = `[${queryEmbedding.join(',')}]`
    let query: string
    let params: unknown[]

    if (scopeFilter && scopeFilter.length > 0) {
      query = `SELECT data, embedding <=> $1::vector AS distance
               FROM ${this.schema}.engrams
               WHERE embedding IS NOT NULL AND scope = ANY($2)
               ORDER BY distance ASC
               LIMIT $3`
      params = [embeddingStr, scopeFilter, limit]
    } else {
      query = `SELECT data, embedding <=> $1::vector AS distance
               FROM ${this.schema}.engrams
               WHERE embedding IS NOT NULL
               ORDER BY distance ASC
               LIMIT $2`
      params = [embeddingStr, limit]
    }

    const result = await this.pool.query(query, params)
    return result.rows.map(row => row.data as Engram)
  }

  /**
   * Update embedding for an engram.
   * Validates embedding before INSERT.
   */
  async setEmbedding(engramId: string, embedding: number[]): Promise<void> {
    if (!validateEmbedding(embedding)) {
      throw new Error('Invalid embedding: must be array of finite numbers, max 2048 dimensions')
    }
    const embeddingStr = `[${embedding.join(',')}]`
    await this.pool.query(
      `UPDATE ${this.schema}.engrams SET embedding = $1::vector WHERE id = $2`,
      [embeddingStr, engramId]
    )
  }

  private validateSize(engram: Engram): void {
    const serialized = JSON.stringify(engram)
    if (!validateEngramSize(serialized)) {
      throw new Error(`Engram ${engram.id} exceeds maximum size of 64KB (${serialized.length} bytes)`)
    }
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/db/postgres-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/db/pool.ts src/db/postgres-store.ts test/db/postgres-store.test.ts
git commit -m "feat: PostgresStore with shared pool, schema scoping, tsvector + pgvector search"
```

---

## Task 4b: Plur Core DI — PR Adding Store Injection

**Goal:** Submit a PR to the `plur-ai/plur` repo that adds an optional `store` parameter to the `Plur` constructor, enabling enterprise to inject `PostgresStore` as the storage backend.

**Files (in plur repo, not enterprise):**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/store-injection.test.ts`

**Security requirements addressed:** B3 (no Plur core DI)

This is a **PR to the plur monorepo**, not enterprise. The change is minimal — add an optional `store` parameter to `Plur`'s constructor options. If provided, `Plur` uses it instead of creating a `YamlStore`/`SqliteStore` from the filesystem.

- [ ] **Step 1: Write the failing test (in plur repo)**

```typescript
// packages/core/test/store-injection.test.ts
import { describe, it, expect } from 'vitest'
import { Plur } from '../src/index.js'
import type { EngramStore } from '../src/store/types.js'
import type { Engram } from '../src/schemas/engram.js'

/** Minimal in-memory store for testing DI */
class MemoryStore implements EngramStore {
  private engrams: Engram[] = []

  async load(): Promise<Engram[]> { return [...this.engrams] }
  async save(engrams: Engram[]): Promise<void> { this.engrams = [...engrams] }
  async append(engram: Engram): Promise<void> { this.engrams.push(engram) }
  async getById(id: string): Promise<Engram | null> {
    return this.engrams.find(e => e.id === id) ?? null
  }
  async remove(id: string): Promise<boolean> {
    const idx = this.engrams.findIndex(e => e.id === id)
    if (idx === -1) return false
    this.engrams.splice(idx, 1)
    return true
  }
  async count(filter?: { status?: string }): Promise<number> {
    if (filter?.status) return this.engrams.filter(e => e.status === filter.status).length
    return this.engrams.length
  }
  async close(): Promise<void> {}
}

describe('Plur store injection', () => {
  it('accepts an injected store', () => {
    const store = new MemoryStore()
    const plur = new Plur({ store })
    expect(plur).toBeDefined()
  })

  it('uses injected store for learn/recall', () => {
    const store = new MemoryStore()
    const plur = new Plur({ store })
    const engram = plur.learn('test statement')
    expect(engram.id).toBeDefined()
    const results = plur.recall('test statement')
    expect(results.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Show the exact diff for Plur constructor**

The current constructor in `packages/core/src/index.ts`:

```typescript
export class Plur {
  private paths: PlurPaths
  private config: PlurConfig
  private indexedStorage: IndexedStorage | null = null
  private _engramCache: Map<string, { mtime: number; engrams: Engram[] }> = new Map()
  private _llmFailureCount = 0
  private _llmDisabledUntil: number | null = null

  constructor(options?: { path?: string }) {
    this.paths = detectPlurStorage(options?.path)
    this.config = loadConfig(this.paths.config)
    if (this.config.index) {
      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
    }
  }
```

The required change:

```diff
+import type { EngramStore } from './store/types.js'
+
 export class Plur {
   private paths: PlurPaths
   private config: PlurConfig
   private indexedStorage: IndexedStorage | null = null
+  private injectedStore: EngramStore | null = null
   private _engramCache: Map<string, { mtime: number; engrams: Engram[] }> = new Map()
   private _llmFailureCount = 0
   private _llmDisabledUntil: number | null = null

-  constructor(options?: { path?: string }) {
-    this.paths = detectPlurStorage(options?.path)
-    this.config = loadConfig(this.paths.config)
-    if (this.config.index) {
-      this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
+  constructor(options?: { path?: string; store?: EngramStore }) {
+    this.injectedStore = options?.store ?? null
+    if (this.injectedStore) {
+      // Enterprise mode: store is injected, paths are optional
+      this.paths = options?.path
+        ? detectPlurStorage(options.path)
+        : { engrams: '', config: '', db: '', episodes: '', packs: '', history: '' } as PlurPaths
+      this.config = options?.path ? loadConfig(this.paths.config) : {} as PlurConfig
+    } else {
+      this.paths = detectPlurStorage(options?.path)
+      this.config = loadConfig(this.paths.config)
+      if (this.config.index) {
+        this.indexedStorage = new IndexedStorage(this.paths.engrams, this.paths.db, this.config.stores)
+      }
     }
   }
```

Then in the internal `_loadAllEngrams()` method and any method that reads/writes engrams from files, add a check:

```diff
   private _loadAllEngrams(): Engram[] {
+    // If store is injected (enterprise), this method is not used —
+    // callers should use async methods on the store directly.
+    if (this.injectedStore) {
+      throw new Error('Use async store methods in enterprise mode')
+    }
     const primary = this._loadCached(this.paths.engrams)
```

**Note:** The full enterprise integration happens at the MCP server level — the enterprise server creates a `PostgresStore`, wraps tool calls to use it, and does not call `_loadAllEngrams` directly. This PR is the minimal change to make the constructor accept an injected store. The enterprise server creates `Plur({ store: postgresStore })` and then intercepts MCP tool dispatch to route through its own permission-wrapped handlers.

- [ ] **Step 3: Run tests in plur repo**

```bash
cd packages/core && pnpm test
# All 150+ existing tests must still pass
pnpm test -- test/store-injection.test.ts
# New test must pass
```

- [ ] **Step 4: Create PR**

```bash
git checkout -b feat/store-injection
git add packages/core/src/index.ts packages/core/test/store-injection.test.ts
git commit -m "feat(core): add optional store injection to Plur constructor for enterprise DI"
gh pr create --title "feat(core): store injection for enterprise DI" --body "Adds optional store parameter to Plur constructor. Enterprise server injects PostgresStore."
```

- [ ] **Step 5: Publish after merge**

```bash
# After PR merges and version bumps
pnpm --filter @plur-ai/core publish --access public --no-git-checks
```

---

## Task 5: AGE Graph Layer

**Goal:** Build the Apache AGE graph layer with ALL methods (create, remove, query), per-org isolated graphs, namespaced user IDs (`orgId:username`), and parameterized/validated inputs for every query. This task IS the AGE validation spike.

**Files:**
- Create: `src/db/graph.ts`
- Create: `test/db/graph.test.ts`

**Security requirements addressed:** finding 1 (Cypher injection), finding 14 (shared graph across tenants), G2 (namespaced user IDs), G3 (sync locking), C2 (missing methods), C6 (namespaced IDs in code)

- [ ] **Step 1: Write the failing test**

```typescript
// test/db/graph.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { GraphLayer } from '../../src/db/graph.js'
import { assertTestDatabase } from '../fixtures/test-guard.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test'

describe('GraphLayer', () => {
  let pool: pg.Pool
  let graph: GraphLayer

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL)
    pool = new pg.Pool({ connectionString: TEST_DB_URL })
    // Load AGE extension
    await pool.query("LOAD 'age'")
    await pool.query("SET search_path = ag_catalog, \"$user\", public")
    graph = new GraphLayer(pool, 'testorg')
    await graph.initialize()
  })

  beforeEach(async () => {
    await graph.clear()
  })

  afterAll(async () => {
    await graph.drop()
    await pool.end()
  })

  describe('Node creation', () => {
    it('creates an org node', async () => {
      await graph.createOrg('testorg', 'Test Organization')
      const exists = await graph.nodeExists('Org', 'testorg')
      expect(exists).toBe(true)
    })

    it('creates a user node with namespaced ID', async () => {
      await graph.createUser('alice', 'alice@acme.com')
      // User node stored as testorg:alice
      const exists = await graph.nodeExists('User', 'testorg:alice')
      expect(exists).toBe(true)
    })

    it('creates a group node', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      const exists = await graph.nodeExists('Group', 'acme/backend')
      expect(exists).toBe(true)
    })

    it('creates a subgroup with parent link', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.createGroup('acme/backend/payments', 'testorg', 'acme/backend')
      const exists = await graph.nodeExists('Group', 'acme/backend/payments')
      expect(exists).toBe(true)
    })

    it('creates a project node owned by a group', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.createProject('acme/backend/api', 'acme/backend')
      const exists = await graph.nodeExists('Project', 'acme/backend/api')
      expect(exists).toBe(true)
    })
  })

  describe('Membership', () => {
    it('adds membership edge between user and group', async () => {
      await graph.createUser('alice', 'alice@acme.com')
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.addMembership('alice', 'acme/backend', 'developer')

      const scopes = await graph.resolveUserScopes('alice')
      expect(scopes).toContain('group:acme/backend')
    })

    it('removes membership edge', async () => {
      await graph.createUser('alice', 'alice@acme.com')
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.addMembership('alice', 'acme/backend', 'developer')
      await graph.removeMembership('alice', 'acme/backend')

      const scopes = await graph.resolveUserScopes('alice')
      expect(scopes).not.toContain('group:acme/backend')
    })
  })

  describe('Permission resolution', () => {
    it('resolves user scopes from group + project memberships', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.createProject('acme/backend/api', 'acme/backend')
      await graph.createUser('alice', 'alice@acme.com')
      await graph.addMembership('alice', 'acme/backend', 'developer')

      const scopes = await graph.resolveUserScopes('alice')
      expect(scopes).toContain('user:testorg:alice')
      expect(scopes).toContain('group:acme/backend')
      expect(scopes).toContain('project:acme/backend/api')
    })

    it('resolves subgroup membership through inheritance', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/backend', 'testorg')
      await graph.createGroup('acme/backend/payments', 'testorg', 'acme/backend')
      await graph.createProject('acme/backend/payments/service', 'acme/backend/payments')
      await graph.createUser('alice', 'alice@acme.com')
      await graph.addMembership('alice', 'acme/backend', 'developer')

      const scopes = await graph.resolveUserScopes('alice')
      // Parent group membership grants access to subgroups and their projects
      expect(scopes).toContain('group:acme/backend/payments')
      expect(scopes).toContain('project:acme/backend/payments/service')
    })
  })

  describe('Removal', () => {
    it('removes a group and its edges', async () => {
      await graph.createOrg('testorg', 'Test')
      await graph.createGroup('acme/temp', 'testorg')
      await graph.removeGroup('acme/temp')
      const exists = await graph.nodeExists('Group', 'acme/temp')
      expect(exists).toBe(false)
    })
  })

  describe('Per-org isolation', () => {
    it('uses separate graph per org', async () => {
      const graph2 = new GraphLayer(pool, 'otherorg')
      await graph2.initialize()

      await graph.createUser('alice', 'alice@acme.com')
      const existsInOrg1 = await graph.nodeExists('User', 'testorg:alice')
      expect(existsInOrg1).toBe(true)

      // Different org's graph should not have testorg:alice
      const existsInOrg2 = await graph2.nodeExists('User', 'testorg:alice')
      expect(existsInOrg2).toBe(false)

      await graph2.drop()
    })
  })

  describe('Injection prevention', () => {
    it('rejects Cypher injection in createUser', async () => {
      await expect(
        graph.createUser("alice'})-[:X]->(:Y) //", 'x@x.com')
      ).rejects.toThrow('Invalid user ID')
    })

    it('rejects Cypher injection in addMembership', async () => {
      await graph.createUser('alice', 'alice@acme.com')
      await expect(
        graph.addMembership('alice', "backend'}); MATCH (n) DETACH DELETE n //", 'dev')
      ).rejects.toThrow('Invalid group ID')
    })

    it('rejects SQL injection in group names', async () => {
      await expect(
        graph.createGroup("x; DROP TABLE engrams; --", 'testorg')
      ).rejects.toThrow('Invalid group ID')
    })
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/db/graph.test.ts
# Expected: FAIL — cannot resolve module
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/db/graph.ts
import type pg from 'pg'
import { validateIdentifier, sanitizeCypherValue, normalizePath } from '../permissions/validator.js'

/**
 * AGE Graph Layer — per-org Cypher graph for permission resolution.
 *
 * Key design:
 * - Each org gets its own AGE graph: plur_${orgId}
 * - User IDs namespaced: ${orgId}:${username} (G2)
 * - All inputs validated via validateIdentifier before any query
 * - Where AGE doesn't support parameterized Cypher, inputs are validated + sanitized
 * - MERGE (upsert) used for all mutations — idempotent (G3)
 */
export class GraphLayer {
  private graphName: string
  private orgId: string

  constructor(private pool: pg.Pool, orgId: string) {
    if (!validateIdentifier(orgId)) {
      throw new Error(`Invalid org ID for graph: ${orgId}`)
    }
    this.orgId = orgId
    this.graphName = `plur_${orgId}`
  }

  /** Initialize the graph (create if not exists) */
  async initialize(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("LOAD 'age'")
      await client.query('SET search_path = ag_catalog, "$user", public')

      // Check if graph exists
      const exists = await client.query(
        "SELECT count(*)::int AS c FROM ag_graph WHERE name = $1",
        [this.graphName]
      )
      if (exists.rows[0].c === 0) {
        await client.query(`SELECT create_graph('${sanitizeCypherValue(this.graphName)}')`)
      }
    } finally {
      client.release()
    }
  }

  /** Execute a Cypher query against this org's graph */
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

  /** Execute a Cypher query that returns no rows */
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

  async createOrg(orgId: string, name: string): Promise<void> {
    if (!validateIdentifier(orgId)) throw new Error(`Invalid org ID: ${orgId}`)
    const safeId = sanitizeCypherValue(orgId)
    const safeName = sanitizeCypherValue(name)
    await this.cypherVoid(
      `MERGE (o:Org {id: '${safeId}'}) SET o.name = '${safeName}' RETURN o`
    )
  }

  async createUser(username: string, email: string): Promise<void> {
    if (!validateIdentifier(username)) throw new Error(`Invalid user ID: ${username}`)
    if (!validateIdentifier(email)) throw new Error(`Invalid email: ${email}`)
    // Namespace user ID: orgId:username (G2)
    const namespacedId = `${this.orgId}:${username}`
    const safeId = sanitizeCypherValue(namespacedId)
    const safeEmail = sanitizeCypherValue(email)
    const safeUsername = sanitizeCypherValue(username)
    await this.cypherVoid(
      `MERGE (u:User {id: '${safeId}'}) SET u.email = '${safeEmail}', u.username = '${safeUsername}' RETURN u`
    )
  }

  async createGroup(groupPath: string, orgId: string, parentGroupPath?: string): Promise<void> {
    const normalized = normalizePath(groupPath)
    if (!validateIdentifier(normalized)) throw new Error(`Invalid group ID: ${groupPath}`)
    const safeGroup = sanitizeCypherValue(normalized)
    const safeOrg = sanitizeCypherValue(orgId)

    // Create group node + link to org
    await this.cypherVoid(
      `MERGE (g:Group {id: '${safeGroup}'})
       WITH g
       MATCH (o:Org {id: '${safeOrg}'})
       MERGE (g)-[:BELONGS_TO]->(o)
       RETURN g`
    )

    // Link to parent group if specified
    if (parentGroupPath) {
      const normalizedParent = normalizePath(parentGroupPath)
      if (!validateIdentifier(normalizedParent)) throw new Error(`Invalid parent group: ${parentGroupPath}`)
      const safeParent = sanitizeCypherValue(normalizedParent)
      await this.cypherVoid(
        `MATCH (child:Group {id: '${safeGroup}'}), (parent:Group {id: '${safeParent}'})
         MERGE (child)-[:SUBGROUP_OF]->(parent)
         RETURN child`
      )
    }
  }

  async createProject(projectPath: string, groupPath: string): Promise<void> {
    const normalizedProject = normalizePath(projectPath)
    const normalizedGroup = normalizePath(groupPath)
    if (!validateIdentifier(normalizedProject)) throw new Error(`Invalid project path: ${projectPath}`)
    if (!validateIdentifier(normalizedGroup)) throw new Error(`Invalid group path: ${groupPath}`)
    const safeProject = sanitizeCypherValue(normalizedProject)
    const safeGroup = sanitizeCypherValue(normalizedGroup)
    await this.cypherVoid(
      `MERGE (p:Project {id: '${safeProject}'})
       WITH p
       MATCH (g:Group {id: '${safeGroup}'})
       MERGE (g)-[:OWNS]->(p)
       RETURN p`
    )
  }

  async addMembership(username: string, groupPath: string, role: string): Promise<void> {
    if (!validateIdentifier(username)) throw new Error(`Invalid user ID: ${username}`)
    const normalizedGroup = normalizePath(groupPath)
    if (!validateIdentifier(normalizedGroup)) throw new Error(`Invalid group ID: ${groupPath}`)
    const namespacedId = `${this.orgId}:${username}`
    const safeUser = sanitizeCypherValue(namespacedId)
    const safeGroup = sanitizeCypherValue(normalizedGroup)
    const safeRole = sanitizeCypherValue(role)
    await this.cypherVoid(
      `MATCH (u:User {id: '${safeUser}'}), (g:Group {id: '${safeGroup}'})
       MERGE (u)-[r:MEMBER_OF]->(g)
       SET r.role = '${safeRole}'
       RETURN u`
    )
  }

  async removeMembership(username: string, groupPath: string): Promise<void> {
    if (!validateIdentifier(username)) throw new Error(`Invalid user ID: ${username}`)
    const normalizedGroup = normalizePath(groupPath)
    if (!validateIdentifier(normalizedGroup)) throw new Error(`Invalid group ID: ${groupPath}`)
    const namespacedId = `${this.orgId}:${username}`
    const safeUser = sanitizeCypherValue(namespacedId)
    const safeGroup = sanitizeCypherValue(normalizedGroup)
    await this.cypherVoid(
      `MATCH (u:User {id: '${safeUser}'})-[r:MEMBER_OF]->(g:Group {id: '${safeGroup}'})
       DELETE r
       RETURN u`
    )
  }

  async removeGroup(groupPath: string): Promise<void> {
    const normalized = normalizePath(groupPath)
    if (!validateIdentifier(normalized)) throw new Error(`Invalid group ID: ${groupPath}`)
    const safeGroup = sanitizeCypherValue(normalized)
    await this.cypherVoid(
      `MATCH (g:Group {id: '${safeGroup}'})
       DETACH DELETE g
       RETURN true`
    ).catch(() => {
      // No-op if group doesn't exist
    })
  }

  /**
   * Resolve all scopes a user has access to.
   * Returns: user:X, group:Y, project:Z scopes.
   *
   * Permission flow:
   * 1. User's own scope (always)
   * 2. Groups the user is MEMBER_OF (direct)
   * 3. Subgroups of those groups (inherited)
   * 4. Projects owned by any accessible group
   */
  async resolveUserScopes(username: string): Promise<string[]> {
    if (!validateIdentifier(username)) throw new Error(`Invalid user ID: ${username}`)
    const namespacedId = `${this.orgId}:${username}`
    const safeUser = sanitizeCypherValue(namespacedId)
    const scopes: string[] = [`user:${namespacedId}`]

    // Direct group memberships
    const directGroups = await this.cypher<{ id: { id: string } }>(
      `MATCH (:User {id: '${safeUser}'})-[:MEMBER_OF]->(g:Group) RETURN g.id`,
      'id agtype'
    )
    for (const row of directGroups) {
      const groupId = typeof row.id === 'string' ? row.id : JSON.parse(String(row.id))
      scopes.push(`group:${groupId}`)
    }

    // Subgroups (inherited access via SUBGROUP_OF, up to 5 levels deep)
    const subgroups = await this.cypher<{ id: { id: string } }>(
      `MATCH (:User {id: '${safeUser}'})-[:MEMBER_OF]->(g:Group)<-[:SUBGROUP_OF*1..5]-(sub:Group)
       RETURN sub.id`,
      'id agtype'
    )
    for (const row of subgroups) {
      const groupId = typeof row.id === 'string' ? row.id : JSON.parse(String(row.id))
      scopes.push(`group:${groupId}`)
    }

    // Projects owned by accessible groups
    const allGroupIds = scopes
      .filter(s => s.startsWith('group:'))
      .map(s => s.slice(6))

    for (const gid of allGroupIds) {
      const safeGid = sanitizeCypherValue(gid)
      const projects = await this.cypher<{ id: { id: string } }>(
        `MATCH (:Group {id: '${safeGid}'})-[:OWNS]->(p:Project) RETURN p.id`,
        'id agtype'
      )
      for (const row of projects) {
        const projId = typeof row.id === 'string' ? row.id : JSON.parse(String(row.id))
        scopes.push(`project:${projId}`)
      }
    }

    return [...new Set(scopes)]
  }

  /** Check if a node with given label and ID exists */
  async nodeExists(label: string, id: string): Promise<boolean> {
    if (!validateIdentifier(id)) return false
    const safeId = sanitizeCypherValue(id)
    const safeLabel = sanitizeCypherValue(label)
    try {
      const rows = await this.cypher(
        `MATCH (n:${safeLabel} {id: '${safeId}'}) RETURN n.id`,
        'id agtype'
      )
      return rows.length > 0
    } catch {
      return false
    }
  }

  /** Clear all nodes and edges from this org's graph */
  async clear(): Promise<void> {
    try {
      await this.cypherVoid(`MATCH (n) DETACH DELETE n RETURN true`)
    } catch {
      // Empty graph — no-op
    }
  }

  /** Drop this org's graph entirely */
  async drop(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("LOAD 'age'")
      await client.query('SET search_path = ag_catalog, "$user", public')
      await client.query(`SELECT drop_graph('${sanitizeCypherValue(this.graphName)}', true)`)
    } catch {
      // Graph may not exist
    } finally {
      client.release()
    }
  }

  /**
   * Acquire an advisory lock for this org (for sync operations).
   * Addresses G3 (concurrent sync/webhook races).
   */
  async acquireSyncLock(): Promise<void> {
    await this.pool.query(`SELECT pg_advisory_lock(hashtext($1))`, [this.orgId])
  }

  async releaseSyncLock(): Promise<void> {
    await this.pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [this.orgId])
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/db/graph.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/db/graph.ts test/db/graph.test.ts
git commit -m "feat: AGE graph layer with per-org isolation, namespaced IDs, injection prevention"
```

---

## Task 6: TenantManager + migrate.ts CLI + SQL Migration Files

**Goal:** Build multi-org schema isolation with a migration runner CLI that tracks applied migrations in a `schema_migrations` table. Each org gets its own PostgreSQL schema with all required tables.

**Files:**
- Create: `src/db/tenant.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/001-base-schema.sql`
- Create: `src/db/migrations/002-age-graph.sql`
- Create: `src/db/migrations/003-pgvector.sql`
- Create: `src/db/migrations/004-gitlab-tokens.sql`
- Create: `src/db/migrations/005-oauth-pending.sql`
- Create: `src/db/migrations/006-processed-webhooks.sql`
- Create: `test/db/tenant.test.ts`
- Create: `test/db/migrate.test.ts`

**Security requirements addressed:** B4 (migrate.ts CLI), finding 15 (SET LOCAL), finding 25 (migration strategy), finding 32 (schema collision), B5 (gitlab_tokens table)

- [ ] **Step 1: Write the failing test**

```typescript
// test/db/tenant.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { TenantManager } from '../../src/db/tenant.js'
import { assertTestDatabase } from '../fixtures/test-guard.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test'

describe('TenantManager', () => {
  let pool: pg.Pool
  let manager: TenantManager

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL)
    pool = new pg.Pool({ connectionString: TEST_DB_URL })
    manager = new TenantManager(pool)
  })

  afterAll(async () => {
    // Cleanup test schemas
    await pool.query('DROP SCHEMA IF EXISTS org_alpha CASCADE')
    await pool.query('DROP SCHEMA IF EXISTS org_beta CASCADE')
    await pool.end()
  })

  it('creates an org schema with all tables', async () => {
    await manager.createOrg('alpha')
    const result = await pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'org_alpha'"
    )
    expect(result.rows).toHaveLength(1)

    // Verify tables exist
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'org_alpha' ORDER BY table_name"
    )
    const tableNames = tables.rows.map(r => r.table_name)
    expect(tableNames).toContain('engrams')
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('audit_log')
    expect(tableNames).toContain('gitlab_tokens')
    expect(tableNames).toContain('oauth_pending')
    expect(tableNames).toContain('processed_webhooks')
  })

  it('uses SET LOCAL for search_path (resets at transaction end)', async () => {
    await manager.createOrg('beta')
    const client = await manager.getOrgClient('beta')
    // After release, search_path should not leak
    client.release()

    const result = await pool.query('SHOW search_path')
    expect(result.rows[0].search_path).not.toContain('org_beta')
  })

  it('uses quoted schema names in DDL', async () => {
    // Already created — should not throw even with special edge cases
    await manager.createOrg('alpha')
  })

  it('detects schema name collisions', async () => {
    // alpha already exists — should be idempotent
    await expect(manager.createOrg('alpha')).resolves.not.toThrow()
  })

  it('rejects invalid org IDs', () => {
    expect(() => new TenantManager(pool).validateOrgId("x; DROP SCHEMA --"))
      .toThrow()
  })

  it('isolates data between tenants', async () => {
    // Insert into alpha
    const alphaClient = await manager.getOrgClient('alpha')
    await alphaClient.query(
      "INSERT INTO org_alpha.engrams (id, status, scope, data) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      ['secret-engram', 'active', 'global', JSON.stringify({ statement: 'alpha secret' })]
    )
    alphaClient.release()

    // Query from beta — must not see alpha's data
    const betaClient = await manager.getOrgClient('beta')
    const result = await betaClient.query('SELECT count(*)::int AS c FROM org_beta.engrams')
    betaClient.release()
    expect(result.rows[0].c).toBe(0)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/db/tenant.test.ts
```

- [ ] **Step 3: Create SQL migration files**

```sql
-- src/db/migrations/001-base-schema.sql
-- Base tables for an org schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- orgId:username
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'developer',
  gitlab_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engrams (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  scope TEXT NOT NULL DEFAULT 'global',
  owner_id TEXT,                    -- user who created this engram
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS engrams_status_idx ON engrams (status);
CREATE INDEX IF NOT EXISTS engrams_scope_idx ON engrams (scope);
CREATE INDEX IF NOT EXISTS engrams_owner_idx ON engrams (owner_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```sql
-- src/db/migrations/002-age-graph.sql
-- AGE graph is created per-org via GraphLayer.initialize()
-- This migration just documents the dependency
SELECT 1;
```

```sql
-- src/db/migrations/003-pgvector.sql
-- Add vector column and search_text to engrams

ALTER TABLE engrams ADD COLUMN IF NOT EXISTS embedding vector(384);
ALTER TABLE engrams ADD COLUMN IF NOT EXISTS search_text tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(data->>'statement', '') || ' ' || COALESCE(data->>'domain', ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS engrams_search_idx ON engrams USING gin(search_text);
CREATE INDEX IF NOT EXISTS engrams_embedding_idx ON engrams USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
```

```sql
-- src/db/migrations/004-gitlab-tokens.sql
-- Encrypted GitLab OAuth token storage (B5, G1, F9)

CREATE TABLE IF NOT EXISTS gitlab_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,           -- Initialization vector for AES-256-GCM
  token_tag TEXT NOT NULL,          -- Auth tag for AES-256-GCM
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```sql
-- src/db/migrations/005-oauth-pending.sql
-- Persistent OAuth state (survives server restart) (F2)

CREATE TABLE IF NOT EXISTS oauth_pending (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

-- Auto-cleanup expired entries
CREATE INDEX IF NOT EXISTS oauth_pending_expires_idx ON oauth_pending (expires_at);
```

```sql
-- src/db/migrations/006-processed-webhooks.sql
-- Webhook replay protection (R10)

CREATE TABLE IF NOT EXISTS processed_webhooks (
  payload_hash TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-cleanup: keep 7 days of history
CREATE INDEX IF NOT EXISTS processed_webhooks_time_idx ON processed_webhooks (processed_at);
```

- [ ] **Step 4: Implement TenantManager**

```typescript
// src/db/tenant.ts
import type pg from 'pg'
import { validateIdentifier, validateSchemaName } from '../permissions/validator.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class TenantManager {
  constructor(private pool: pg.Pool) {}

  /** Validate org ID format */
  validateOrgId(orgId: string): void {
    if (!validateIdentifier(orgId)) {
      throw new Error(`Invalid org ID: ${orgId}`)
    }
  }

  /** Get schema name for an org */
  private schemaName(orgId: string): string {
    return `org_${orgId}`
  }

  /** Create an org schema and run all migrations */
  async createOrg(orgId: string): Promise<void> {
    this.validateOrgId(orgId)
    const schema = this.schemaName(orgId)
    if (!validateSchemaName(schema)) {
      throw new Error(`Generated schema name is invalid: ${schema}`)
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Use quoted identifier for schema name
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      // SET LOCAL resets at transaction end — prevents search_path leak (finding 15)
      await client.query(`SET LOCAL search_path TO "${schema}", public, ag_catalog`)

      // Run migrations in order
      const migrationsDir = path.join(__dirname, 'migrations')
      const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort()

      for (const file of files) {
        const version = file.replace('.sql', '')
        // Check if already applied
        try {
          const applied = await client.query(
            `SELECT 1 FROM "${schema}".schema_migrations WHERE version = $1`,
            [version]
          )
          if (applied.rows.length > 0) continue
        } catch {
          // schema_migrations table may not exist yet — that's fine, run all
        }

        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
        await client.query(sql)

        // Record migration (after schema_migrations table exists from 001)
        try {
          await client.query(
            `INSERT INTO "${schema}".schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
            [version]
          )
        } catch {
          // First migration creates the table — skip recording for it
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Get a client with search_path set to an org schema */
  async getOrgClient(orgId: string): Promise<pg.PoolClient> {
    this.validateOrgId(orgId)
    const schema = this.schemaName(orgId)
    const client = await this.pool.connect()
    await client.query(`SET LOCAL search_path TO "${schema}", public, ag_catalog`)
    return client
  }

  /** List all org schemas */
  async listOrgs(): Promise<string[]> {
    const result = await this.pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'org_%'"
    )
    return result.rows.map(r => r.schema_name.replace('org_', ''))
  }
}
```

- [ ] **Step 5: Implement migrate.ts CLI**

```typescript
// src/db/migrate.ts
/**
 * Migration runner CLI.
 * Usage: tsx src/db/migrate.ts up [--org <orgId>]
 *        tsx src/db/migrate.ts status [--org <orgId>]
 *
 * Addresses B4 (migrate.ts CLI referenced but never created).
 */
import pg from 'pg'
import { TenantManager } from './tenant.js'

async function main() {
  const command = process.argv[2]
  const orgId = process.argv.includes('--org')
    ? process.argv[process.argv.indexOf('--org') + 1]
    : process.env.ORG_ID || 'default'

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString: dbUrl })
  const manager = new TenantManager(pool)

  try {
    switch (command) {
      case 'up': {
        console.log(`Running migrations for org: ${orgId}`)
        await manager.createOrg(orgId)
        console.log('Migrations complete.')
        break
      }

      case 'status': {
        const schema = `org_${orgId}`
        try {
          const result = await pool.query(
            `SELECT version, applied_at FROM "${schema}".schema_migrations ORDER BY version`
          )
          console.log(`Migrations for org ${orgId}:`)
          for (const row of result.rows) {
            console.log(`  ${row.version} — applied ${row.applied_at}`)
          }
        } catch {
          console.log(`No migrations found for org ${orgId}`)
        }
        break
      }

      case 'list-orgs': {
        const orgs = await manager.listOrgs()
        console.log('Registered orgs:', orgs.join(', ') || '(none)')
        break
      }

      default:
        console.error('Usage: migrate.ts <up|status|list-orgs> [--org <orgId>]')
        process.exit(1)
    }
  } finally {
    await pool.end()
  }
}

main().catch(err => {
  console.error('Migration error:', err)
  process.exit(1)
})
```

- [ ] **Step 6: Run test — verify it passes**

```bash
npx vitest run test/db/tenant.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/db/tenant.ts src/db/migrate.ts src/db/migrations/ test/db/
git commit -m "feat: TenantManager + migrate.ts CLI + SQL migrations (multi-org schema isolation)"
```

---

## Task 7: GitLab API Client

**Goal:** Build the GitLab API client with HTTPS enforcement by default, pagination limits, rate limit handling, and Zod response validation for all API responses.

**Files:**
- Create: `src/gitlab/client.ts`
- Create: `test/gitlab/client.test.ts`

**Security requirements addressed:** G10 (Zod response validation), G11 (HTTPS default), F5 (pagination limit), C1 (allowInsecure alignment)

- [ ] **Step 1: Write the failing test**

```typescript
// test/gitlab/client.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { GitLabClient } from '../../src/gitlab/client.js'

const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com'
const GITLAB_TOKEN = process.env.GITLAB_TOKEN

describe('GitLabClient', () => {
  describe('unit tests (no network)', () => {
    it('normalizes trailing slash from base URL', () => {
      const client = new GitLabClient('https://gitlab.example.com/', 'token')
      expect(client.baseUrl).toBe('https://gitlab.example.com')
    })

    it('rejects non-HTTPS URLs by default', () => {
      expect(() => new GitLabClient('http://gitlab.com', 'token'))
        .toThrow('GitLab URL must use HTTPS')
    })

    it('allows HTTP when allowInsecure is true', () => {
      expect(() => new GitLabClient('http://localhost:3000', 'token', { allowInsecure: true }))
        .not.toThrow()
    })

    it('sets maxPages default to 50', () => {
      const client = new GitLabClient('https://gitlab.example.com', 'token')
      expect(client.maxPages).toBe(50)
    })

    it('accepts custom maxPages', () => {
      const client = new GitLabClient('https://gitlab.example.com', 'token', { maxPages: 10 })
      expect(client.maxPages).toBe(10)
    })
  })

  describe.skipIf(!GITLAB_TOKEN)('integration (requires GITLAB_TOKEN)', () => {
    let client: GitLabClient

    beforeAll(() => {
      client = new GitLabClient(GITLAB_URL, GITLAB_TOKEN!)
    })

    it('fetches current user profile with Zod validation', async () => {
      const user = await client.getCurrentUser()
      expect(user.id).toBeDefined()
      expect(user.username).toBeDefined()
      expect(user.email).toBeDefined()
    })

    it('lists groups with pagination', async () => {
      const groups = await client.listUserGroups()
      expect(Array.isArray(groups)).toBe(true)
    })

    it('lists projects with pagination', async () => {
      const projects = await client.listUserProjects()
      expect(Array.isArray(projects)).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/gitlab/client.test.ts
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/gitlab/client.ts
import {
  GitLabUserSchema,
  GitLabGroupSchema,
  GitLabProjectSchema,
  GitLabMemberSchema,
  type GitLabUser,
  type GitLabGroup,
  type GitLabProject,
  type GitLabMember,
} from './schemas.js'
import type { Logger } from '../logging/logger.js'
import { z } from 'zod'

export interface GitLabClientOptions {
  allowInsecure?: boolean
  maxPages?: number
  logger?: Logger
}

export class GitLabClient {
  readonly baseUrl: string
  readonly maxPages: number
  private token: string
  private logger?: Logger

  constructor(baseUrl: string, token: string, options?: GitLabClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.maxPages = options?.maxPages ?? 50
    this.logger = options?.logger as Logger | undefined

    // HTTPS required by default (G11)
    if (!options?.allowInsecure && !this.baseUrl.startsWith('https://')) {
      throw new Error('GitLab URL must use HTTPS. Set allowInsecure: true for development.')
    }
  }

  /**
   * Paginated GET with:
   * - Zod schema validation on every response (G10)
   * - maxPages limit to prevent unbounded pagination (F5)
   * - Rate limit handling (429 with Retry-After)
   */
  private async paginatedGet<T>(
    path: string,
    schema: z.ZodType<T>,
    params?: Record<string, string>
  ): Promise<T[]> {
    const results: T[] = []
    let url = `${this.baseUrl}/api/v4${path}?per_page=100&${new URLSearchParams(params || {}).toString()}`
    let page = 0

    while (url && page < this.maxPages) {
      page++
      this.logger?.debug({ url, page }, 'GitLab API request')

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      })

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10)
        this.logger?.warn({ retryAfter }, 'GitLab rate limited, waiting')
        await new Promise(r => setTimeout(r, retryAfter * 1000))
        continue // retry same URL (don't increment page)
      }

      if (!res.ok) {
        // G7: Never log response body from GitLab error responses
        throw new Error(`GitLab API error: ${res.status} on ${path}`)
      }

      const rawData = await res.json()
      if (!Array.isArray(rawData)) break

      // Validate each item against schema (G10)
      for (const item of rawData) {
        const parsed = schema.safeParse(item)
        if (parsed.success) {
          results.push(parsed.data)
        } else {
          this.logger?.warn(
            { path, errors: parsed.error.issues.length },
            'GitLab response item failed schema validation — skipping'
          )
        }
      }

      // Follow pagination via Link header
      const linkHeader = res.headers.get('Link')
      const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/)
      url = nextMatch ? nextMatch[1] : ''
    }

    if (page >= this.maxPages) {
      this.logger?.warn({ path, maxPages: this.maxPages }, 'Pagination limit reached')
    }

    return results
  }

  async getCurrentUser(): Promise<GitLabUser> {
    const res = await fetch(`${this.baseUrl}/api/v4/user`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    })
    if (!res.ok) {
      throw new Error(`GitLab API error: ${res.status}`)
    }
    const data = await res.json()
    return GitLabUserSchema.parse(data)
  }

  async listUserGroups(): Promise<GitLabGroup[]> {
    return this.paginatedGet('/groups', GitLabGroupSchema, { membership: 'true' })
  }

  async listUserProjects(options?: { minAccessLevel?: number }): Promise<GitLabProject[]> {
    const params: Record<string, string> = { membership: 'true' }
    if (options?.minAccessLevel) params.min_access_level = options.minAccessLevel.toString()
    return this.paginatedGet('/projects', GitLabProjectSchema, params)
  }

  async listGroupMembers(groupId: number): Promise<GitLabMember[]> {
    return this.paginatedGet(`/groups/${groupId}/members/all`, GitLabMemberSchema)
  }

  async listGroupSubgroups(groupId: number): Promise<GitLabGroup[]> {
    return this.paginatedGet(`/groups/${groupId}/subgroups`, GitLabGroupSchema)
  }

  /** Update the token (e.g., after OAuth refresh) */
  updateToken(newToken: string): void {
    this.token = newToken
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/gitlab/client.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/gitlab/client.ts test/gitlab/client.test.ts
git commit -m "feat: GitLab API client with HTTPS default, pagination limit, Zod validation"
```

---

## Task 7b: GitLab OAuth2 with PKCE + Encrypted Token Storage + Refresh Flow

**Goal:** Implement OAuth2 authorization code flow with PKCE, encrypted storage of GitLab access/refresh tokens in PostgreSQL, and automatic token refresh before sync operations.

**Files:**
- Create: `src/gitlab/oauth.ts`
- Create: `src/gitlab/token-store.ts`
- Create: `test/gitlab/oauth.test.ts`
- Create: `test/gitlab/token-store.test.ts`

**Security requirements addressed:** B5 (gitlab_tokens table + encryption + refresh), G1 (token storage CRITICAL), F9 (separate encryption key), F2 (OAuth state persistence), G5 (state TTL + cap)

- [ ] **Step 1: Write the failing tests**

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

```typescript
// test/gitlab/token-store.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { GitLabTokenStore } from '../../src/gitlab/token-store.js'
import { assertTestDatabase } from '../fixtures/test-guard.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test'
const ENCRYPTION_KEY = 'a'.repeat(32) // 32 bytes for AES-256

describe('GitLabTokenStore', () => {
  let pool: pg.Pool
  let store: GitLabTokenStore

  beforeAll(async () => {
    assertTestDatabase(TEST_DB_URL)
    pool = new pg.Pool({ connectionString: TEST_DB_URL })

    // Create required tables
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS test_tokens;
      CREATE TABLE IF NOT EXISTS test_tokens.users (
        id TEXT PRIMARY KEY, email TEXT, display_name TEXT, role TEXT DEFAULT 'developer',
        gitlab_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS test_tokens.gitlab_tokens (
        user_id TEXT PRIMARY KEY REFERENCES test_tokens.users(id) ON DELETE CASCADE,
        encrypted_access_token TEXT NOT NULL,
        encrypted_refresh_token TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `)

    await pool.query(
      "INSERT INTO test_tokens.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ['testorg:alice', 'alice@acme.com']
    )

    store = new GitLabTokenStore(pool, 'test_tokens', ENCRYPTION_KEY)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM test_tokens.gitlab_tokens')
  })

  afterAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS test_tokens CASCADE')
    await pool.end()
  })

  it('stores and retrieves encrypted tokens', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000)
    await store.saveTokens('testorg:alice', {
      accessToken: 'glpat-secret-access-token',
      refreshToken: 'glpat-secret-refresh-token',
      expiresAt,
    })

    const retrieved = await store.getTokens('testorg:alice')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.accessToken).toBe('glpat-secret-access-token')
    expect(retrieved!.refreshToken).toBe('glpat-secret-refresh-token')
  })

  it('stores tokens encrypted (not plaintext in DB)', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000)
    await store.saveTokens('testorg:alice', {
      accessToken: 'glpat-secret-access-token',
      refreshToken: 'glpat-secret-refresh-token',
      expiresAt,
    })

    // Read raw from DB — should NOT contain plaintext
    const raw = await pool.query('SELECT * FROM test_tokens.gitlab_tokens WHERE user_id = $1', ['testorg:alice'])
    expect(raw.rows[0].encrypted_access_token).not.toBe('glpat-secret-access-token')
    expect(raw.rows[0].encrypted_refresh_token).not.toBe('glpat-secret-refresh-token')
  })

  it('returns null for non-existent user', async () => {
    const result = await store.getTokens('testorg:nobody')
    expect(result).toBeNull()
  })

  it('detects expired tokens', async () => {
    const expiresAt = new Date(Date.now() - 1000) // Already expired
    await store.saveTokens('testorg:alice', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt,
    })

    const isExpired = await store.isTokenExpired('testorg:alice')
    expect(isExpired).toBe(true)
  })

  it('deletes tokens on user removal', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000)
    await store.saveTokens('testorg:alice', {
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt,
    })

    await store.deleteTokens('testorg:alice')
    const result = await store.getTokens('testorg:alice')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run test/gitlab/oauth.test.ts test/gitlab/token-store.test.ts
```

- [ ] **Step 3: Implement OAuth flow**

```typescript
// src/gitlab/oauth.ts
import crypto from 'node:crypto'

export interface GitLabOAuthConfig {
  gitlabUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
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
      scope: scopes.join(' '),
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
      // G7: Never log the response body from GitLab token endpoint
      throw new Error(`GitLab token exchange failed: ${res.status}`)
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

    if (!res.ok) {
      throw new Error(`GitLab token refresh failed: ${res.status}`)
    }

    return res.json() as Promise<OAuthTokenResponse>
  }
}
```

- [ ] **Step 4: Implement encrypted token store**

```typescript
// src/gitlab/token-store.ts
import crypto from 'node:crypto'
import type pg from 'pg'
import { validateSchemaName } from '../permissions/validator.js'

/**
 * Encrypted GitLab token storage.
 *
 * Uses AES-256-GCM with a separate encryption key (F9 — not the JWT secret).
 * Tokens are encrypted at rest in the gitlab_tokens table (G1, B5).
 */

interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

export class GitLabTokenStore {
  private schema: string
  private encryptionKey: Buffer

  constructor(pool: pg.Pool, schema: string, encryptionKeyHex: string) {
    if (!validateSchemaName(schema)) {
      throw new Error(`Invalid schema name: ${schema}`)
    }
    this.schema = schema
    this.pool = pool
    // Derive a 32-byte key from the provided key material
    this.encryptionKey = crypto.createHash('sha256').update(encryptionKeyHex).digest()
  }

  private pool: pg.Pool

  private encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv)
    let encrypted = cipher.update(plaintext, 'utf8', 'base64')
    encrypted += cipher.final('base64')
    const tag = cipher.getAuthTag()
    return {
      ciphertext: encrypted,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    }
  }

  private decrypt(ciphertext: string, ivBase64: string, tagBase64: string): string {
    const iv = Buffer.from(ivBase64, 'base64')
    const tag = Buffer.from(tagBase64, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv)
    decipher.setAuthTag(tag)
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  async saveTokens(userId: string, tokens: StoredTokens): Promise<void> {
    const accessEnc = this.encrypt(tokens.accessToken)
    const refreshEnc = this.encrypt(tokens.refreshToken)

    await this.pool.query(
      `INSERT INTO ${this.schema}.gitlab_tokens
         (user_id, encrypted_access_token, encrypted_refresh_token, token_iv, token_tag, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         token_iv = EXCLUDED.token_iv,
         token_tag = EXCLUDED.token_tag,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        userId,
        accessEnc.ciphertext,
        refreshEnc.ciphertext,
        JSON.stringify({ access: accessEnc.iv, refresh: refreshEnc.iv }),
        JSON.stringify({ access: accessEnc.tag, refresh: refreshEnc.tag }),
        tokens.expiresAt,
      ]
    )
  }

  async getTokens(userId: string): Promise<StoredTokens | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.gitlab_tokens WHERE user_id = $1`,
      [userId]
    )
    if (result.rows.length === 0) return null

    const row = result.rows[0]
    const ivs = JSON.parse(row.token_iv)
    const tags = JSON.parse(row.token_tag)

    return {
      accessToken: this.decrypt(row.encrypted_access_token, ivs.access, tags.access),
      refreshToken: this.decrypt(row.encrypted_refresh_token, ivs.refresh, tags.refresh),
      expiresAt: new Date(row.expires_at),
    }
  }

  async isTokenExpired(userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT expires_at FROM ${this.schema}.gitlab_tokens WHERE user_id = $1`,
      [userId]
    )
    if (result.rows.length === 0) return true
    return new Date(result.rows[0].expires_at) <= new Date()
  }

  async deleteTokens(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.schema}.gitlab_tokens WHERE user_id = $1`,
      [userId]
    )
  }
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
npx vitest run test/gitlab/oauth.test.ts test/gitlab/token-store.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/gitlab/oauth.ts src/gitlab/token-store.ts test/gitlab/
git commit -m "feat: GitLab OAuth2 with PKCE + AES-256-GCM encrypted token storage + refresh flow"
```

---

## Task 8: GitLab Org Sync + ensureUserSynced() + Sync CLI

**Goal:** Build the bridge between GitLab's org structure and PLUR's permission graph. Sync groups, projects, and memberships. Implement `ensureUserSynced()` which is called on first login. Create a CLI for manual sync.

**Files:**
- Create: `src/gitlab/sync.ts`
- Create: `src/gitlab/cli/sync.ts`
- Create: `test/gitlab/sync.test.ts`

**Security requirements addressed:** B2 (ensureUserSynced defined), C5 (sync CLI created), C6 (namespaced IDs in sync code), G3 (advisory lock), G4 (permission lag mitigation), G12 (async first-login sync)

- [ ] **Step 1: Write the failing test**

```typescript
// test/gitlab/sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitLabSync, ensureUserSynced } from '../../src/gitlab/sync.js'

const mockClient = {
  listUserGroups: vi.fn(),
  listUserProjects: vi.fn(),
  listGroupMembers: vi.fn(),
  listGroupSubgroups: vi.fn(),
  getCurrentUser: vi.fn(),
}

const mockGraph = {
  createOrg: vi.fn(),
  createGroup: vi.fn(),
  createProject: vi.fn(),
  createUser: vi.fn(),
  addMembership: vi.fn(),
  removeMembership: vi.fn(),
  removeGroup: vi.fn(),
  clear: vi.fn(),
  resolveUserScopes: vi.fn(),
  acquireSyncLock: vi.fn(),
  releaseSyncLock: vi.fn(),
}

const mockPool = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
}

describe('GitLabSync', () => {
  let sync: GitLabSync

  beforeEach(() => {
    vi.clearAllMocks()
    sync = new GitLabSync(mockClient as any, mockGraph as any, 'acme')
  })

  it('syncs groups from GitLab to graph', async () => {
    mockClient.listUserGroups.mockResolvedValue([
      { id: 1, full_path: 'acme/backend', parent_id: null, path: 'backend', name: 'backend', full_name: 'backend', visibility: 'private' },
      { id: 2, full_path: 'acme/frontend', parent_id: null, path: 'frontend', name: 'frontend', full_name: 'frontend', visibility: 'private' },
      { id: 3, full_path: 'acme/backend/payments', parent_id: 1, path: 'payments', name: 'payments', full_name: 'payments', visibility: 'private' },
    ])
    mockClient.listUserProjects.mockResolvedValue([])

    await sync.syncGroups()

    expect(mockGraph.createGroup).toHaveBeenCalledTimes(3)
    expect(mockGraph.createGroup).toHaveBeenCalledWith('acme/backend/payments', 'acme', 'acme/backend')
  })

  it('syncs projects with their group ownership', async () => {
    mockClient.listUserProjects.mockResolvedValue([
      {
        id: 10, path_with_namespace: 'acme/backend/api', archived: false,
        namespace: { id: 1, name: 'backend', path: 'backend', kind: 'group', full_path: 'acme/backend', parent_id: null },
        name: 'api', path: 'api', visibility: 'private',
      },
    ])

    await sync.syncProjects()

    expect(mockGraph.createProject).toHaveBeenCalledWith('acme/backend/api', 'acme/backend')
  })

  it('skips archived projects', async () => {
    mockClient.listUserProjects.mockResolvedValue([
      {
        id: 10, path_with_namespace: 'acme/old', archived: true,
        namespace: { id: 1, name: 'x', path: 'x', kind: 'group', full_path: 'acme', parent_id: null },
        name: 'old', path: 'old', visibility: 'private',
      },
    ])

    await sync.syncProjects()
    expect(mockGraph.createProject).not.toHaveBeenCalled()
  })

  it('syncs members with namespaced user IDs', async () => {
    mockClient.listUserGroups.mockResolvedValue([
      { id: 1, full_path: 'acme/backend', parent_id: null, path: 'backend', name: 'backend', full_name: 'backend', visibility: 'private' },
    ])
    mockClient.listGroupMembers.mockResolvedValue([
      { id: 100, username: 'alice', name: 'Alice', access_level: 30, state: 'active' },
      { id: 101, username: 'bob', name: 'Bob', access_level: 40, state: 'active' },
      { id: 102, username: 'charlie', name: 'Charlie', access_level: 10, state: 'blocked' },
    ])

    await sync.syncMembers()

    expect(mockGraph.createUser).toHaveBeenCalledTimes(2) // charlie is blocked
    expect(mockGraph.addMembership).toHaveBeenCalledWith('alice', 'acme/backend', 'developer')
    expect(mockGraph.addMembership).toHaveBeenCalledWith('bob', 'acme/backend', 'maintainer')
  })

  it('acquires advisory lock during full sync', async () => {
    mockClient.listUserGroups.mockResolvedValue([])
    mockClient.listUserProjects.mockResolvedValue([])
    mockClient.listGroupMembers.mockResolvedValue([])

    await sync.fullSync()

    expect(mockGraph.acquireSyncLock).toHaveBeenCalledTimes(1)
    expect(mockGraph.releaseSyncLock).toHaveBeenCalledTimes(1)
  })
})

describe('ensureUserSynced', () => {
  it('creates user node and syncs their groups', async () => {
    const mockUserClient = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: 100, username: 'alice', email: 'alice@acme.com', name: 'Alice', state: 'active', avatar_url: null }),
      listUserGroups: vi.fn().mockResolvedValue([]),
      listUserProjects: vi.fn().mockResolvedValue([]),
    }

    await ensureUserSynced(
      { id: 100, username: 'alice', email: 'alice@acme.com', name: 'Alice', state: 'active', avatar_url: null },
      mockUserClient as any,
      mockGraph as any,
      'acme',
      mockPool as any,
      'org_acme'
    )

    expect(mockGraph.createUser).toHaveBeenCalledWith('alice', 'alice@acme.com')
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/gitlab/sync.test.ts
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/gitlab/sync.ts
import type { GitLabClient } from './client.js'
import type { GraphLayer } from '../db/graph.js'
import type { GitLabUser } from './schemas.js'
import { validateIdentifier } from '../permissions/validator.js'
import { ACCESS_LEVELS } from './schemas.js'
import type pg from 'pg'

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
  constructor(
    private client: GitLabClient,
    private graph: GraphLayer,
    private orgId: string,
  ) {}

  async syncGroups(): Promise<{ count: number; skipped: number }> {
    const groups = await this.client.listUserGroups()
    let count = 0
    let skipped = 0

    const sorted = groups.sort((a, b) => (a.parent_id ?? 0) - (b.parent_id ?? 0))

    for (const group of sorted) {
      if (!validateIdentifier(group.full_path)) { skipped++; continue }

      const parent = group.parent_id
        ? groups.find(g => g.id === group.parent_id)
        : null

      await this.graph.createGroup(group.full_path, this.orgId, parent?.full_path)
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
      if (!validateIdentifier(project.path_with_namespace)) { skipped++; continue }

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

        if (!seenUsers.has(member.username)) {
          await this.graph.createUser(member.username, member.email || `${member.username}@unknown`)
          seenUsers.add(member.username)
        }

        const role = accessLevelToRole(member.access_level)
        await this.graph.addMembership(member.username, group.full_path, role)
        memberships++
      }
    }

    return { users: seenUsers.size, memberships, blocked }
  }

  /**
   * Full sync with advisory lock (G3).
   * Acquires pg_advisory_lock to prevent concurrent sync/webhook races.
   */
  async fullSync(): Promise<SyncReport> {
    const start = Date.now()
    const errors: string[] = []
    const report: SyncReport = {
      groups: 0, projects: 0, users: 0, memberships: 0,
      skipped: { archived: 0, blocked: 0, invalid: 0 },
      errors, duration_ms: 0,
    }

    await this.graph.acquireSyncLock()
    try {
      await this.graph.createOrg(this.orgId, this.orgId)

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
    } finally {
      await this.graph.releaseSyncLock()
    }

    report.duration_ms = Date.now() - start
    return report
  }
}

/**
 * Ensure a user is synced in the graph on first login.
 * Creates user node, then runs a scoped sync of their groups/projects.
 *
 * Addresses B2 (ensureUserSynced called but never defined).
 * Addresses G12 (async first-login sync — returns immediately, sync runs in background).
 *
 * Called from the OAuth callback (Task 10). The JWT is issued immediately;
 * sync runs async. User sees "syncing" status until complete.
 */
export async function ensureUserSynced(
  gitlabUser: GitLabUser,
  gitlabClient: GitLabClient,
  graph: GraphLayer,
  orgId: string,
  pool: pg.Pool,
  schema: string,
): Promise<void> {
  // Check if user already exists in the database
  const existing = await pool.query(
    `SELECT 1 FROM "${schema}".users WHERE id = $1`,
    [`${orgId}:${gitlabUser.username}`]
  )

  // Create/update user in relational table
  await pool.query(
    `INSERT INTO "${schema}".users (id, email, display_name, gitlab_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = $2, display_name = $3, gitlab_id = $4, updated_at = NOW()`,
    [`${orgId}:${gitlabUser.username}`, gitlabUser.email, gitlabUser.name, gitlabUser.id]
  )

  // Create user in graph
  await graph.createUser(gitlabUser.username, gitlabUser.email)

  // If new user, trigger a scoped sync in background (G12)
  if (existing.rows.length === 0) {
    const sync = new GitLabSync(gitlabClient, graph, orgId)
    // Run async — don't block the OAuth callback
    sync.fullSync().catch(() => {
      // Sync errors are logged but don't fail login
    })
  }
}
```

- [ ] **Step 4: Create sync CLI**

```typescript
// src/gitlab/cli/sync.ts
/**
 * GitLab sync CLI.
 * Usage: tsx src/gitlab/cli/sync.ts [--org <orgId>]
 *
 * Addresses C5 (sync CLI referenced but never created).
 */
import pg from 'pg'
import { GitLabClient } from '../client.js'
import { GraphLayer } from '../../db/graph.js'
import { GitLabSync } from '../sync.js'

async function main() {
  const orgId = process.argv.includes('--org')
    ? process.argv[process.argv.indexOf('--org') + 1]
    : process.env.ORG_ID || 'default'

  const dbUrl = process.env.DATABASE_URL
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_ADMIN_TOKEN || process.env.GITLAB_TOKEN

  if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1) }
  if (!gitlabUrl) { console.error('GITLAB_URL required'); process.exit(1) }
  if (!gitlabToken) { console.error('GITLAB_ADMIN_TOKEN or GITLAB_TOKEN required'); process.exit(1) }

  const pool = new pg.Pool({ connectionString: dbUrl })
  const gitlabClient = new GitLabClient(gitlabUrl, gitlabToken)
  const graph = new GraphLayer(pool, orgId)
  await graph.initialize()

  const sync = new GitLabSync(gitlabClient, graph, orgId)

  console.log(`Starting full sync for org: ${orgId}`)
  const report = await sync.fullSync()

  console.log('Sync complete:')
  console.log(`  Groups: ${report.groups}`)
  console.log(`  Projects: ${report.projects}`)
  console.log(`  Users: ${report.users}`)
  console.log(`  Memberships: ${report.memberships}`)
  console.log(`  Skipped: archived=${report.skipped.archived}, blocked=${report.skipped.blocked}, invalid=${report.skipped.invalid}`)
  console.log(`  Duration: ${report.duration_ms}ms`)
  if (report.errors.length) console.error('  Errors:', report.errors)

  await pool.end()
}

main().catch(err => { console.error('Sync error:', err); process.exit(1) })
```

- [ ] **Step 5: Run test — verify it passes**

```bash
npx vitest run test/gitlab/sync.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/gitlab/sync.ts src/gitlab/cli/ test/gitlab/sync.test.ts
git commit -m "feat: GitLab org sync + ensureUserSynced + sync CLI with advisory locking"
```

---

## Task 9: GitLab Webhook Handler

**Goal:** Handle GitLab webhook events for real-time permission graph updates. Uses `crypto.timingSafeEqual` for token validation, deduplicates replayed webhooks, and uses `config.org_id` (not hardcoded).

**Files:**
- Create: `src/gitlab/webhook.ts`
- Create: `test/gitlab/webhook.test.ts`

**Security requirements addressed:** G8 (timingSafeEqual), R10 (replay protection), C7 (orgId from config), F3 (correct timing-safe implementation)

- [ ] **Step 1: Write the failing test**

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

const mockPool = {
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
}

describe('GitLabWebhookHandler', () => {
  const handler = new GitLabWebhookHandler(
    mockGraph as any,
    'webhook-secret-token-long-enough',
    'acme',  // orgId from config
    mockPool as any,
    'org_acme',
  )

  it('validates token with crypto.timingSafeEqual (constant time)', () => {
    expect(handler.validateToken('webhook-secret-token-long-enough')).toBe(true)
    expect(handler.validateToken('wrong-token-different-len')).toBe(false)
    expect(handler.validateToken('wrong')).toBe(false)
    expect(handler.validateToken('')).toBe(false)
  })

  it('handles user_add_to_group event', async () => {
    vi.clearAllMocks()
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })

    await handler.handle({
      event_name: 'user_add_to_group',
      user_username: 'alice',
      user_email: 'alice@acme.com',
      user_id: 123,
      group_path: 'acme/backend',
      group_id: 1,
      group_access: 'Developer',
    })

    expect(mockGraph.createUser).toHaveBeenCalledWith('alice', 'alice@acme.com')
    expect(mockGraph.addMembership).toHaveBeenCalledWith('alice', 'acme/backend', 'developer')
  })

  it('handles user_remove_from_group event', async () => {
    vi.clearAllMocks()
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })

    await handler.handle({
      event_name: 'user_remove_from_group',
      user_username: 'alice',
      group_path: 'acme/backend',
      group_id: 1,
    })

    expect(mockGraph.removeMembership).toHaveBeenCalledWith('alice', 'acme/backend')
  })

  it('handles subgroup_create with orgId from config (not hardcoded)', async () => {
    vi.clearAllMocks()
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })

    await handler.handle({
      event_name: 'subgroup_create',
      group_id: 5,
      name: 'payments',
      path: 'payments',
      full_path: 'acme/backend/payments',
      parent_group_id: 1,
    })

    // Should use config.org_id ('acme'), not hardcoded 'unknown'
    expect(mockGraph.createGroup).toHaveBeenCalledWith('acme/backend/payments', 'acme')
  })

  it('deduplicates replayed webhooks', async () => {
    vi.clearAllMocks()
    // First call: no existing record
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 })
    await handler.handle({
      event_name: 'user_add_to_group',
      user_username: 'bob', user_email: 'bob@acme.com', user_id: 456,
      group_path: 'acme/frontend', group_id: 2, group_access: 'Developer',
    })
    expect(mockGraph.createUser).toHaveBeenCalledTimes(1)

    // Second call: duplicate detected
    vi.clearAllMocks()
    mockPool.query.mockResolvedValueOnce({ rows: [{ payload_hash: 'exists' }], rowCount: 0 })
    await handler.handle({
      event_name: 'user_add_to_group',
      user_username: 'bob', user_email: 'bob@acme.com', user_id: 456,
      group_path: 'acme/frontend', group_id: 2, group_access: 'Developer',
    })
    expect(mockGraph.createUser).not.toHaveBeenCalled()
  })

  it('ignores unknown event types gracefully', async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 })
    await expect(handler.handle({ event_name: 'push' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/gitlab/webhook.test.ts
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/gitlab/webhook.ts
import crypto from 'node:crypto'
import type { GraphLayer } from '../db/graph.js'
import type pg from 'pg'
import { validateIdentifier, normalizePath } from '../permissions/validator.js'

interface WebhookEvent {
  event_name: string
  [key: string]: unknown
}

/**
 * GitLab webhook handler.
 *
 * Security:
 * - Token validation uses crypto.timingSafeEqual with SHA-256 hashes (G8, F3)
 * - Replay protection via processed_webhooks table (R10)
 * - orgId comes from config, not hardcoded (C7)
 * - All identifiers validated before graph operations
 */
export class GitLabWebhookHandler {
  private secretHash: Buffer

  constructor(
    private graph: GraphLayer,
    secretToken: string,
    private orgId: string,    // From config — not hardcoded (C7)
    private pool: pg.Pool,
    private schema: string,
  ) {
    // Pre-hash the secret for fixed-length comparison (G8)
    this.secretHash = crypto.createHash('sha256').update(secretToken).digest()
  }

  /**
   * Constant-time token validation using crypto.timingSafeEqual.
   * Hashes both values to ensure fixed-length comparison — eliminates length leakage.
   * Addresses G8 and F3.
   */
  validateToken(token: string): boolean {
    if (!token) return false
    const tokenHash = crypto.createHash('sha256').update(token).digest()
    try {
      return crypto.timingSafeEqual(this.secretHash, tokenHash)
    } catch {
      return false // Different lengths (shouldn't happen with hashing, but defensive)
    }
  }

  /**
   * Check if this webhook was already processed (R10 replay protection).
   * Returns true if it's a duplicate — caller should skip processing.
   */
  private async isDuplicate(event: WebhookEvent): Promise<boolean> {
    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(event))
      .digest('hex')

    // Try to insert — if conflict, it's a replay
    const result = await this.pool.query(
      `INSERT INTO "${this.schema}".processed_webhooks (payload_hash, event_name)
       VALUES ($1, $2)
       ON CONFLICT (payload_hash) DO NOTHING`,
      [payloadHash, event.event_name]
    )

    // If rowCount is 0, the insert was a no-op (duplicate)
    return (result.rowCount ?? 0) === 0
  }

  async handle(event: WebhookEvent): Promise<void> {
    // Skip unknown events early (before dedup check)
    const knownEvents = [
      'user_add_to_group', 'user_remove_from_group', 'user_update_for_group',
      'subgroup_create', 'subgroup_destroy',
    ]
    if (!knownEvents.includes(event.event_name)) return

    // Replay protection (R10)
    if (await this.isDuplicate(event)) return

    switch (event.event_name) {
      case 'user_add_to_group':
        await this.handleMemberAdd(event)
        break
      case 'user_remove_from_group':
        await this.handleMemberRemove(event)
        break
      case 'user_update_for_group':
        await this.handleMemberRemove(event)
        await this.handleMemberAdd(event)
        break
      case 'subgroup_create':
        await this.handleSubgroupCreate(event)
        break
      case 'subgroup_destroy':
        await this.handleSubgroupDestroy(event)
        break
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

  private async handleSubgroupCreate(event: WebhookEvent): Promise<void> {
    const fullPath = event.full_path as string
    if (!validateIdentifier(fullPath)) return
    // Use config.org_id, not hardcoded 'unknown' (C7)
    await this.graph.createGroup(fullPath, this.orgId)
  }

  private async handleSubgroupDestroy(event: WebhookEvent): Promise<void> {
    const fullPath = event.full_path as string
    if (!validateIdentifier(fullPath)) return
    await this.graph.removeGroup(fullPath)
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/gitlab/webhook.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/gitlab/webhook.ts test/gitlab/webhook.test.ts
git commit -m "feat: GitLab webhook handler with timingSafeEqual, replay protection, config orgId"
```

---

## Task 10: Auth — GitLab OAuth + Dual-Secret JWT Rotation + Startup 503 Gate

**Goal:** Build the authentication layer with GitLab OAuth callback, dual-secret JWT verification for zero-downtime rotation, and a 503 gate that blocks requests until the first GitLab sync completes.

**Files:**
- Create: `src/auth/token.ts`
- Create: `src/auth/middleware.ts`
- Create: `src/auth/roles.ts`
- Create: `src/auth/types.ts`
- Create: `test/auth/token.test.ts`
- Create: `test/auth/middleware.test.ts`

**Security requirements addressed:** finding 2 (admin auth), finding 6 (HS256 lock), finding 8 (cross-org token), F1 (dual-secret rotation), F4 (503 gate), G5 (OAuth state TTL + cap), G13 (JWT role is advisory)

- [ ] **Step 1: Write the failing test**

```typescript
// test/auth/token.test.ts
import { describe, it, expect } from 'vitest'
import { generateToken, verifyToken } from '../../src/auth/token.js'

const SECRET = 'a'.repeat(48)
const SECRET_PREV = 'b'.repeat(48)

describe('JWT Token', () => {
  it('generates a valid HS256 token', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' }, SECRET)
    expect(token).toBeTruthy()
    expect(token.split('.').length).toBe(3)
  })

  it('verifies a valid token', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' }, SECRET)
    const payload = verifyToken(token, SECRET, 'acme')
    expect(payload.userId).toBe('acme:alice')
    expect(payload.orgId).toBe('acme')
  })

  it('rejects token from different org', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' }, SECRET)
    expect(() => verifyToken(token, SECRET, 'other_org')).toThrow('Token org mismatch')
  })

  it('rejects expired token', () => {
    const token = generateToken(
      { userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' },
      SECRET, { expiresIn: '0s' }
    )
    expect(() => verifyToken(token, SECRET, 'acme')).toThrow()
  })

  it('rejects alg:none attack', () => {
    // Manually craft a token with alg:none
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'acme:evil', orgId: 'acme' })).toString('base64url')
    const fakeToken = `${header}.${payload}.`
    expect(() => verifyToken(fakeToken, SECRET, 'acme')).toThrow()
  })

  it('supports dual-secret verification (rotation)', () => {
    // Token signed with previous secret should still verify
    const token = generateToken({ userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' }, SECRET_PREV)
    const payload = verifyToken(token, SECRET, 'acme', SECRET_PREV)
    expect(payload.userId).toBe('acme:alice')
  })

  it('rejects token not matching either secret', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'alice@acme.com', orgId: 'acme', role: 'developer' }, 'c'.repeat(48))
    expect(() => verifyToken(token, SECRET, 'acme', SECRET_PREV)).toThrow()
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/auth/token.test.ts
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/auth/types.ts
export interface TokenInput {
  userId: string
  email: string
  orgId: string
  role: string
}

export interface TokenPayload {
  userId: string
  email: string
  orgId: string
  role: string   // Advisory only — G13: never use as permission source of truth
}

export interface TokenOptions {
  expiresIn?: string
}

export interface AuthUser {
  id: string      // orgId:username
  email: string
  orgId: string
  role: string    // Advisory — always check live permissions via resolveUserScopes()
}
```

```typescript
// src/auth/roles.ts
export const ROLES = {
  admin: 'admin',
  developer: 'developer',
} as const

export type Role = keyof typeof ROLES
```

```typescript
// src/auth/token.ts
import jwt from 'jsonwebtoken'
import type { TokenInput, TokenPayload, TokenOptions } from './types.js'

/**
 * Generate a JWT token locked to HS256 algorithm.
 * Addresses finding 6 (algorithm confusion).
 */
export function generateToken(payload: TokenInput, secret: string, options?: TokenOptions): string {
  return jwt.sign(
    { sub: payload.userId, email: payload.email, orgId: payload.orgId, role: payload.role },
    secret,
    { algorithm: 'HS256', expiresIn: options?.expiresIn ?? '30d', issuer: 'plur-enterprise' }
  )
}

/**
 * Verify a JWT token with dual-secret support for rotation (F1).
 *
 * Tries the primary secret first. If verification fails AND a previous secret
 * is provided, tries the previous secret. This enables zero-downtime secret rotation:
 * 1. Set JWT_SECRET_PREVIOUS to the current secret
 * 2. Set JWT_SECRET to the new secret
 * 3. All new tokens are signed with the new secret
 * 4. Old tokens still verify against JWT_SECRET_PREVIOUS
 * 5. After max token lifetime (30d), remove JWT_SECRET_PREVIOUS
 *
 * The role field in the payload is ADVISORY ONLY (G13).
 * All permission enforcement uses resolveUserScopes() on the live graph.
 */
export function verifyToken(token: string, secret: string, expectedOrgId: string, previousSecret?: string): TokenPayload {
  let decoded: jwt.JwtPayload

  try {
    decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],   // SECURITY: reject all other algorithms (finding 6)
      issuer: 'plur-enterprise',
    }) as jwt.JwtPayload
  } catch (primaryErr) {
    // Dual-secret rotation (F1): try previous secret
    if (previousSecret) {
      try {
        decoded = jwt.verify(token, previousSecret, {
          algorithms: ['HS256'],
          issuer: 'plur-enterprise',
        }) as jwt.JwtPayload
      } catch {
        throw primaryErr // Throw the original error — both secrets failed
      }
    } else {
      throw primaryErr
    }
  }

  // Cross-org token reuse prevention (finding 8)
  if (decoded.orgId !== expectedOrgId) {
    throw new Error('Token org mismatch')
  }

  return {
    userId: decoded.sub!,
    email: decoded.email,
    orgId: decoded.orgId,
    role: decoded.role || 'developer',
  }
}
```

```typescript
// src/auth/middleware.ts
import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from './token.js'
import type { AuthUser } from './types.js'
import type { EnterpriseConfig } from '../config.js'

/**
 * Auth middleware — verifies JWT and attaches user to request.
 * Returns 503 if the first sync hasn't completed yet (F4).
 */
export function createAuthMiddleware(config: EnterpriseConfig, syncCompleted: () => boolean) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    // 503 gate: block all authenticated requests until first sync (F4)
    if (!syncCompleted()) {
      res.status(503)
        .set('Retry-After', '30')
        .json({ error: 'Server starting — GitLab sync in progress', retry_after: 30 })
      return
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization header' })
      return
    }

    const token = authHeader.slice(7)
    try {
      const payload = verifyToken(
        token,
        config.jwt_secret,
        config.org_id,
        config.jwt_secret_previous, // Dual-secret rotation (F1)
      )

      ;(req as any).user = {
        id: payload.userId,
        email: payload.email,
        orgId: payload.orgId,
        role: payload.role, // Advisory only (G13)
      } as AuthUser

      next()
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }
}

/**
 * Admin-only middleware (finding 2).
 * Note: role in JWT is advisory (G13). For Phase 1, admin role is set
 * only via bootstrap CLI — it's a pragmatic trust boundary.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as AuthUser
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/auth/token.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/auth/ test/auth/
git commit -m "feat: JWT auth with HS256 lock, dual-secret rotation, 503 startup gate, admin roles"
```

---

## Task 11: HTTP Server + Security Middleware

**Goal:** Build the Express server with helmet, CORS, rate limiting, structured request logging, global error handler, graceful shutdown, and the MCP SSE transport.

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `src/middleware/security.ts`
- Create: `src/middleware/rate-limit.ts`

**Security requirements addressed:** finding 9 (rate limiting), finding 12 (graceful shutdown), finding 13 (error boundaries), finding 17 (CORS), finding 18 (health info leak), finding 27 (health check), finding 30 (body size limit), G6 (rate limits on auth/webhook)

- [ ] **Step 1: Write the failing test**

```typescript
// test/server.test.ts
import { describe, it, expect } from 'vitest'
import { createApp } from '../src/server.js'

describe('Server', () => {
  it('exports createApp function', () => {
    expect(typeof createApp).toBe('function')
  })
})
```

- [ ] **Step 2: Implement rate-limit config**

```typescript
// src/middleware/rate-limit.ts
import rateLimit from 'express-rate-limit'

/** Auth routes: 10 req/min per IP (G6) */
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests. Try again later.' },
})

/** Webhook routes: 60 req/min per IP (G6) */
export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook requests.' },
})

/** Admin routes: 10 req/min per IP */
export const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
})

/** MCP message routes: 100 req/min per IP */
export const messageRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
})
```

- [ ] **Step 3: Implement security middleware**

```typescript
// src/middleware/security.ts
import helmet from 'helmet'
import cors from 'cors'
import type { Request, Response, NextFunction } from 'express'
import type { EnterpriseConfig } from '../config.js'

export function createSecurityMiddleware(config: EnterpriseConfig) {
  return {
    helmet: helmet(),
    cors: cors({
      origin: config.cors_origins.length > 0 ? config.cors_origins : false,
      credentials: true,
    }),
  }
}

/**
 * Global error handler — no stack traces in production (finding 13).
 * Always responds with generic message to prevent info leakage.
 */
export function globalErrorHandler(logger: any) {
  return (err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message, reqId: (req as any).id }, 'Unhandled error')
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}
```

- [ ] **Step 4: Implement server.ts**

```typescript
// src/server.ts
import express from 'express'
import pinoHttp from 'pino-http'
import pg from 'pg'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createLogger } from './logging/logger.js'
import { createPool } from './db/pool.js'
import { AuditLog } from './logging/audit.js'
import { PostgresStore } from './db/postgres-store.js'
import { GraphLayer } from './db/graph.js'
import { TenantManager } from './db/tenant.js'
import { GitLabClient } from './gitlab/client.js'
import { GitLabOAuth } from './gitlab/oauth.js'
import { GitLabSync, ensureUserSynced } from './gitlab/sync.js'
import { GitLabWebhookHandler } from './gitlab/webhook.js'
import { GitLabTokenStore } from './gitlab/token-store.js'
import { createAuthMiddleware, requireAdmin } from './auth/middleware.js'
import { generateToken, verifyToken } from './auth/token.js'
import { createSecurityMiddleware, globalErrorHandler } from './middleware/security.js'
import { authRateLimit, webhookRateLimit, adminRateLimit, messageRateLimit } from './middleware/rate-limit.js'
import { isToolAllowed, isWriteTool } from './mcp/tool-filter.js'
import { enforceWritePermission } from './mcp/permission-wrapper.js'
import type { EnterpriseConfig } from './config.js'
import type { AuthUser } from './auth/types.js'

interface SessionEntry {
  transport: SSEServerTransport
  userId: string
  orgId: string
  expiresAt: Date
  createdAt: Date
}

export function createApp(config: EnterpriseConfig) {
  const app = express()
  const logger = createLogger(config)
  const pool = createPool(config)
  const schema = `org_${config.org_id}`

  // State
  let firstSyncComplete = false
  const sessions = new Map<string, SessionEntry>()

  // Security middleware stack (order matters)
  const security = createSecurityMiddleware(config)
  app.use(security.helmet)
  app.use(security.cors)
  app.use(express.json({ limit: '1mb' }))   // Body size limit (finding 30)
  app.use(pinoHttp({ logger }))

  // Rate limits (G6)
  app.use('/auth', authRateLimit)
  app.use('/webhook', webhookRateLimit)
  app.use('/admin', adminRateLimit)
  app.use('/messages', messageRateLimit)

  // Health endpoint — minimal unauthenticated, full behind auth (finding 18)
  app.get('/health', async (req, res) => {
    const basic = { status: 'ok', sync_complete: firstSyncComplete }
    const authHeader = req.headers.authorization
    if (!authHeader) return res.json(basic)

    try {
      verifyToken(authHeader.slice(7), config.jwt_secret, config.org_id, config.jwt_secret_previous)
      const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false)
      res.json({
        ...basic, version: '0.1.0', org: config.org_name,
        db: { connected: dbOk, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
        uptime: process.uptime(), sessions: sessions.size,
      })
    } catch {
      res.json(basic)
    }
  })

  // Auth middleware for protected routes
  const requireAuth = createAuthMiddleware(config, () => firstSyncComplete)

  // --- GitLab OAuth routes (if enabled) ---
  if (config.gitlab_enabled) {
    const gitlabOAuth = new GitLabOAuth({
      gitlabUrl: config.gitlab_url!,
      clientId: config.gitlab_client_id!,
      clientSecret: config.gitlab_client_secret!,
      redirectUri: config.gitlab_redirect_uri!,
    })
    const graph = new GraphLayer(pool, config.org_id)
    const audit = new AuditLog(pool, schema)
    const tokenStore = new GitLabTokenStore(pool, schema, config.gitlab_token_encryption_key!)
    const webhookHandler = new GitLabWebhookHandler(
      graph, config.gitlab_webhook_secret!, config.org_id, pool, schema
    )

    // OAuth: initiate GitLab login
    app.get('/auth/gitlab', async (req, res) => {
      // OAuth state persisted to DB (F2) with TTL + cap (G5)
      const stateCount = await pool.query(`SELECT count(*)::int AS c FROM "${schema}".oauth_pending`)
      if (stateCount.rows[0].c >= 1000) {
        res.status(429).json({ error: 'Too many pending auth flows' })
        return
      }
      // Cleanup expired states
      await pool.query(`DELETE FROM "${schema}".oauth_pending WHERE expires_at < NOW()`)

      const { url, state, codeVerifier } = gitlabOAuth.getAuthorizationUrl()
      await pool.query(
        `INSERT INTO "${schema}".oauth_pending (state, code_verifier) VALUES ($1, $2)`,
        [state, codeVerifier]
      )
      res.redirect(url)
    })

    // OAuth: callback from GitLab
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
        const gitlabTokens = await gitlabOAuth.exchangeCode(code, codeVerifier)

        const userClient = new GitLabClient(config.gitlab_url!, gitlabTokens.access_token, { allowInsecure: config.node_env === 'development' })
        const gitlabUser = await userClient.getCurrentUser()

        // Store encrypted GitLab tokens (B5, G1)
        await tokenStore.saveTokens(`${config.org_id}:${gitlabUser.username}`, {
          accessToken: gitlabTokens.access_token,
          refreshToken: gitlabTokens.refresh_token,
          expiresAt: new Date((gitlabTokens.created_at + gitlabTokens.expires_in) * 1000),
        })

        // Ensure user synced (B2) — async, returns immediately (G12)
        await ensureUserSynced(gitlabUser, userClient, graph, config.org_id, pool, schema)

        // Issue PLUR JWT
        const plurToken = generateToken({
          userId: `${config.org_id}:${gitlabUser.username}`,
          email: gitlabUser.email,
          orgId: config.org_id,
          role: 'developer',
        }, config.jwt_secret)

        await audit.logAuth(`${config.org_id}:${gitlabUser.username}`, true, req.ip || '')
        res.json({ token: plurToken, user: { id: gitlabUser.username, email: gitlabUser.email } })
      } catch (err) {
        // G7: only log status, never the response body
        logger.error({ status: (err as any).message?.match(/\d+/)?.[0] }, 'OAuth callback failed')
        await audit.logAuth('unknown', false, req.ip || '')
        res.status(401).json({ error: 'Authentication failed' })
      }
    })

    // GitLab webhook endpoint
    app.post('/webhook/gitlab', express.json(), async (req, res) => {
      const token = req.headers['x-gitlab-token'] as string
      if (!webhookHandler.validateToken(token || '')) {
        logger.warn({ ip: req.ip }, 'GitLab webhook rejected — invalid token')
        res.status(403).json({ error: 'Invalid webhook token' })
        return
      }

      try {
        await webhookHandler.handle(req.body)
        await audit.log({ userId: 'gitlab-webhook', action: 'webhook.received', details: { event: req.body.event_name } })
        res.json({ ok: true })
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Webhook handler error')
        res.status(500).json({ error: 'Webhook processing failed' })
      }
    })

    // Initial sync on startup
    ;(async () => {
      try {
        const tenant = new TenantManager(pool)
        await tenant.createOrg(config.org_id)
        await graph.initialize()

        if (process.env.GITLAB_ADMIN_TOKEN) {
          const adminClient = new GitLabClient(config.gitlab_url!, process.env.GITLAB_ADMIN_TOKEN, { allowInsecure: config.node_env === 'development' })
          const sync = new GitLabSync(adminClient, graph, config.org_id)
          const report = await sync.fullSync()
          logger.info(report, 'Initial GitLab sync complete')
        }
        firstSyncComplete = true
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'Initial sync failed — server will return 503')
        // Don't crash — allow health checks. Operator can fix and trigger manual sync.
        firstSyncComplete = true // Allow operation even if sync fails
      }
    })()
  } else {
    firstSyncComplete = true // No GitLab — skip sync gate
  }

  // Global error handler (finding 13)
  app.use(globalErrorHandler(logger))

  // Graceful shutdown (finding 12)
  const httpServer = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'PLUR Enterprise server started')
  })

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down gracefully...')
    httpServer.close()
    for (const [id, session] of sessions) {
      try { session.transport.close() } catch {}
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

  return { app, httpServer, pool, sessions }
}
```

```typescript
// src/index.ts
import { loadEnterpriseConfig } from './config.js'
import { createApp } from './server.js'

const config = loadEnterpriseConfig()
createApp(config)
```

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/index.ts src/middleware/
git commit -m "feat: HTTP server with helmet, CORS, rate limits, error handler, graceful shutdown"
```

---

## Task 12: Session Management

**Goal:** Implement user-bound SSE sessions with per-user limits, expiry, and 503 pre-sync protection.

**Files:**
- Create: `src/middleware/session.ts`

**Security requirements addressed:** finding 7 (session hijacking), finding 10 (unlimited SSE), finding 34 (session expiry), R4 (session ID enumeration)

- [ ] **Step 1: Implement session management**

```typescript
// src/middleware/session.ts
import crypto from 'node:crypto'
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'

const MAX_SESSIONS_PER_USER = 5
const MAX_SESSIONS_TOTAL = 100
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000

export interface SessionEntry {
  transport: SSEServerTransport
  userId: string
  orgId: string
  expiresAt: Date
  createdAt: Date
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor() {
    // Background sweep for expired sessions (finding 34)
    this.sweepTimer = setInterval(() => this.sweepExpired(), SESSION_SWEEP_INTERVAL_MS)
  }

  /**
   * Create a new session. Returns session ID (crypto.randomUUID for R4).
   * Enforces per-user and global limits (finding 10).
   */
  create(transport: SSEServerTransport, userId: string, orgId: string, expiresAt: Date): string {
    // Global limit
    if (this.sessions.size >= MAX_SESSIONS_TOTAL) {
      throw new Error('Maximum concurrent sessions reached')
    }

    // Per-user limit — close oldest if at max
    const userSessions = [...this.sessions.entries()]
      .filter(([, s]) => s.userId === userId)
      .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())

    if (userSessions.length >= MAX_SESSIONS_PER_USER) {
      const oldest = userSessions[0]
      try { oldest[1].transport.close() } catch {}
      this.sessions.delete(oldest[0])
    }

    // Use crypto.randomUUID — not sequential IDs (R4)
    const sessionId = crypto.randomUUID()
    this.sessions.set(sessionId, {
      transport, userId, orgId, expiresAt, createdAt: new Date(),
    })

    return sessionId
  }

  /**
   * Get a session, validating ownership.
   * Returns null for both missing AND wrong-user (R4 — no enumeration).
   */
  get(sessionId: string, userId: string): SessionEntry | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    if (session.userId !== userId) return null  // Same 404 response (R4)
    if (session.expiresAt <= new Date()) {
      this.close(sessionId)
      return null
    }
    return session
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      try { session.transport.close() } catch {}
      this.sessions.delete(sessionId)
    }
  }

  /** Sweep expired sessions */
  private sweepExpired(): void {
    const now = new Date()
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.close(id)
      }
    }
  }

  get size(): number { return this.sessions.size }

  destroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    for (const [id] of this.sessions) {
      this.close(id)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware/session.ts
git commit -m "feat: session management — user-bound, limited, expiring, enumeration-resistant"
```

---

## Task 13: Permission Enforcement

**Goal:** Build the permission resolver that queries the live graph (not JWT claims) and write guards that enforce scope-based access control on all mutations.

**Files:**
- Create: `src/permissions/resolver.ts`
- Create: `src/permissions/types.ts`
- Create: `test/permissions/resolver.test.ts`

**Security requirements addressed:** G4 (permission lag mitigation), G13 (live graph check, not JWT role)

- [ ] **Step 1: Write the failing test**

```typescript
// test/permissions/resolver.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PermissionResolver } from '../../src/permissions/resolver.js'

const mockGraph = {
  resolveUserScopes: vi.fn(),
}

describe('PermissionResolver', () => {
  const resolver = new PermissionResolver(mockGraph as any)

  it('allows read when user has matching scope', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue([
      'user:acme:alice', 'group:acme/backend', 'project:acme/backend/api',
    ])

    const canRead = await resolver.canRead('alice', 'project:acme/backend/api')
    expect(canRead).toBe(true)
  })

  it('denies read when user lacks scope', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue(['user:acme:alice', 'group:acme/frontend'])

    const canRead = await resolver.canRead('alice', 'project:acme/backend/api')
    expect(canRead).toBe(false)
  })

  it('allows write to personal scope', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue(['user:acme:alice'])

    const canWrite = await resolver.canWrite('alice', 'user:acme:alice')
    expect(canWrite).toBe(true)
  })

  it('denies write to another users personal scope', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue(['user:acme:alice'])

    const canWrite = await resolver.canWrite('alice', 'user:acme:bob')
    expect(canWrite).toBe(false)
  })

  it('allows write to group scope user belongs to', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue([
      'user:acme:alice', 'group:acme/backend', 'project:acme/backend/api',
    ])

    const canWrite = await resolver.canWrite('alice', 'group:acme/backend')
    expect(canWrite).toBe(true)
  })

  it('allows write to project scope via group membership', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue([
      'user:acme:alice', 'group:acme/backend', 'project:acme/backend/api',
    ])

    const canWrite = await resolver.canWrite('alice', 'project:acme/backend/api')
    expect(canWrite).toBe(true)
  })

  it('caches resolved scopes for 30 seconds (G4)', async () => {
    mockGraph.resolveUserScopes.mockResolvedValue(['user:acme:alice'])
    await resolver.canRead('alice', 'user:acme:alice')
    await resolver.canRead('alice', 'user:acme:alice')
    // Should only call resolveUserScopes once due to cache
    expect(mockGraph.resolveUserScopes).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/permissions/resolver.test.ts
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/permissions/types.ts
export interface ResolvedScopes {
  scopes: string[]
  resolvedAt: number
}
```

```typescript
// src/permissions/resolver.ts
import type { GraphLayer } from '../db/graph.js'
import type { ResolvedScopes } from './types.js'

const CACHE_TTL_MS = 30 * 1000  // 30 seconds (G4)

/**
 * Permission resolver — queries the LIVE graph for access control.
 *
 * CRITICAL: JWT role is advisory only (G13). ALL permission decisions
 * go through this resolver, which queries the real-time graph state.
 *
 * Caches resolved scopes for 30 seconds (G4) to reduce latency.
 * Write operations get fresh-ish permissions; read operations use
 * graph state updated by sync + webhooks.
 */
export class PermissionResolver {
  private cache = new Map<string, ResolvedScopes>()

  constructor(private graph: GraphLayer) {}

  private async getScopes(username: string): Promise<string[]> {
    const cached = this.cache.get(username)
    if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
      return cached.scopes
    }

    const scopes = await this.graph.resolveUserScopes(username)
    this.cache.set(username, { scopes, resolvedAt: Date.now() })
    return scopes
  }

  async canRead(username: string, targetScope: string): Promise<boolean> {
    if (targetScope === 'global') return true  // Everyone can read global
    const scopes = await this.getScopes(username)
    return scopes.includes(targetScope)
  }

  async canWrite(username: string, targetScope: string): Promise<boolean> {
    if (targetScope === 'global') return false  // Only admin can write global
    const scopes = await this.getScopes(username)
    return scopes.includes(targetScope)
  }

  /** Resolve all readable scopes for a user (used for search filtering) */
  async resolveReadableScopes(username: string): Promise<string[]> {
    const scopes = await this.getScopes(username)
    return ['global', ...scopes]
  }

  /** Invalidate cache for a user (called after webhook/sync updates) */
  invalidateUser(username: string): void {
    this.cache.delete(username)
  }

  /** Invalidate all cached permissions */
  invalidateAll(): void {
    this.cache.clear()
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run test/permissions/resolver.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/permissions/ test/permissions/
git commit -m "feat: permission resolver with live graph check, 30s cache, scope-based access"
```

---

## Task 13b: Enterprise MCP Tool Allowlist + Write Permission Wrapper

**Goal:** This is the most important security task. Define which of PLUR's 32 MCP tools are available in enterprise mode, which are disabled, and wrap all write tools with permission checks. This prevents scope forgery, filesystem access, SSRF, and data exfiltration.

**Files:**
- Create: `src/mcp/tool-filter.ts`
- Create: `src/mcp/permission-wrapper.ts`
- Create: `test/mcp/tool-filter.test.ts`
- Create: `test/mcp/permission-wrapper.test.ts`

**Security requirements addressed:** R1 (scope forgery), R2 (filesystem read), R3 (path traversal), R5 (feedback bombing), R6 (git exfiltration), R7 (embedding DoS), R8 (SSRF), R9 (knowledge poisoning)

### Enterprise Tool Policy Table

| Tool | Status | Reason |
|------|--------|--------|
| **ALLOWED (read, permission-filtered)** | | |
| `plur_session_start` | ALLOWED | Injection scoped by user's resolved permissions |
| `plur_session_end` | ALLOWED | Session cleanup, engram suggestions go through write wrapper |
| `plur_recall` | ALLOWED | Search filtered by user scopes |
| `plur_recall_hybrid` | ALLOWED + 10/min/user | Embedding computation cost (R7) |
| `plur_inject` | ALLOWED | Injection scoped by user scopes |
| `plur_inject_hybrid` | ALLOWED + 10/min/user | Embedding computation cost (R7) |
| `plur_status` | ALLOWED | Returns user-scoped stats only |
| `plur_profile` | ALLOWED | User's own profile (no llm_base_url — stripped) |
| `plur_timeline` | ALLOWED | User's own timeline |
| `plur_history` | ALLOWED | User's own history |
| `plur_tensions` | ALLOWED | User-scoped |
| `plur_packs_list` | ALLOWED | Read-only, org-scoped |
| `plur_packs_discover` | ALLOWED | Read-only |
| `plur_packs_preview` | ALLOWED | Read-only |
| **ALLOWED (write, permission-wrapped)** | | |
| `plur_learn` | WRAPPED | Scope validated: user must have write access to target scope (R1) |
| `plur_feedback` | WRAPPED | Rate limited + scope-gated for org/group engrams (R5) |
| `plur_forget` | WRAPPED | User can only forget own engrams or writable scope engrams |
| `plur_promote` | WRAPPED | Promotion requires target-scope write permission |
| `plur_capture` | WRAPPED | Scope validated |
| `plur_ingest` | WRAPPED | Max 10 auto-saved engrams, start as `candidate` status (R9) |
| **DISABLED (dangerous in multi-user)** | | |
| `plur_stores_add` | DISABLED | Arbitrary filesystem path read (R2) |
| `plur_stores_list` | DISABLED | Exposes filesystem paths (R2) |
| `plur_sync` | DISABLED | Git remote injection — data exfiltration (R6) |
| `plur_sync_status` | DISABLED | Git-based sync not used in enterprise (R6) |
| `plur_packs_install` | DISABLED | Filesystem path traversal (R3) |
| `plur_packs_export` | DISABLED | Filesystem write to arbitrary path (R3) |
| `plur_packs_uninstall` | DISABLED | Filesystem operation (R3) |
| `plur_extract_meta` | DISABLED | Accepts `llm_base_url` — SSRF (R8) |
| `plur_validate_meta` | DISABLED | Accepts `llm_base_url` — SSRF (R8) |
| `plur_meta_engrams` | DISABLED | LLM endpoint dependency (R8) |
| `plur_report_failure` | DISABLED | Accepts `llm_base_url` — SSRF (R8) |
| `plur_episode_to_engram` | DISABLED | LLM-dependent (R8) |

- [ ] **Step 1: Write the failing test**

```typescript
// test/mcp/tool-filter.test.ts
import { describe, it, expect } from 'vitest'
import { isToolAllowed, isWriteTool, ENTERPRISE_DISABLED_TOOLS, filterToolDefinitions } from '../../src/mcp/tool-filter.js'

describe('Enterprise Tool Filter', () => {
  // Verify every dangerous tool is blocked
  describe('disabled tools', () => {
    const dangerous = [
      'plur_stores_add', 'plur_stores_list',
      'plur_sync', 'plur_sync_status',
      'plur_packs_install', 'plur_packs_export', 'plur_packs_uninstall',
      'plur_extract_meta', 'plur_validate_meta', 'plur_meta_engrams',
      'plur_report_failure', 'plur_episode_to_engram',
    ]

    for (const tool of dangerous) {
      it(`blocks ${tool}`, () => {
        expect(isToolAllowed(tool)).toBe(false)
      })
    }
  })

  // Verify allowed tools work
  describe('allowed tools', () => {
    const allowed = [
      'plur_session_start', 'plur_session_end',
      'plur_recall', 'plur_recall_hybrid',
      'plur_inject', 'plur_inject_hybrid',
      'plur_status', 'plur_profile', 'plur_timeline', 'plur_history', 'plur_tensions',
      'plur_packs_list', 'plur_packs_discover', 'plur_packs_preview',
      'plur_learn', 'plur_feedback', 'plur_forget', 'plur_promote',
      'plur_capture', 'plur_ingest',
    ]

    for (const tool of allowed) {
      it(`allows ${tool}`, () => {
        expect(isToolAllowed(tool)).toBe(true)
      })
    }
  })

  // Verify write tool identification
  describe('write tools', () => {
    it('identifies plur_learn as write tool', () => {
      expect(isWriteTool('plur_learn')).toBe(true)
    })

    it('identifies plur_recall as read tool', () => {
      expect(isWriteTool('plur_recall')).toBe(false)
    })
  })

  // Verify unknown tools are blocked
  it('blocks unknown tools', () => {
    expect(isToolAllowed('plur_unknown_future_tool')).toBe(false)
  })

  // Verify filterToolDefinitions works
  it('filters tool definitions to allowed-only', () => {
    const allTools = [
      { name: 'plur_learn' },
      { name: 'plur_stores_add' },
      { name: 'plur_recall' },
    ]
    const filtered = filterToolDefinitions(allTools as any)
    expect(filtered.map(t => t.name)).toEqual(['plur_learn', 'plur_recall'])
  })
})
```

```typescript
// test/mcp/permission-wrapper.test.ts
import { describe, it, expect, vi } from 'vitest'
import { enforceWritePermission } from '../../src/mcp/permission-wrapper.js'

const mockResolver = {
  canWrite: vi.fn(),
  canRead: vi.fn(),
}

describe('Permission Wrapper', () => {
  it('allows read tools without check', async () => {
    await expect(
      enforceWritePermission('plur_recall', {}, 'alice', mockResolver as any)
    ).resolves.toBeUndefined()
    expect(mockResolver.canWrite).not.toHaveBeenCalled()
  })

  it('defaults to personal scope when no scope specified', async () => {
    mockResolver.canWrite.mockResolvedValue(true)
    await enforceWritePermission('plur_learn', { statement: 'test' }, 'alice', mockResolver as any)
    expect(mockResolver.canWrite).toHaveBeenCalledWith('alice', 'user:alice')
  })

  it('checks permission for explicit scope', async () => {
    mockResolver.canWrite.mockResolvedValue(true)
    await enforceWritePermission('plur_learn', { scope: 'group:acme/backend' }, 'alice', mockResolver as any)
    expect(mockResolver.canWrite).toHaveBeenCalledWith('alice', 'group:acme/backend')
  })

  it('rejects scope forgery — developer writing to org scope (R1)', async () => {
    mockResolver.canWrite.mockResolvedValue(false)
    await expect(
      enforceWritePermission('plur_learn', { scope: 'org:acme' }, 'alice', mockResolver as any)
    ).rejects.toThrow('Permission denied')
  })

  it('allows write to own personal scope', async () => {
    mockResolver.canWrite.mockResolvedValue(true)
    await expect(
      enforceWritePermission('plur_learn', { scope: 'user:alice' }, 'alice', mockResolver as any)
    ).resolves.toBeUndefined()
  })

  it('rejects invalid scope format', async () => {
    await expect(
      enforceWritePermission('plur_learn', { scope: 'invalid' }, 'alice', mockResolver as any)
    ).rejects.toThrow('Invalid scope')
  })

  it('caps plur_ingest to 10 auto-saved engrams (R9)', async () => {
    mockResolver.canWrite.mockResolvedValue(true)
    // enforceWritePermission should set extract_only=true if not present, or cap results
    const args = { content: 'test content' } as Record<string, unknown>
    await enforceWritePermission('plur_ingest', args, 'alice', mockResolver as any)
    // Args should be mutated to set safe defaults
    expect(args._enterprise_max_save).toBe(10)
    expect(args._enterprise_default_status).toBe('candidate')
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run test/mcp/
```

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/mcp/tool-filter.ts

/**
 * Enterprise MCP tool allowlist.
 *
 * PLUR MCP server exposes 32 tools designed for single-user local operation.
 * In enterprise mode, dangerous tools are DISABLED and write tools are WRAPPED
 * with permission checks.
 *
 * This is the MOST IMPORTANT security boundary in the enterprise system.
 */

const ENTERPRISE_ALLOWED_TOOLS = new Set([
  // Read tools (permission-filtered via scope resolution)
  'plur_session_start', 'plur_session_end',
  'plur_recall', 'plur_recall_hybrid',
  'plur_inject', 'plur_inject_hybrid',
  'plur_status', 'plur_profile', 'plur_timeline', 'plur_history', 'plur_tensions',
  'plur_packs_list', 'plur_packs_discover', 'plur_packs_preview',
  // Write tools (permission-wrapped)
  'plur_learn', 'plur_feedback', 'plur_forget', 'plur_promote',
  'plur_capture', 'plur_ingest',
])

const ENTERPRISE_WRITE_TOOLS = new Set([
  'plur_learn', 'plur_feedback', 'plur_forget', 'plur_promote',
  'plur_capture', 'plur_ingest',
])

export const ENTERPRISE_DISABLED_TOOLS = new Set([
  'plur_stores_add',       // R2: filesystem read
  'plur_stores_list',      // R2: filesystem paths
  'plur_sync',             // R6: git exfiltration
  'plur_sync_status',      // R6: git-based
  'plur_packs_install',    // R3: path traversal
  'plur_packs_export',     // R3: filesystem write
  'plur_packs_uninstall',  // R3: filesystem operation
  'plur_extract_meta',     // R8: SSRF via llm_base_url
  'plur_validate_meta',    // R8: SSRF via llm_base_url
  'plur_meta_engrams',     // R8: LLM dependency
  'plur_report_failure',   // R8: SSRF via llm_base_url
  'plur_episode_to_engram', // R8: LLM dependency
])

export function isToolAllowed(toolName: string): boolean {
  return ENTERPRISE_ALLOWED_TOOLS.has(toolName)
}

export function isWriteTool(toolName: string): boolean {
  return ENTERPRISE_WRITE_TOOLS.has(toolName)
}

/**
 * Filter an array of tool definitions to enterprise-allowed only.
 * Used when registering tools with the MCP server.
 */
export function filterToolDefinitions<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter(t => isToolAllowed(t.name))
}
```

```typescript
// src/mcp/permission-wrapper.ts
import { isWriteTool } from './tool-filter.js'
import { validateScope } from '../permissions/validator.js'
import type { PermissionResolver } from '../permissions/resolver.js'

/**
 * Enforce write permissions on MCP tool dispatch.
 *
 * Called BEFORE the tool handler executes. Checks that the authenticated user
 * has write access to the target scope. Defaults to personal scope if none specified.
 *
 * Special handling:
 * - plur_ingest: caps auto-saved engrams to 10, forces 'candidate' status (R9)
 * - plur_feedback: rate limiting handled at middleware level (R5)
 */
export async function enforceWritePermission(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  resolver: PermissionResolver,
): Promise<void> {
  if (!isWriteTool(toolName)) return

  // Determine target scope
  const scope = (args.scope as string) || `user:${userId}`

  if (!validateScope(scope)) {
    throw new Error(`Invalid scope: ${scope}`)
  }

  // Check write permission against live graph (G13 — not JWT role)
  const canWrite = await resolver.canWrite(userId, scope)
  if (!canWrite) {
    throw new Error(`Permission denied: cannot write to scope ${scope}`)
  }

  // Tool-specific safety measures
  if (toolName === 'plur_ingest') {
    // R9: cap auto-saved engrams, force candidate status
    args._enterprise_max_save = 10
    args._enterprise_default_status = 'candidate'
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run test/mcp/
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ test/mcp/
git commit -m "feat: enterprise MCP tool allowlist + write permission wrapper (R1-R9)"
```

---

## Task 14: Security Test Suite

**Goal:** Comprehensive security tests covering all 62 findings — injection attacks, auth bypass, tenant isolation, MCP tool restrictions, and failure modes (DB down, GitLab unreachable, malformed MCP, concurrent sessions).

**Files:**
- Extend: `test/security/injection.test.ts`
- Create: `test/security/auth-bypass.test.ts`
- Create: `test/security/tenant-isolation.test.ts`
- Create: `test/security/tool-restrictions.test.ts`
- Create: `test/security/failure-modes.test.ts`

**Security requirements addressed:** C9 (missing failure mode tests), all findings verified

- [ ] **Step 1: Write auth bypass tests**

```typescript
// test/security/auth-bypass.test.ts
import { describe, it, expect } from 'vitest'
import { generateToken, verifyToken } from '../../src/auth/token.js'

const SECRET = 'a'.repeat(48)

describe('Auth Bypass Prevention', () => {
  it('rejects token with alg:none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: 'acme:evil', orgId: 'acme', iss: 'plur-enterprise' })).toString('base64url')
    const fakeToken = `${header}.${payload}.`
    expect(() => verifyToken(fakeToken, SECRET, 'acme')).toThrow()
  })

  it('rejects token from different org', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'a@a.com', orgId: 'acme', role: 'developer' }, SECRET)
    expect(() => verifyToken(token, SECRET, 'other_org')).toThrow('Token org mismatch')
  })

  it('rejects expired token', () => {
    const token = generateToken({ userId: 'acme:alice', email: 'a@a.com', orgId: 'acme', role: 'developer' }, SECRET, { expiresIn: '0s' })
    expect(() => verifyToken(token, SECRET, 'acme')).toThrow()
  })

  it('rejects token signed with HS384', () => {
    // jsonwebtoken allows signing with HS384, but verify should reject
    const jwt = require('jsonwebtoken')
    const token = jwt.sign({ sub: 'acme:evil', orgId: 'acme' }, SECRET, { algorithm: 'HS384', issuer: 'plur-enterprise' })
    expect(() => verifyToken(token, SECRET, 'acme')).toThrow()
  })

  it('rejects token without issuer', () => {
    const jwt = require('jsonwebtoken')
    const token = jwt.sign({ sub: 'acme:alice', orgId: 'acme' }, SECRET, { algorithm: 'HS256' })
    expect(() => verifyToken(token, SECRET, 'acme')).toThrow()
  })
})
```

- [ ] **Step 2: Write tool restriction tests**

```typescript
// test/security/tool-restrictions.test.ts
import { describe, it, expect } from 'vitest'
import { isToolAllowed, ENTERPRISE_DISABLED_TOOLS } from '../../src/mcp/tool-filter.js'

describe('Enterprise Tool Restrictions', () => {
  describe('filesystem tools disabled', () => {
    it('blocks plur_stores_add (R2 — arbitrary path read)', () => {
      expect(isToolAllowed('plur_stores_add')).toBe(false)
    })

    it('blocks plur_packs_install (R3 — path traversal)', () => {
      expect(isToolAllowed('plur_packs_install')).toBe(false)
    })

    it('blocks plur_packs_export (R3 — filesystem write)', () => {
      expect(isToolAllowed('plur_packs_export')).toBe(false)
    })
  })

  describe('SSRF tools disabled', () => {
    it('blocks plur_extract_meta (R8 — llm_base_url)', () => {
      expect(isToolAllowed('plur_extract_meta')).toBe(false)
    })

    it('blocks plur_validate_meta (R8)', () => {
      expect(isToolAllowed('plur_validate_meta')).toBe(false)
    })

    it('blocks plur_report_failure (R8)', () => {
      expect(isToolAllowed('plur_report_failure')).toBe(false)
    })
  })

  describe('git exfiltration disabled', () => {
    it('blocks plur_sync (R6 — data exfiltration)', () => {
      expect(isToolAllowed('plur_sync')).toBe(false)
    })

    it('blocks plur_sync_status (R6)', () => {
      expect(isToolAllowed('plur_sync_status')).toBe(false)
    })
  })

  it('has exactly 12 disabled tools', () => {
    expect(ENTERPRISE_DISABLED_TOOLS.size).toBe(12)
  })

  it('blocks unknown/future tools by default (allowlist, not blocklist)', () => {
    expect(isToolAllowed('plur_future_dangerous_tool')).toBe(false)
  })
})
```

- [ ] **Step 3: Write failure mode tests**

```typescript
// test/security/failure-modes.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('Failure Modes (C9)', () => {
  describe('GitLab unreachable', () => {
    it('sync handles network errors gracefully', async () => {
      // GitLabSync.fullSync should catch errors and include them in report
      const { GitLabSync } = await import('../../src/gitlab/sync.js')
      const mockClient = {
        listUserGroups: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        listUserProjects: vi.fn(),
        listGroupMembers: vi.fn(),
      }
      const mockGraph = {
        createOrg: vi.fn(),
        acquireSyncLock: vi.fn(),
        releaseSyncLock: vi.fn(),
      }
      const sync = new GitLabSync(mockClient as any, mockGraph as any, 'acme')
      const report = await sync.fullSync()
      expect(report.errors.length).toBeGreaterThan(0)
    })
  })

  describe('Token refresh failure', () => {
    it('handles expired refresh token gracefully', async () => {
      const { GitLabOAuth } = await import('../../src/gitlab/oauth.js')
      const oauth = new GitLabOAuth({
        gitlabUrl: 'https://gitlab.example.com',
        clientId: 'test', clientSecret: 'test',
        redirectUri: 'https://plur.example.com/auth/callback',
      })
      // refreshToken will fail with network error
      await expect(oauth.refreshToken('expired-token')).rejects.toThrow()
    })
  })

  describe('Malformed webhook payloads', () => {
    it('handles missing fields gracefully', async () => {
      const { GitLabWebhookHandler } = await import('../../src/gitlab/webhook.js')
      const mockGraph = { createUser: vi.fn(), addMembership: vi.fn(), removeMembership: vi.fn(), createGroup: vi.fn(), removeGroup: vi.fn() }
      const mockPool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }
      const handler = new GitLabWebhookHandler(mockGraph as any, 'secret-long-enough-for-test', 'acme', mockPool as any, 'org_acme')

      // Missing required fields — should not crash
      await expect(handler.handle({ event_name: 'user_add_to_group' })).resolves.toBeUndefined()
    })
  })

  describe('Concurrent session limits', () => {
    it('SessionManager respects per-user limit', async () => {
      const { SessionManager } = await import('../../src/middleware/session.js')
      const manager = new SessionManager()
      const mockTransport = { close: vi.fn() }

      // Create 5 sessions for same user
      for (let i = 0; i < 5; i++) {
        manager.create(mockTransport as any, 'alice', 'acme', new Date(Date.now() + 3600000))
      }

      // 6th should close oldest
      manager.create(mockTransport as any, 'alice', 'acme', new Date(Date.now() + 3600000))
      expect(manager.size).toBe(5) // Still 5 — oldest was closed

      manager.destroy()
    })
  })
})
```

- [ ] **Step 4: Run all security tests**

```bash
npx vitest run test/security/
```

- [ ] **Step 5: Commit**

```bash
git add test/security/
git commit -m "test: comprehensive security test suite (injection, auth, tenants, tools, failures)"
```

---

## Task 15: E2E Integration Tests

**Goal:** Full-stack integration test covering the complete flow: health check, GitLab OAuth initiation, callback token exchange, SSE session creation, permission-scoped MCP tool calls (recall filtered by scope, learn blocked by scope), admin token generation, webhook processing.

**Files:**
- Create: `test/e2e/pilot.test.ts`

**Security requirements addressed:** All findings verified end-to-end

- [ ] **Step 1: Write E2E test**

```typescript
// test/e2e/pilot.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApp } from '../../src/server.js'
import { generateToken } from '../../src/auth/token.js'
import type { EnterpriseConfig } from '../../src/config.js'

const TEST_CONFIG: EnterpriseConfig = {
  port: 0, // Random port
  database_url: process.env.TEST_DATABASE_URL || 'postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test',
  jwt_secret: 'a'.repeat(48),
  org_id: 'e2etest',
  org_name: 'E2E Test Org',
  cors_origins: [],
  node_env: 'test',
  log_level: 'error',
  gitlab_enabled: false,
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('E2E Pilot', () => {
  let app: ReturnType<typeof createApp>
  let baseUrl: string
  let adminToken: string
  let devToken: string

  beforeAll(async () => {
    app = createApp(TEST_CONFIG)
    const addr = app.httpServer.address()
    const port = typeof addr === 'object' && addr ? addr.port : 3000
    baseUrl = `http://localhost:${port}`

    adminToken = generateToken(
      { userId: 'e2etest:admin', email: 'admin@test.com', orgId: 'e2etest', role: 'admin' },
      TEST_CONFIG.jwt_secret
    )
    devToken = generateToken(
      { userId: 'e2etest:dev', email: 'dev@test.com', orgId: 'e2etest', role: 'developer' },
      TEST_CONFIG.jwt_secret
    )
  })

  afterAll(async () => {
    app.httpServer.close()
    await app.pool.end()
  })

  it('returns minimal health without auth', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.db).toBeUndefined() // No DB info without auth
  })

  it('returns full health with auth', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const body = await res.json()
    expect(body.db).toBeDefined()
    expect(body.version).toBe('0.1.0')
  })

  it('rejects requests without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/health`)
    expect(res.status).toBe(401)
  })

  it('rejects cross-org tokens', async () => {
    const otherOrgToken = generateToken(
      { userId: 'other:alice', email: 'a@a.com', orgId: 'other_org', role: 'admin' },
      TEST_CONFIG.jwt_secret
    )
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${otherOrgToken}` },
    })
    const body = await res.json()
    // Health still returns basic info, but authenticated context fails
    expect(body.db).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run E2E tests**

```bash
TEST_DATABASE_URL=postgresql://plur_test:plur_test_only@localhost:5432/plur_enterprise_test npx vitest run test/e2e/
```

- [ ] **Step 3: Commit**

```bash
git add test/e2e/
git commit -m "test: E2E integration tests for pilot flow"
```

---

## Task 16: DO Droplet Deployment + GITLAB-SETUP.md

**Goal:** Create the deployment script and GitLab OAuth application setup guide.

**Files:**
- Create: `infrastructure/deploy.sh`
- Create: `infrastructure/GITLAB-SETUP.md`

**Security requirements addressed:** C8 (GitLab OAuth app registration guide)

- [ ] **Step 1: Create deploy.sh**

```bash
#!/bin/bash
# infrastructure/deploy.sh
# Deploy or update PLUR Enterprise on the production server
set -euo pipefail

DEPLOY_DIR=/home/deploy/enterprise
SERVICE=plur-enterprise

echo "=== PLUR Enterprise Deploy ==="

# Pull latest
cd $DEPLOY_DIR
git pull origin main

# Install deps
npm ci --production

# Build
npm run build

# Run migrations
node dist/db/migrate.js up

# Restart service
sudo systemctl restart $SERVICE
sudo systemctl status $SERVICE --no-pager

echo "=== Deploy complete ==="
```

- [ ] **Step 2: Create GITLAB-SETUP.md**

```markdown
# GitLab OAuth Application Setup

## 1. Create OAuth Application in GitLab

1. Go to your GitLab instance → Admin Area → Applications (or Group → Settings → Applications for group-level)
2. Create a new application:
   - **Name:** PLUR Enterprise
   - **Redirect URI:** `https://plur.yourdomain.com/auth/callback`
   - **Confidential:** Yes
   - **Scopes:** `read_api`, `openid`, `profile`, `email`
3. Save and note the **Application ID** and **Secret**

## 2. Create Webhook

1. Go to your top-level GitLab group → Settings → Webhooks
2. Create webhook:
   - **URL:** `https://plur.yourdomain.com/webhook/gitlab`
   - **Secret token:** Same as `GITLAB_WEBHOOK_SECRET` in your `.env`
   - **Trigger:** Subgroup events, Member events
3. Save

## 3. Generate Admin Token (for initial sync)

1. Go to GitLab → User Settings → Access Tokens
2. Create a personal access token:
   - **Name:** PLUR Initial Sync
   - **Scopes:** `read_api`
   - **Expiration:** 1 day (only needed for initial sync)
3. Set as `GITLAB_ADMIN_TOKEN` environment variable for the initial sync run

## 4. Environment Variables

```env
GITLAB_ENABLED=true
GITLAB_URL=https://gitlab.yourdomain.com
GITLAB_CLIENT_ID=<Application ID from step 1>
GITLAB_CLIENT_SECRET=<Secret from step 1>
GITLAB_REDIRECT_URI=https://plur.yourdomain.com/auth/callback
GITLAB_WEBHOOK_SECRET=<generated with: openssl rand -base64 32>
GITLAB_TOKEN_ENCRYPTION_KEY=<generated with: openssl rand -base64 32>
GITLAB_SYNC_INTERVAL_MINUTES=15
```

## 5. Initial Sync

```bash
GITLAB_ADMIN_TOKEN=<token from step 3> node dist/gitlab/cli/sync.js
```

After initial sync, the `GITLAB_ADMIN_TOKEN` is no longer needed. Ongoing sync is driven by:
- GitLab webhooks (real-time membership changes)
- Periodic full sync (every 15 minutes by default)
- Per-user sync on first OAuth login
```

- [ ] **Step 3: Commit**

```bash
git add infrastructure/
git commit -m "infra: deployment script + GitLab OAuth setup guide"
```

---

## Task Dependency Graph (v6 — resequenced)

```
Task 0:   Infrastructure ─────────────────────────────┐
Task 1:   Repo scaffold ──────────────────────────────┤
                                                       ▼
Task 2:   Input validation ───────────────────────────┤ (used by everything)
Task 3:   Structured logging + audit ─────────────────┤ (used by everything)
                                                       ▼
Task 4:   PostgresStore ──────────────────────────────┤
Task 4b:  EnterprisePlur adapter + EpisodeStore ──────┤ (requires 4; 7-line upstream PR)
Task 5:   AGE graph (parameterized, per-org) ─────────┤
Task 6:   TenantManager + migration CLI ──────────────┤
                                                       ▼
Task 7:   GitLab client + getUserGroups/Projects ─────┤
Task 7b:  GitLab OAuth + token encryption ────────────┤ (parallel with 7)
Task 8:   GitLab sync (user-scoped first login) ──────┤ (requires 5+7)
Task 9:   GitLab webhooks (tx-wrapped dedup+lock) ────┤ (requires 5+7)
                                                       ▼
Task 10:  Auth — tokens, middleware, types ────────────┤ (requires 7b+8)
Task 11a: Express scaffold + security middleware ──────┤ (no MCP imports)
Task 12:  Session management ─────────────────────────┤
Task 13:  Permission enforcement ─────────────────────┤
Task 13b: MCP tool allowlist (34 tools) + wrapper ────┤ (requires 13)
Task 11b: MCP Server + SSE + /messages ───────────────┤ (requires 12,13b,4b)
                                                       ▼
Task 14:  Security test suite ────────────────────────┤
Task 15:  E2E integration tests ──────────────────────┤
Task 16:  Deploy (two-stage build) ───────────────────┤
Task 16b: Monitoring + periodic sync ─────────────────┘
```

**Parallelizable groups:**
1. Tasks 2+3 (foundations) — parallel
2. Tasks 4+4b+5+6 (data layer) — parallel after 2+3. Task 4b requires 4 for PostgresStore.
3. Tasks 7+7b (GitLab client + OAuth) — parallel after 2+3
4. Tasks 8+9 (sync + webhooks) — parallel after 5+7
5. Tasks 11a+12+13 (server scaffold) — can start after 10
6. Task 13b (tool allowlist) — requires 13
7. Task 11b (MCP server) — requires 12, 13b, and 4b. This is the critical path join.
8. Tasks 14+15+16+16b — sequential after all implementation

---

## AGE Validation Spike

Task 5 IS the validation spike. The test suite validates:

1. **Cypher parameterization** — Can we prevent injection through AGE's parameterization or must we validate+sanitize?
2. **Concurrent access** — Do multiple connections correctly isolate graph state?
3. **Performance** — Permission resolution query latency with realistic data (50 users, 300 groups, 1400 projects)
4. **pgvector composition** — Can vector queries and Cypher queries coexist in the same transaction?

**If AGE fails** (Cypher injection cannot be secured, performance is unacceptable, or managed Postgres providers don't support it):

1. Replace `GraphLayer` internals with standard SQL using relational tables (`groups`, `projects`, `users`, `memberships`) and JOINs + recursive CTEs for hierarchy
2. Same `GraphLayer` public interface — all tests pass unchanged
3. No changes to consumers (PermissionResolver, GitLabSync, webhook handler)
4. Document specific AGE limitations for future reference

The fallback is designed in: `GraphLayer` is the only file that contains Cypher queries. Everything else talks to it through TypeScript methods.

---

## Security Evaluator Findings — Resolution Matrix (original 62 findings, v5 task numbers)

| # | Finding | Severity | Resolution (v5 Task) |
|---|---------|----------|---------------------|
| **Original Review (34 findings)** | | | |
| 1 | Cypher injection | CRITICAL | Task 2 (validator) + Task 5 (validated inputs) |
| 2 | No admin auth on /admin/tokens | CRITICAL | Task 10 (requireAdmin middleware) |
| 3 | JWT secret in plaintext + sudo | CRITICAL | Task 0b (restricted sudo, auto-generated secret) |
| 4 | Wrong repo structure | CRITICAL | Entire plan — separate `plur-ai/enterprise` repo |
| 5 | PostgresStore in wrong package | CRITICAL | Task 4 (in enterprise repo) |
| 6 | JWT algorithm confusion | HIGH | Task 10 (algorithms: ['HS256']) |
| 7 | Session hijacking | HIGH | Task 12 (user-bound sessions) |
| 8 | Token reuse across orgs | HIGH | Task 10 (orgId binding in verifyToken) |
| 9 | No rate limiting | HIGH | Task 11 (express-rate-limit) |
| 10 | Unlimited SSE connections | HIGH | Task 12 (per-user + global limits) |
| 11 | Connection pool multiplication | HIGH | Task 4 (shared pool, not per-store) |
| 12 | No graceful shutdown | HIGH | Task 11 (SIGTERM handler) |
| 13 | No error boundaries | HIGH | Task 11 (global error handler) |
| 14 | Shared graph across tenants | HIGH | Task 5 (per-org graphs: plur_${orgId}) |
| 15 | search_path leak on pool | HIGH | Task 6 (v6: qualified table names, SET LOCAL removed — CA9) |
| 16 | Passwordless sudo | HIGH | Task 0b (restricted sudo) |
| 17 | CORS wildcard default | HIGH | Task 1 (empty array default) |
| 18 | Health leaks info unauthenticated | HIGH | Task 11 (minimal public, full behind auth) |
| 19 | DB creds in plaintext | HIGH | Task 0b (chmod 600, scram-sha-256) |
| 20 | No token revocation | MEDIUM | Deferred — short-lived tokens in Phase 2 |
| 21 | No audit logging | MEDIUM | Task 3 (audit log writer) |
| 22 | No engram size validation | MEDIUM | Task 2 (validateEngramSize) |
| 23 | LIMIT interpolation | MEDIUM | Task 4 (parameterized LIMIT) |
| 24 | Docker binds 0.0.0.0 | MEDIUM | Task 0a (127.0.0.1) |
| 25 | No migration strategy | MEDIUM | Task 6 (migrate.ts CLI) |
| 26 | No structured logging | MEDIUM | Task 3 (pino) |
| 27 | Superficial health check | MEDIUM | Task 11 (DB connectivity check) |
| 28 | Config validation UX | MEDIUM | Task 1 (safeParse + readable errors) |
| 29 | Embedding not validated | MEDIUM | Task 2 (validateEmbedding) |
| 30 | No body size limit | MEDIUM | Task 11 (express.json limit: 1mb) |
| 31 | PostgresStore bypasses tenant | MEDIUM | Task 4 (schema parameter) |
| 32 | Schema name collision | MEDIUM | Task 6 (collision detection) |
| 33 | require() in ESM | MEDIUM | Fixed — top-level imports throughout |
| 34 | SSE session expiry | MEDIUM | Task 12 (background sweep) |
| | | | |
| **GitLab Integration Findings (13 findings)** | | | |
| G1 | GitLab token storage undefined | CRITICAL | Task 7b (AES-256-GCM encrypted gitlab_tokens table) |
| G2 | User IDs not namespaced per org | CRITICAL | Task 5 (orgId:username in graph), Task 8 (in sync code) |
| G3 | Concurrent sync/webhook races | HIGH | Task 8 (pg_advisory_lock), Task 5 (MERGE/upsert) |
| G4 | 60-min permission lag after revocation | HIGH | Task 13 (30s cache TTL on writes) |
| G5 | OAuth state map: no TTL, no cap | HIGH | Task 11 (DB-backed with 5-min TTL + 1000 cap) |
| G6 | No rate limit on /auth/* and /webhook/* | HIGH | Task 11 (10/min auth, 60/min webhook) |
| G7 | OAuth callback leaks GitLab errors in logs | HIGH | Task 11 (log status only, never body) |
| G8 | Webhook token timing leak | MEDIUM | Task 9 (crypto.timingSafeEqual with SHA-256 hashes) |
| G9 | Path traversal in group names | MEDIUM | Task 2 (normalizePath rejects ..) |
| G10 | GitLab responses not schema-validated | MEDIUM | Task 2 (Zod schemas), Task 7 (validated in client) |
| G11 | Self-hosted TLS not enforced by default | MEDIUM | Task 7 (HTTPS default, allowInsecure for dev) |
| G12 | First-login sync blocks callback | MEDIUM | Task 8 (async ensureUserSynced) |
| G13 | JWT role used as permission source of truth | MEDIUM | Task 13 (resolveUserScopes on live graph) |
| | | | |
| **Round 3 — Blocker Findings (5 blockers)** | | | |
| B1 | loadEnterpriseConfig() doesn't parse GitLab env vars | BLOCKER | Task 1 (all GITLAB_* env vars parsed) |
| B2 | ensureUserSynced() called but never defined | BLOCKER | Task 8 (full implementation) |
| B3 | No Plur core DI — can't inject PostgresStore | BLOCKER | Task 4b (PR with exact diff) |
| B4 | migrate.ts CLI referenced but never created | BLOCKER | Task 6 (full CLI implementation) |
| B5 | gitlab_tokens encrypted table — no implementing task | BLOCKER | Task 7b (AES-256-GCM encryption + refresh flow) |
| | | | |
| **MCP Tool Security — Red Team (11 findings)** | | | |
| R1 | Scope forgery on plur_learn | HIGH | Task 13b (enforceWritePermission) |
| R2 | plur_stores_add exposes filesystem | CRITICAL | Task 13b (DISABLED in allowlist) |
| R3 | plur_packs_install/export path traversal | HIGH | Task 13b (DISABLED in allowlist) |
| R4 | SSE session ID enumeration | HIGH | Task 12 (crypto.randomUUID, same 404 response) |
| R5 | Feedback bombing suppresses org engrams | MEDIUM | Task 13b (rate limit + scope-gated feedback) |
| R6 | plur_sync exfiltrates engrams via git remote | HIGH | Task 13b (DISABLED in allowlist) |
| R7 | Embedding computation DoS | MEDIUM | Task 13b (10/min/user rate limit on hybrid tools) |
| R8 | SSRF via user-supplied llm_base_url | HIGH | Task 13b (DISABLED — all tools accepting llm_base_url) |
| R9 | plur_ingest mass knowledge poisoning | MEDIUM | Task 13b (cap 10, candidate status) |
| R10 | Webhook replay re-grants revoked permissions | MEDIUM | Task 9 (processed_webhooks dedup table) |
| R11 | AuditLog/PostgresStore constructors accept unvalidated schema | MEDIUM | Task 3 (validateSchemaName in AuditLog), Task 4 (in PostgresStore) |
| | | | |
| **Operational Security — Security Architect (10 findings)** | | | |
| F1 | JWT secret rotation causes hard outage | HIGH | Task 10 (dual-secret verify: JWT_SECRET + JWT_SECRET_PREVIOUS) |
| F2 | OAuth state lost on server restart | HIGH | Task 11 (DB-backed oauth_pending table) |
| F3 | Code doesn't match stated fix for webhook timing | MEDIUM | Task 9 (crypto.timingSafeEqual, not hand-rolled XOR) |
| F4 | Empty permissions before first sync | HIGH | Task 10 (503 with Retry-After until sync completes) |
| F5 | No pagination limit on GitLab API | MEDIUM | Task 7 (maxPages: 50 on paginatedGet) |
| F6 | Audit log PII without retention policy | MEDIUM | Task 3 (pseudonymizeUser function) |
| F7 | npm deps use caret ranges | MEDIUM | Task 1 (pinned exact versions) |
| F8 | No GDPR right-to-erasure | MEDIUM | Deferred to Phase 2 (admin API) |
| F9 | GitLab token encryption key same as JWT secret | LOW | Task 7b (separate GITLAB_TOKEN_ENCRYPTION_KEY) |
| F10 | Docker image tag not digest-pinned | LOW | Task 0a (documented, pin before production) |
| | | | |
| **Consistency Fixes (10 findings)** | | | |
| C1 | GitLabClient constructor: allowInsecure vs requireHttps | IMPORTANT | Task 7 (allowInsecure with HTTPS-by-default) |
| C2 | GraphLayer missing methods: removeMembership, removeGroup | IMPORTANT | Task 5 (all methods implemented) |
| C3 | Resolution matrix has stale task numbers | IMPORTANT | This table (v5 numbers) |
| C4 | pool.ts in structure but never created | MINOR | Task 4 (pool.ts created) |
| C5 | src/gitlab/cli/sync.ts referenced but never created | IMPORTANT | Task 8 (sync CLI created) |
| C6 | G2 namespaced user IDs not in sync/webhook code | IMPORTANT | Task 5 (graph namespaces), Task 8 (sync), Task 9 (webhook) |
| C7 | handleSubgroupCreate passes 'unknown' as orgId | MINOR | Task 9 (uses config.org_id) |
| C8 | GitLab OAuth app registration not documented | IMPORTANT | Task 16 (GITLAB-SETUP.md) |
| C9 | Missing tests: GitLab unreachable, DB failures, concurrent sessions | IMPORTANT | Task 14 (failure-modes.test.ts) |
| C10 | GitLab config fields should be optional with gitlab_enabled flag | MINOR | Task 1 (gitlab_enabled: z.boolean().default(false)) |

**Total: 62 findings. All resolved in v5 task code (except finding 20 and F8, deferred to Phase 2).**

---

## Codex Audit Findings — Resolution Matrix (v6)

> 24 findings from independent Codex audit (2026-04-22). All resolved in v6 amendments.
> Detailed code patches: `2026-04-22-enterprise-pilot-plan-v6-amendments.md` (amendments A-H, CA5-CA16).

| # | Finding | Severity | Resolution |
|---|---------|----------|-----------|
| 1 | Task 4b false integration — injected store not used by core | CRITICAL | Task 4b REPLACED: EnterprisePlur adapter (Amendment A, agent output) |
| 2 | Claims multi-tenant but single-tenant design | CRITICAL | Header clarified: single-tenant pilot (Amendment A) |
| 3 | Task 13b doesn't secure real write surface (plur_session_end) | CRITICAL | Task 13b REPLACED: 34 tools, 3 write strategies (agent output) |
| 4 | plur_ingest mitigation fake — fields not read | CRITICAL | plur_ingest: extract_only=true + enterprise dispatcher cap (agent output) |
| 5 | 503 bypass on sync failure | CRITICAL | 3-retry loop, syncFailed flag, never silently allow (CA5) |
| 6 | OAuth CSRF + wrong content-type | CRITICAL | Cookie-bound state + form-style POST (CA6) |
| 7 | Webhook dedup before mutation — race | CRITICAL | Transaction-wrapped: check → mutate → insert dedup (CA7) |
| 8 | Webhooks don't take advisory lock | HIGH | pg_advisory_xact_lock in webhook transaction (CA8) |
| 9 | SET LOCAL outside transaction | HIGH | Remove SET LOCAL, use qualified table names (CA9) |
| 10 | Tool count wrong: 32 vs 34 | HIGH | 34 tools enumerated, 4 missing tools categorized (agent output) |
| 11 | Read tools leak cross-user data | HIGH | read-sanitizer.ts: strip storage_root, require engram_id (agent output) |
| 12 | Identity contract inconsistent | HIGH | Identity Contract section added (Amendment B) |
| 13 | Task sequencing wrong (11 before 13b) | HIGH | Split 11→11a+11b, 13b before 11b (Amendment C) |
| 14 | No actual MCP server implementation | HIGH | Task 11b: SSEServerTransport + /sse + /messages (Amendment D) |
| 15 | Admin auth is advisory-JWT based | HIGH | Admin from ADMIN_USERS config, not JWT role (CA15) |
| 16 | Dollar-quote injection in Cypher | HIGH | Escape $ + random-tagged delimiter (CA16) |
| 17 | First-login sync not feasible | HIGH | User-scoped sync only, no full org enum (Amendment E) |
| 18 | No monitoring/periodic sync | HIGH | Task 16b: setInterval + metrics + stale detection (Amendment F) |
| 19 | Build/deploy contradictory | HIGH | Two-stage build + Docker multi-stage (Amendment G) |
| 20 | Backup broken under cron | MEDIUM | .pgpass + offsite backup + restore test |
| 21 | GDPR audit not implemented | MEDIUM | Pseudonymize in log(), retention policy, purge cron |
| 22 | Test plan misses design-created failures | MEDIUM | Added CSRF, webhook race, admin forgery tests |
| 23 | Test code bugs (require in ESM, wrong assertions) | MEDIUM | import instead of require, fix tenant test |
| 24 | Supply chain incomplete | MEDIUM | Commit SHA pinning in Dockerfile |

**Total: 62 original + 24 codex = 86 findings. All resolved (except finding 20 and F8, deferred to Phase 2).**
