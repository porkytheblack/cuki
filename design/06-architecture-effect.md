# 06 — Service architecture (Effect)

Everything is composed from Effect services (`Effect.Service` / `Context.Tag`) wired
together as `Layer`s. One root layer is provided to the runtime. No global singletons, no
hidden state, no thrown exceptions across boundaries.

## Layering (bottom → top)

```
Config (typed, redacted)
  └─ SqlClient (@effect/sql) + Drizzle (@effect/sql-drizzle)
       └─ Repositories  (KeyRepo, ServiceRepo, GrantRepo, AuditRepo, ...)
            └─ Domain services
                 ├─ CryptoService     (envelope enc/dec) ← KekProvider
                 ├─ TokenService      (challenge, access tokens)
                 ├─ AuthService       (sessions, RBAC guards)
                 ├─ KeyService        (create/rotate/reveal/rollback)
                 ├─ ServiceRegistry   (services + grants)
                 └─ AuditService      (append + query)
                      └─ HTTP layer (HttpApi handlers + middleware)
                           └─ StaticAssets (embedded SPA)
                                └─ HttpServer (platform-node|bun)
```

Each arrow is `Layer.provide`. The root:

```ts
const AppLayer = HttpLive.pipe(
  Layer.provide(DomainLive),        // Crypto, Token, Auth, Key, ServiceRegistry, Audit
  Layer.provide(RepoLive),
  Layer.provide(DrizzleLive),       // @effect/sql-drizzle over SqlClient
  Layer.provide(SqlLive),           // Postgres (@effect/sql-pg)
  Layer.provide(KekLive),           // env|file|passphrase|kms provider, chosen by Config
  Layer.provide(ConfigLive),
)

NodeRuntime.runMain(Layer.launch(AppLayer))  // or BunRuntime
```

## Services (contracts)

Sketch the tags; keep interfaces small and effectful.

```ts
class CryptoService extends Effect.Service<CryptoService>()("CryptoService", {
  effect: Effect.gen(function* () {
    const kek = yield* KekProvider
    return {
      encrypt: (plaintext: Uint8Array, aad: Uint8Array) =>
        Effect.gen(function* () { /* DEK, AEAD, wrap → EncryptedValue */ }),
      decrypt: (v: EncryptedValue, aad: Uint8Array) =>
        Effect.gen(function* () { /* unwrap → AEAD open → Uint8Array */ }),
      sealToService: (recipientX25519Pub: Uint8Array, info: Uint8Array, aad: Uint8Array, payload: Uint8Array) =>
        Effect.gen(function* () { /* HPKE SealBase → { enc, ciphertext } */ }),
    }
  }),
}) {}

class TokenService extends Effect.Service<TokenService>()("TokenService", { /* ... */ }) {
  // issueChallenge(serviceId) → Challenge
  // verifyAndIssue(challengeId, signature) → AccessToken   (verifies Ed25519, single-use)
  // resolve(bearer) → { service, scopeKeyIds }             (hash lookup, expiry/revoke check)
}

class KeyService extends Effect.Service<KeyService>()("KeyService", { /* ... */ }) {
  // create(env, {name,type,value}) → KeyMeta               (encrypts if sensitive)
  // setValue(keyId, value) → KeyMeta                       (new version, bump currentVersion)
  // reveal(keyId) → string                                 (admin gate handled at handler)
  // rollback(keyId, version) → KeyMeta
  // readForService(scopeKeyIds, service) → SealedEnvelope   (decrypt-at-rest, then HPKE-seal to service)
}
```

`AuthService` exposes `authorize(orgId, minRole): Effect<void, Forbidden, CurrentUser>`
used by every management handler, plus session create/validate. `ServiceRegistry` owns
service CRUD, keypair generation (returns private key once), and grant management with the
env-match invariant. `AuditService.record(entry)` is called by the `Audit` middleware and
by sensitive actions directly.

## Repositories over Drizzle

Repositories are the only place that touches SQL. Wrap Drizzle via `@effect/sql-drizzle`
so queries run inside the Effect `SqlClient` (transactions, tracing, error channel) rather
than raw promises.

```ts
class KeyRepo extends Effect.Service<KeyRepo>()("KeyRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Drizzle    // @effect/sql-drizzle client
    return {
      insertWithVersion: (k: NewKey, v: NewKeyVersion) =>
        db.transaction((tx) => Effect.gen(function* () {
          yield* tx.insert(keys).values(k)
          yield* tx.insert(keyVersions).values(v)
        })),
      currentVersion: (keyId: string) => /* select join on currentVersion */,
      // ...
    }
  }),
}) {}
```

### Datastore

Postgres via `@effect/sql-pg` under `@effect/sql-drizzle`. Keep SQL confined to repos so
the rest of the codebase is storage-agnostic; use transactions (`db.transaction`) for
multi-row invariants (key + version, grant sets). Connection config (URL, pool size) comes
from `Config`, credentials redacted. Because all auth/session state lives in Postgres,
cuki instances are stateless and scale horizontally behind a load balancer with no
stickiness.

## Cross-cutting

- **Config:** one `Config` module. Secrets (`CUKI_MASTER_KEY`, DB URL creds) via
  `Config.redacted`. Precedence flags > env > file > defaults ([`08`](./08-deployment.md)).
- **Logging/tracing:** Effect's structured logger + spans. A log filter drops any payload
  typed as plaintext/DEK/KEK. Correlate requests with a request-id span.
- **Background fibers:** a `Schedule`-driven sweeper deletes expired `challenges` and
  `access_tokens`; a daily job can roll up audit analytics. Launch as a forked fiber in
  a layer's scope so it shuts down cleanly.
- **Errors:** all tagged (`Data.TaggedError`), mapped to HTTP in the API layer only.
  Domain code never formats HTTP.

## Project layout

```
cuki/
├── src/
│   ├── main.ts                 # CLI entry: serve | migrate | init | kek rotate | client cmds
│   ├── config.ts               # typed Config, precedence
│   ├── db/
│   │   ├── schema.ts            # Drizzle pgTable definitions (source of truth)
│   │   ├── migrations/          # drizzle-kit output
│   │   └── sql.ts               # SqlLive (@effect/sql-pg) + Drizzle layer
│   ├── crypto/
│   │   ├── aead.ts              # xchacha20poly1305 / aes256gcm
│   │   ├── envelope.ts          # DEK wrap/unwrap, encrypt/decrypt (at rest)
│   │   ├── hpke.ts              # seal-to-client + Ed25519→X25519 derivation
│   │   ├── kek/                 # KekProvider: env, file, passphrase, kms.*
│   │   └── crypto.service.ts
│   ├── domain/
│   │   ├── auth.service.ts      # sessions, RBAC, service challenge/token
│   │   ├── token.service.ts
│   │   ├── key.service.ts
│   │   ├── service-registry.ts
│   │   └── audit.service.ts
│   ├── repo/                    # *.repo.ts over Drizzle
│   ├── http/
│   │   ├── api.ts               # HttpApi + groups + Schemas
│   │   ├── handlers/            # per-group handlers
│   │   ├── middleware/          # SessionAuth, ServiceTokenAuth, Audit, RateLimit
│   │   └── static.ts            # embedded SPA serving
│   ├── client/                  # SDK + CLI client (09)
│   └── errors.ts                # tagged errors + HTTP mapping
├── web/                         # dashboard SPA (Vite) → built into src/http/assets
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

## Testing strategy

- **Crypto (P1):** pure, deterministic where possible; known-answer vectors ([`03`](./03-cryptography.md)).
- **Services:** provide test `Layer`s backed by a disposable Postgres (Testcontainers or a
  template DB) so repos run real SQL; swap `KekProvider` for a deterministic test KEK.
- **HTTP:** exercise `HttpApi` handlers through the derived client against a test layer.
- **Auth flow:** end-to-end challenge→token→secrets test proving replay is rejected
  (reused nonce) and scope is enforced (ungranted key → 404/denied).
