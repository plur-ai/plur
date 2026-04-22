# PLUR Enterprise Plan — v5 to v6 Amendments

> Codex audit (2026-04-22) found 24 issues: 7 CRITICAL, 12 HIGH, 5 MEDIUM.
> All 24 are addressed in v6. This document maps each finding to its resolution.

---

## Structural Changes

### 1. Single-tenant pilot (Finding 2)
**v5 claimed**: "Multi-org schema isolation from day one"
**v6 clarifies**: Single-tenant pilot serving one organization. Per-org schema is forward-looking architecture, but the server binds to one `config.org_id`. Multi-tenant (multiple orgs) is Phase 2.

### 2. Enterprise Adapter replaces Task 4b DI PR (Findings 1, 4)
**v5 proposed**: Small PR to `@plur-ai/core` adding `options.store` to Plur constructor
**v6 replaces with**: `EnterprisePlur` adapter class in the enterprise repo that:
- Implements the same public API as Plur (learn, recall, feedback, etc.)
- Uses `PostgresStore` for all engram persistence
- Imports search functions from `@plur-ai/core` (already exported: `searchEngrams`, `hybridSearch`, `embeddingSearch`)
- Uses new Postgres tables for episodes, history, audit
- Scopes all operations to authenticated user's permissions
- No upstream PR needed (or minimal export-only PR)

This avoids the impossible task of making the file-path-based `Plur` class work with Postgres through a store injection that no method reads.

### 3. Corrected tool surface — 34 tools, not 32 (Findings 3, 10, 11)
**v5 listed**: 32 tools
**v6 lists**: 34 tools. Added:
- `plur_similarity_search` → ALLOWED (read, embedding search with scores)
- `plur_batch_decay` → ADMIN-ONLY (write, batch activation decay)
- `plur_episode_to_engram` → DISABLED (LLM-dependent)
- `plur_report_failure` → DISABLED (accepts llm_base_url)

`plur_meta_engrams` reclassified: ALLOWED (read-only, does NOT take llm_base_url)

### 4. Identity contract defined (Finding 12)
New section added. Canonical format:
- **Username**: bare string (`alice`), unique within org
- **Graph node ID**: `orgId:username` (`acme:alice`)
- **Scope strings**: `user:acme:alice`, `group:acme/backend`, `project:acme/backend/api`
- **JWT payload**: `{ sub: username, orgId, email, role }`
- **req.user**: `{ username, orgId, email, role }`
- Permission resolver: takes `username`, graph resolves to `orgId:username` nodes

### 5. Task resequencing (Finding 13)
**v5**: Task 11 imports tool-filter from Task 13b, but 13b comes after 11
**v6**: Task 13b moved before Task 11. New order:
```
... → 10 (auth) → 12 (sessions) → 13 (permissions) → 13b (tool allowlist) → 11 (HTTP server + MCP) → 14 → 15 → 16
```

### 6. Actual MCP server implementation (Finding 14)
**v5**: Task 11 had Express routes but no MCP server
**v6**: Task 11 includes:
- `Server` from `@modelcontextprotocol/sdk`
- `SSEServerTransport` for SSE connections
- `GET /sse` route (auth required, creates session + transport)
- `POST /messages/:sessionId` route (auth, ownership check, forwards to transport)
- Tool filter and permission wrapper applied to MCP request handler

---

## Security Fixes

### Finding 5 (CRITICAL): 503 bypass on failure
**v5**: Catch block sets `firstSyncComplete = true`
**v6**: On sync failure, keep `firstSyncComplete = false`. Add `syncFailed` flag. After 3 retries, return 503 with "GitLab sync failed — contact admin". Never silently allow requests with empty permissions.

### Finding 6 (CRITICAL): OAuth CSRF / session swapping
**v5**: Server-side state not bound to browser
**v6**:
1. On `/auth/login`: generate state + set httpOnly/secure/sameSite=strict cookie with random nonce
2. Store `hash(state + nonce)` in `oauth_pending` table
3. On callback: verify state param + cookie nonce match the stored hash
4. Use `application/x-www-form-urlencoded` for GitLab token exchange (not JSON)

### Finding 7 (CRITICAL): Webhook replay protection order
**v5**: `isDuplicate()` inserts hash before graph mutation
**v6**: Wrap in transaction:
1. BEGIN
2. Check if payload hash exists in `processed_webhooks`
3. If exists → COMMIT, return (already processed)
4. Execute graph mutation
5. Insert payload hash into `processed_webhooks`
6. COMMIT
If crash at step 4/5 → both roll back → GitLab retries → correct

### Finding 8 (HIGH): Webhooks don't take advisory lock
**v5**: Only `fullSync()` takes `pg_advisory_lock`
**v6**: Webhook handler also acquires `pg_advisory_xact_lock` (transaction-scoped, same key) before graph mutations. Lock scope is transaction-level so it auto-releases.

### Finding 9 (HIGH): SET LOCAL outside transaction
**v5**: `TenantManager.getOrgClient()` uses `SET LOCAL` on pooled client
**v6**: Remove SET LOCAL entirely. Use fully-qualified table names (`${schema}.tablename`) in all queries. PostgresStore and AuditLog already do this. Consistent pattern, no schema-path tricks.

### Finding 15 (HIGH): Admin auth is advisory-JWT based
**v5**: `requireAdmin()` trusts JWT `role` field
**v6**: Admin users defined in config: `ADMIN_USERS=alice,bob`. `requireAdmin()` middleware checks username against this list, not the JWT role. JWT role is informational only.

### Finding 16 (HIGH): Dollar-quote injection in Cypher
**v5**: `sanitizeCypherValue()` doesn't escape `$$`
**v6**: Two changes:
1. Add `$` to sanitization: `.replace(/\$/g, '\\$')`
2. Prefer AGE parameterized queries (`$1` style) over string interpolation where possible. `createOrg()` uses parameterized name.

---

## Operational Fixes

### Finding 17 (HIGH): First-login sync not feasible
**v5**: `ensureUserSynced()` runs full org sync with user's token
**v6**: On first login:
1. `GET /api/v4/groups?min_access_level=10` (user's groups only)
2. `GET /api/v4/projects?membership=true` (user's projects only)
3. Create/update user node + their membership edges
4. Do NOT enumerate other users' memberships
5. Full org sync = separate admin-token cron, not login-triggered

### Finding 18 (HIGH): No monitoring/periodic sync
**v5**: `GITLAB_SYNC_INTERVAL_MINUTES` parsed but never used
**v6**: New Task 16b — Operational Monitoring:
1. `setInterval` for periodic GitLab full sync (admin service token)
2. `/admin/metrics` endpoint (request count, latency p99, error rate, sync status)
3. Stale permission detection: flag users not synced in > 2x interval
4. Wire `GITLAB_SYNC_INTERVAL_MINUTES` to the interval timer
5. Add `GITLAB_SERVICE_TOKEN` config for automated sync

### Finding 19 (HIGH): Build/deploy contradictory
**v5**: `npm ci --production && npm run build` (tsup is devDep)
**v6**: Two-stage build in deploy.sh:
```bash
npm ci              # full install including devDeps
npm run build       # compile with tsup
npm prune --production  # remove devDeps after build
```

### Finding 20 (MEDIUM): Backup broken under cron
**v5**: `pg_dump` with SCRAM auth, no `.pgpass`
**v6**: Create `/home/deploy/.pgpass` with `chmod 600`:
```
localhost:5432:plur_enterprise:plur_enterprise:PASSWORD
```
Add offsite backup (rsync to second volume or S3-compatible). Add restore test script.

### Finding 21 (MEDIUM): GDPR audit not implemented
**v5**: `pseudonymizeUser()` exists but `AuditLog.log()` stores raw data
**v6**: AuditLog stores pseudonymized `user_id` by default in production. Raw IP hashed. Add `AUDIT_RETENTION_DAYS=90` config. Cron job to purge old audit entries.

### Finding 24 (MEDIUM): Supply chain incomplete
**v5**: Mutable GitHub tags in Dockerfile
**v6**: Pin to specific commit SHAs:
```dockerfile
RUN git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector && \
    cd /tmp/pgvector && git checkout abc1234 && ...
```
Add SHA256 checksum verification. Document the pinning process.

---

## Test Fixes

### Finding 22 (MEDIUM): Missing tests for design-created failures
**v6 adds tests for**:
- OAuth state/cookie binding (CSRF prevention)
- Webhook dedup-before-mutation race (transaction correctness)
- Admin role forgery (config-list check, not JWT role)
- Periodic sync timer firing
- E2E `/admin/health` route (now properly mounted)

### Finding 23 (MEDIUM): Test code bugs
- `auth-bypass.test.ts`: Replace `require('jsonwebtoken')` with `import jwt from 'jsonwebtoken'` (ESM)
- Tenant isolation test: Verify schema isolation via fully-qualified table names, not search_path
- E2E test: Fix route expectations to match actual server routes

---

## Updated Resolution Matrix

All 62 original findings + 24 codex findings resolved. See v6 plan for complete matrix.

## Updated Task Order (v6)

```
Task 0:   Infrastructure (Docker, DO setup) — AMENDED: digest pinning, .pgpass, two-stage build
Task 1:   Repo scaffold — AMENDED: ADMIN_USERS config, GITLAB_SERVICE_TOKEN
Task 2:   Input validation — AMENDED: $ escaping in sanitizeCypherValue
Task 3:   Logging + audit — AMENDED: pseudonymization in log(), retention policy
Task 4:   PostgresStore — unchanged
Task 4b:  EnterprisePlur adapter — REPLACED: adapter pattern, not core DI
Task 5:   AGE graph — AMENDED: parameterized queries for createOrg
Task 6:   TenantManager — AMENDED: remove SET LOCAL, use qualified names
Task 7:   GitLab client — unchanged
Task 7b:  GitLab OAuth — AMENDED: form-style POST, PKCE
Task 8:   GitLab sync — AMENDED: user-scoped ensureUserSynced, advisory lock
Task 9:   Webhooks — AMENDED: transaction-wrapped dedup, advisory lock
Task 10:  Auth — AMENDED: 503 retry logic, admin from config, cookie+state binding
Task 12:  Sessions — AMENDED: add tests
Task 13:  Permissions — unchanged
Task 13b: Tool allowlist — REPLACED: 34 tools, per-type enforcement, read wrappers
Task 11:  HTTP server + MCP — AMENDED: actual MCP server, SSE routes, tool dispatch (moved after 13b)
Task 14:  Security tests — AMENDED: added CSRF, race, admin forgery tests
Task 15:  E2E tests — AMENDED: fix route expectations
Task 16:  Deploy — AMENDED: two-stage build, .pgpass
Task 16b: Monitoring — NEW: periodic sync, metrics, stale detection
```
