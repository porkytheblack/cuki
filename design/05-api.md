# 05 — API

Built with `@effect/platform` `HttpApi`. Endpoints, request/response, and errors are
declared as `Schema`; handlers, the OpenAPI document, and a typed client are derived from
those declarations. Versioned under `/v1`.

## Structure

Group the API into `HttpApiGroup`s that map to the two planes plus auth:

```
HttpApi("cuki")
├── HttpApiGroup("auth")         // login/logout (users) + service challenge/token
├── HttpApiGroup("management")   // orgs, projects, environments, keys, services, grants, audit
└── HttpApiGroup("retrieval")    // /secrets  (service bearer only)
```

Middleware (as `HttpApiMiddleware` / layers):

- `SessionAuth` — resolves `CurrentUser` from cookie/bearer; applied to `management`.
- `ServiceTokenAuth` — resolves the service + scope from the access token; applied to
  `retrieval`.
- `Audit` — wraps handlers, emits an `audit_logs` row from the resolved actor + outcome.
- `RateLimit` — on `auth` service endpoints.

## Endpoints

### Auth — users

```
POST   /v1/auth/login            {email, password}            → set-cookie; {user}
POST   /v1/auth/logout                                        → 204
GET    /v1/auth/me                                            → {user, memberships}
```

### Auth — services (retrieval plane)

```
POST   /v1/auth/challenge        {service_id}                 → {challenge_id, nonce, algorithm, expires_at}
POST   /v1/auth/token            {challenge_id, signature}    → {access_token, token_type, expires_in, expires_at}
```

### Management — hierarchy

```
GET    /v1/orgs                                               → [org]
POST   /v1/orgs                  {name}                       → org
GET    /v1/orgs/:orgId/members                                → [member]
POST   /v1/orgs/:orgId/members   {email, role}               → member          (admin+)
PATCH  /v1/orgs/:orgId/members/:id {role}                    → member          (admin+)
DELETE /v1/orgs/:orgId/members/:id                           → 204             (admin+)

GET    /v1/orgs/:orgId/projects                              → [project]
POST   /v1/orgs/:orgId/projects  {name}                      → project         (member+)
DELETE /v1/projects/:id                                      → 204             (owner)

GET    /v1/projects/:id/environments                         → [environment]
POST   /v1/projects/:id/environments {name, protected?}      → environment     (member+)
DELETE /v1/environments/:id                                  → 204             (admin+)
```

### Management — keys

```
GET    /v1/environments/:id/keys                             → [keyMeta]        (viewer+; sensitive values masked)
POST   /v1/environments/:id/keys  {name, type, value, description?} → keyMeta   (member+)
GET    /v1/keys/:id                                          → keyMeta + versions
PUT    /v1/keys/:id               {value}                    → keyMeta          (member+, new version)
DELETE /v1/keys/:id                                          → 204             (member+)
POST   /v1/keys/:id/reveal                                   → {value}          (admin+, audited: secret.reveal)
POST   /v1/keys/:id/rollback      {version}                  → keyMeta          (member+)
```

`keyMeta` never contains a sensitive plaintext. `value` is only present for `public` keys
and only via `reveal` for `sensitive` keys.

### Management — services & grants

```
GET    /v1/environments/:id/services                         → [service]
POST   /v1/environments/:id/services {name, ipAllowlist?}    → {service, private_key}   (member+, once)
POST   /v1/services/:id/rotate-key                          → {private_key}            (admin+, once)
POST   /v1/services/:id/revoke                              → service                   (admin+)
DELETE /v1/services/:id                                     → 204                       (admin+)

GET    /v1/services/:id/grants                               → [grant]
POST   /v1/services/:id/grants    {keyIds:[...]}            → [grant]           (member+; env-match enforced)
DELETE /v1/grants/:id                                       → 204              (member+)
```

`private_key` appears only in the creation/rotate responses — surface it in the client as
copy-once.

### Management — audit & analytics

```
GET /v1/orgs/:orgId/audit        ?actorType&action&environmentId&from&to&cursor   → paginated [auditLog]
GET /v1/orgs/:orgId/analytics/access   ?from&to&groupBy=service|key|day           → aggregates
GET /v1/services/:id/activity                                                     → recent reads + last_auth_at
GET /v1/keys/:id/access                                                           → who/what read this key
```

Analytics are aggregate queries over `audit_logs` — no separate store needed at this
scale. If volume grows, roll up into a daily summary table later.

### Retrieval

Responses are HPKE-sealed to the requesting service's key; the client decrypts locally
([`03`](./03-cryptography.md), [`09`](./09-sdk-cli.md)).

```
GET /v1/secrets            (Bearer service access token)     → SealedEnvelope
GET /v1/secrets/:name      (Bearer service access token)     → SealedEnvelope
```

```
SealedEnvelope = { enc, ciphertext, suite }
  decrypted → { keys: [ { name, type, value } ] }   // /:name → single { name, type, value }
```

## Error model

Domain errors are `Data.TaggedError` classes, mapped to HTTP by the group's error schema.
No thrown exceptions cross a handler boundary; failures live in the Effect error channel.

```ts
class Unauthorized      extends Data.TaggedError("Unauthorized")<{}> {}
class Forbidden         extends Data.TaggedError("Forbidden")<{ need: Role }> {}
class NotFound          extends Data.TaggedError("NotFound")<{ resource: string }> {}
class Conflict          extends Data.TaggedError("Conflict")<{ reason: string }> {}   // e.g. dup key name
class ValidationError   extends Data.TaggedError("ValidationError")<{ issues: Issue[] }> {}
class ChallengeInvalid  extends Data.TaggedError("ChallengeInvalid")<{ code: ChallengeFailCode }> {}
class CryptoError       extends Data.TaggedError("CryptoError")<{}> {}                // never leak detail
class RateLimited       extends Data.TaggedError("RateLimited")<{ retryAfter: number }> {}
```

HTTP mapping: `Unauthorized→401`, `Forbidden→403`, `NotFound→404`, `Conflict→409`,
`ValidationError→422`, `ChallengeInvalid→401` (generic body), `RateLimited→429`,
`CryptoError→500` (opaque). Retrieval-plane auth failures always return the same generic
`401` body regardless of internal `code`; the specific `code` goes only to the audit log,
never to the client.

Wire error shape:

```json
{ "error": { "type": "Forbidden", "message": "insufficient role", "need": "admin" } }
```

## OpenAPI & client

Derive OpenAPI from the `HttpApi` (`HttpApiSwagger`/spec export). The typed client
(`HttpApiClient.make`) is reused by the dashboard and can back a thin generated SDK, so
request/response types never drift from the server.
