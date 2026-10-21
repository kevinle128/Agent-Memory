# Rate-Limits Endpoint Auth Protection

## 1. Current Admin Auth Implementation

**Files:**
- `/MemoryProxy/src/routes/admin-auth.ts:7-19` — `checkAdminAuth()` function
  - Returns `"ok"` when `expected` param is empty string (line 8: `if (!expected) return "ok"`)
  - Returns `"missing"` if Bearer token absent from `Authorization` header
  - Returns `"invalid"` if token present but timing-safe comparison fails
  - Uses timing-safe comparison: `timingSafeEqual(a, b)` to prevent timing attacks
  
- `/MemoryProxy/src/routes/admin-auth.ts:22-27` — Error response helper
  - `adminAuthError()` returns 401 JSON with message distinguishing "missing" vs "invalid"

**Current behavior when `admin.apiKey` is empty:**
- `checkAdminAuth(c, "")` returns `"ok"` → all endpoints accessible without token
- This is a security gap (CWE-287: default-allow when config unconfigured)

---

## 2. Rate-Limits Route Code & Registration

**Rate-limits handlers:**
- `/MemoryProxy/src/routes/rate-limits.ts:1-151`
  - `createRateLimitHandlers(config)` returns object with `get`, `put`, `delete` handlers
  - **NO auth checks** currently; handlers directly call internal logic (handleGet/Put/Delete)
  - Handlers accessible at:
    - `GET /v3/admin/rate-limits` — read global + override limits (line 24-50)
    - `PUT /v3/admin/rate-limits` — set limits or override (line 56-83)
    - `DELETE /v3/admin/rate-limits` — clear limits or override (line 85-107)

**Route registration:**
- `/MemoryProxy/src/server.ts:158-161`
  ```typescript
  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);
  ```
  - Registered BEFORE catch-all routes
  - No middleware wrapper applied

---

## 3. Upstream PR Auth Hunks

All three PRs converge on the same fix pattern; cleanest is refs/upr/808 (commit d937cb54):

**rate-limits.ts diff (d937cb54):**
```typescript
export function createRateLimitHandlers(config: ProxyConfig) {
+  const enforceAuth = (c: Context): Response | null => {
+    const result = checkAdminAuth(c, config.admin.apiKey);
+    if (result !== "ok") return adminAuthError(c, result);
+    return null;
+  };
+
   return {
-    get: (c: Context) => handleGet(c, config),
-    put: (c: Context) => handlePut(c, config),
-    delete: (c: Context) => handleDelete(c, config),
+    get: (c: Context) => enforceAuth(c) || handleGet(c, config),
+    put: (c: Context) => enforceAuth(c) || handlePut(c, config),
+    delete: (c: Context) => enforceAuth(c) || handleDelete(c, config),
   };
 }
```
- Short-circuit: auth error returned early, handler never called
- Mirrors the pattern used in `instance-destroy.ts:69-72` (already auth'd)

**admin-auth.ts diff (d937cb54):**
```typescript
export function checkAdminAuth(c: Context, expected: string): AdminAuthResult {
-  if (!expected) return "ok";
+  if (!expected) return "missing";
   ...
}
```
- Default-deny: when admin.apiKey unconfigured, return "missing" → 401
- Prevents public access to admin endpoints when no key is set

---

## 4. Callers of /v3/admin/* Endpoints

**Intra-repo search results:**
- No callers of `/v3/admin/rate-limits` found in the codebase
- No callers of `/v3/admin/model-aliases` found

**Other admin routes already protected:**
- `POST /v3/instance/proxy-destroy` (line 156): already uses `checkAdminAuth` (instance-destroy.ts:69)
- `GET /v3/admin/model-aliases` (line 163): already uses `checkAdminAuth` (model-aliases.ts:17)

**Risk assessment:**
- No in-repo callers → adding auth will NOT break existing internal clients
- These are ops-only endpoints (not called by LLMs or agents)
- External callers (if any) will need to provide the Bearer token

---

## 5. Configuration & Deployment

**How admin.apiKey is loaded:**
- `/MemoryProxy/src/config.ts:621-627`
  ```typescript
  admin: {
    apiKey:
      (process.env.TDAI_PROXY_ADMIN_API_KEY ?? "").trim() ||
      yaml.admin?.apiKey ||
      DEFAULT_CONFIG.admin.apiKey,  // defaults to ""
  }
  ```
  - Priority: env var > YAML > empty string
  - Aligns with how `TDAI_PROXY_UPSTREAM_API_KEY_FILE` and `TDAI_TASK_DRAFT_API_KEY` are handled

**Docker Compose setup:**
- `/compose.yaml:80-169` — proxy service definition
  - Configures proxy via YAML `/data/config.yaml` (embedded in compose.yaml lines 108-169)
  - **Does NOT set** `TDAI_PROXY_ADMIN_API_KEY` env var yet
  - Other secrets are injected via env: `MEMORY_CORE_GATEWAY_API_KEY`, `KNOWLEDGE_SERVICE_KEY`

**Where to add the env var:**
- Inject in compose.yaml proxy service (around line 80-98)
- Add `TDAI_PROXY_ADMIN_API_KEY: ${TDAI_PROXY_ADMIN_API_KEY}` to environment
- Document in `.env.example` (alongside `MEMORY_CORE_GATEWAY_API_KEY`, `KNOWLEDGE_SERVICE_KEY`)

**Example (from config.example.yaml:507-510):**
```yaml
admin:
  apiKey: ""  # Empty = ops endpoints public (default). 
              # Production: set via env TDAI_PROXY_ADMIN_API_KEY (avoid git).
```

**Type definition:**
- `/MemoryProxy/src/types.ts:654-656` — `ProxyConfig.admin: { apiKey: string }`
- `/MemoryProxy/src/types.ts:1130-1132` — Raw YAML type: `admin?: { apiKey?: string }`

---

## 6. Tests for Admin Auth

**Currently on main branch:** NO tests for admin auth or rate-limits endpoints

**Upstream test additions (from d937cb54):**
- `MemoryProxy/src/__tests__/admin-auth.test.ts` — 34 lines added
  - Tests `checkAdminAuth` default-deny behavior when key unconfigured
  - Tests matching, missing, and invalid token scenarios
  
- `MemoryProxy/src/__tests__/rate-limits.test.ts` — 42 lines added
  - Tests rate-limit endpoints return 401 without a key
  - Tests endpoints pass auth through with valid key
  - Tests rate-limit CRUD operations post-auth

**How to run tests:**
```bash
cd MemoryProxy
npm test  # or npm run test:unit
```

---

## Risks & Notes

1. **Fail-closed is critical:** The current `checkAdminAuth(..., "")` → "ok" is a bypass. Reversing to "missing" when unconfigured is the right security fix.

2. **No breaking changes to callers:** No in-repo clients call these endpoints; ops-only routes.

3. **Backward compatibility:** When `TDAI_PROXY_ADMIN_API_KEY` is not set, endpoints will return 401. Existing ops workflows must be updated to pass the Bearer token or set the env var.

4. **Config loading cascade:** The env → yaml → default priority is already documented and tested in other secret fields (UPSTREAM_API_KEY_FILE, TASK_DRAFT_API_KEY).

5. **Timing-safe comparison:** Already in place in admin-auth.ts; no new crypto concerns.

---

## Unresolved Questions

None. All three upstream PRs align on the fix pattern; codebase structure is clear.
