# 08 — Deployment (single binary)

cuki ships as one executable that is server, migrator, and client. It requires a Postgres
database — the single operational dependency. The dashboard SPA is embedded in the binary;
there is no embedded DB engine. External KMS is opt-in. Because all state lives in Postgres,
instances are stateless and horizontally scalable by default.

## Build

Use `bun build --compile` to produce a self-contained executable. Bun runs Effect fine and
embeds the JS runtime + assets, avoiding Node SEA friction and native-module headaches
(hence the pure-JS `@noble/*` crypto choice).

```bash
# 1. build the dashboard SPA into the server's embedded assets dir
(cd web && bun run build)          # → web/dist
cp -r web/dist src/http/assets

# 2. compile the single binary
bun build ./src/main.ts \
  --compile \
  --target bun \
  --minify \
  --outfile dist/cuki
```

- **Embedded SPA:** import the built assets so they're baked into the binary; the
  `static.ts` layer serves them for non-`/v1` routes with SPA fallback to `index.html`.
- **Datastore:** external Postgres, reached over the network via `CUKI_DATABASE_URL`. Not
  embedded — the binary carries the app + dashboard, not a database engine.
- **Cross-target:** run the compile per target (`bun build --target=bun-linux-x64`,
  `bun-darwin-arm64`, etc.) in CI to ship platform binaries.

> If a fully static Node build is required instead of Bun, fall back to Node SEA + a
> bundler, but Bun compile is the recommended path for the single-binary goal.

## Commands (subcommands of the one binary)

```
cuki init                 # generate a master key (prints base64) + scaffold config; seed kek_versions fingerprint
cuki migrate              # run Drizzle migrations against the configured datastore
cuki serve                # run the HTTP server (auto-migrates by default unless --no-migrate)
cuki kek rotate           # re-wrap all DEKs old→new KEK (03)
# client subcommands (09):
cuki login                # obtain/store a service credential context
cuki get <NAME>           # print one secret
cuki run -- <cmd...>      # inject granted keys as env vars into a subprocess
```

Server and client share the binary; client subcommands use the SDK against a remote cuki.

## Configuration

Precedence: **CLI flags > environment variables > config file > defaults.** Secrets come
via `Config.redacted`.

| Concern | Env | Notes |
|---|---|---|
| Listen addr | `CUKI_ADDR` | default `0.0.0.0:8787` |
| Postgres URL | `CUKI_DATABASE_URL` | **required**; redacted |
| DB pool size | `CUKI_DB_POOL` | default `10` |
| Master key | `CUKI_MASTER_KEY` | base64(32); redacted |
| Master key file | `CUKI_MASTER_KEY_FILE` | path; for secret mounts |
| Passphrase | `CUKI_MASTER_PASSPHRASE` | Argon2id-derived KEK; lower assurance |
| KMS provider | `CUKI_KEK_PROVIDER` | `local`(default)\|`aws-kms`\|`gcp-kms`\|`vault-transit` |
| Access token TTL | `CUKI_TOKEN_TTL` | default `600s` |
| Challenge TTL | `CUKI_CHALLENGE_TTL` | default `30s` |
| Session TTL | `CUKI_SESSION_TTL` | default `7d` |
| TLS | `CUKI_TLS_CERT`/`_KEY` | optional; else terminate TLS at a proxy |
| Log level | `CUKI_LOG` | `info` default |

A `cuki.toml`/`.env` config file supplies the same keys for non-container deploys.

## Startup sequence (`cuki serve`)

1. Load + validate `Config` (fail fast on missing master key / bad addr).
2. Connect to Postgres (`CUKI_DATABASE_URL`); run migrations (unless `--no-migrate`).
3. Load KEK via provider; **verify fingerprint** against `kek_versions` active row — abort
   on mismatch ([`03`](./03-cryptography.md)).
4. Build `AppLayer`; start background sweeper fiber (expired challenges/tokens).
5. Bind HTTP; serve `/v1` (API) and `/*` (embedded SPA). Emit a ready log with addr,
   datastore kind, KEK provider, KEK fingerprint (not the key).

## Operations

- **Backups:** back up **Postgres** (and `kek_versions` within it) **and** the KEK
  separately. A DB backup without the KEK cannot reveal sensitive values (by design);
  losing the KEK is unrecoverable — state this loudly in ops docs.
- **Health:** `GET /healthz` (liveness), `GET /readyz` (Postgres reachable, KEK loaded).
- **Metrics/traces:** Effect spans; optional OTLP exporter behind config.
- **Zero-downtime rotation:** KEK rotation runs online (per-row re-wrap in transactions);
  no plaintext exposure, values remain readable throughout.
- **Scaling:** instances are stateless — all auth/session/token state is in Postgres — so
  run as many as you like behind a load balancer, no stickiness. Scale Postgres
  (connection pooler, read replicas for analytics) independently.
- **Container:** distroless image containing just the binary, a mounted KEK secret, and
  `CUKI_DATABASE_URL` pointing at your Postgres. No local volume required.

## Migrations

Authored with drizzle-kit against `schema.ts` (Postgres). Migrations are embedded and
applied by `cuki migrate` / on boot. Never edit an applied migration; always add a new one.
Sensitive columns are `bytea`; migrations must never carry data transforms that would
require plaintext.
