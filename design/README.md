# cuki — architecture

A secrets & config management service. Single self-contained binary: HTTP API,
embedded datastore, embedded dashboard, and a client CLI in one executable.

These docs are the implementation spec. Read them in order; each is self-contained
but assumes the terminology below.

## Documents

| # | Doc | Scope |
|---|-----|-------|
| 00 | [`README.md`](./README.md) | Principles, stack, glossary, build phases |
| 01 | [`01-overview.md`](./01-overview.md) | Components, boundaries, request flows |
| 02 | [`02-data-model.md`](./02-data-model.md) | Entities, Drizzle schema, ER model |
| 03 | [`03-cryptography.md`](./03-cryptography.md) | Encryption at rest, envelope scheme, rotation |
| 04 | [`04-auth.md`](./04-auth.md) | User auth, service challenge–response, RBAC, tokens |
| 05 | [`05-api.md`](./05-api.md) | HTTP surface, Effect `HttpApi`, error model |
| 06 | [`06-architecture-effect.md`](./06-architecture-effect.md) | Effect layers, services, repos, project layout |
| 07 | [`07-dashboard.md`](./07-dashboard.md) | Frontend architecture, screens, design system |
| 08 | [`08-deployment.md`](./08-deployment.md) | Single-binary build, config, migrations, ops |
| 09 | [`09-sdk-cli.md`](./09-sdk-cli.md) | Client SDK + `cuki run` env injection |

## Design principles

1. **Single binary, single dependency.** The executable carries the API, the dashboard, and
   the client. It talks to one external thing: Postgres. No embedded DB engine to babysit;
   in exchange, every instance is stateless and scales horizontally by default.
2. **The server never stores decryptable secret material it doesn't need.** Service
   identities are asymmetric (a public key on the server; the private key only on the
   client). The KEK lives outside the DB.
3. **Secrets are encrypted end-to-end to the consuming service.** At rest under the KEK,
   and again *on delivery* — each retrieval response is HPKE-sealed to the requesting
   service's key, so only that service's private key can open it, independent of TLS.
4. **Everything is an Effect.** Errors are values (tagged), dependencies are Layers,
   config is typed and redacted. No thrown exceptions across service boundaries.
5. **Least privilege on retrieval.** A service can read exactly the keys granted to it,
   nothing else, and only via short-lived tokens.
6. **Every secret access is audited.** Non-repudiable log of which actor read which key,
   when, from where — this is a product feature, not an afterthought.
7. **Config and secrets are the same primitive.** A `key` is `public` or `sensitive`;
   the difference is encryption at rest and dashboard visibility.

## Stack

- **Language:** TypeScript, strict. ESM.
- **Runtime / effects:** [Effect](https://effect.website) 3.x — services, layers, tagged errors, `Config`.
- **HTTP:** `@effect/platform` `HttpApi` + `@effect/platform-node` (or `-bun`).
- **Schema/validation:** `effect/Schema` at all API and domain boundaries. See the note below.
- **DB / ORM:** Drizzle ORM, wrapped via `@effect/sql-drizzle` over `@effect/sql-pg`. Postgres.
- **Crypto:** `@noble/ciphers` (XChaCha20-Poly1305, AES-256-GCM), `@noble/curves`
  (Ed25519 for auth; X25519 for delivery encryption, derived from the service's Ed25519
  key), `@noble/hashes`, and HPKE base mode (RFC 9180) for sealing responses to a service.
  All pure JS — no native build step, keeps the single-binary story clean.
- **Frontend:** Vite SPA (React), hand-rolled CSS design system, built and embedded.
- **Build:** `bun build --compile` → one executable.

### On Zod vs `effect/Schema`

Use `effect/Schema`, not Zod, for API request/response and domain models. `HttpApi`
derives its handlers, OpenAPI spec, and client directly from `Schema`; the error
channel and encode/decode integrate with Effect natively. Introducing Zod here means
maintaining a parallel set of schemas with no payoff. Keep Zod only for isolated,
non-Effect edges if any appear.

## Glossary

Two unrelated things are called "keys." Be disciplined.

- **Key (domain object):** a named entry inside an environment — `DATABASE_URL`,
  `STRIPE_KEY`, etc. `type` is `public` (config, stored plaintext) or `sensitive`
  (secret, encrypted at rest). This is *the* main data object.
- **KEK — Key Encryption Key:** the instance master key. Encrypts DEKs. Never in the DB.
- **DEK — Data Encryption Key:** a per-secret-version symmetric key that encrypts one
  sensitive value. Stored only in KEK-wrapped form.
- **Service identity key:** a single Ed25519 keypair per service. The service holds the
  private key; cuki stores the public key (and its derived X25519 public key). The one key
  both **signs** challenges (auth) and **decrypts** sealed responses (its X25519 form).
- **Sealed envelope:** the HPKE-encrypted `/secrets` response — `{ enc, ciphertext, suite }`
  — decryptable only by the target service's private key. See [`03`](./03-cryptography.md).
- **Access token:** an opaque, time-bound bearer credential a service receives after a
  successful challenge–response; authorizes *which* keys it may read. Orthogonal to the
  sealed envelope, which controls *who can read the bytes*.
- **Grant:** an authorization row linking a service to a specific key it may read.
- **Project → Environment → {Key, Service}:** the containment hierarchy. Keys and
  services live inside an environment; a service can only be granted keys in its own env.

## Implementation phases

Build in this order — each phase is independently testable.

- **P0 — Scaffold.** Effect app skeleton, typed `Config`, Postgres connection + Drizzle
  migrations, health endpoint, structured logging.
- **P1 — Crypto core.** KEK loading (`Config.redacted`), envelope encrypt/decrypt at rest,
  DEK wrap/unwrap, KEK rotation, HPKE seal-to-client + Ed25519→X25519 derivation,
  known-answer tests. No DB coupling.
- **P2 — Data model.** All tables + repositories over Drizzle/Postgres. Migrations.
- **P3 — Management plane.** User auth (sessions), RBAC, CRUD for orgs/projects/
  environments/keys/services/grants. Dashboard talks to this.
- **P4 — Retrieval plane.** Service challenge–response, access-token issuance, scoped
  retrieval, decrypt-at-rest then HPKE-seal-to-service on read.
- **P5 — Audit & analytics.** Append-only audit log on every access; aggregate queries
  powering the dashboard.
- **P6 — Dashboard.** SPA against the management plane; build + embed.
- **P7 — Client.** SDK + CLI (`cuki get`, `cuki run -- <cmd>`) doing the auth dance and
  caching the token.
- **P8 — Package.** `bun build --compile`, config precedence, `cuki init`/`migrate`/`serve`.
