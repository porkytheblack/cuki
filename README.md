# cuki

A self-hosted **secrets & configuration** service that ships as one binary: HTTP API,
embedded dashboard, and a client CLI in a single executable. Its only external dependency
is Postgres.

Built with TypeScript + [Effect](https://effect.website), `@effect/platform` `HttpApi`,
Drizzle ORM over Postgres, and pure-JS `@noble/*` + HPKE crypto. The full design spec lives
in [`design/`](./design).

## Highlights

- **Two planes.** A human/session **management** plane (dashboard + admin) and a tiny,
  security-critical machine **retrieval** plane (`challenge` · `token` · `secrets`).
- **Envelope encryption at rest.** Every sensitive value gets a per-value DEK (XChaCha20-
  Poly1305) wrapped by the instance KEK, AAD-bound to `keyId∥envId∥version`. The KEK lives
  outside the DB; a DB dump alone reveals nothing.
- **End-to-end delivery encryption.** Each `/secrets` response is HPKE-sealed to the
  requesting service's key (X25519 derived from its Ed25519 identity) — opaque to proxies,
  logs, and even a compromised TLS endpoint.
- **Passwordless service auth.** Ed25519 challenge–response → short-lived, scoped, opaque,
  instantly-revocable access tokens. One service key signs challenges *and* opens sealed
  payloads.
- **RBAC + full audit.** Owner/admin/member/viewer per org; every secret access is logged.
- **KEK rotation** re-wraps DEKs online without touching value ciphertext.

## Quick start (dev)

```bash
bun install
# generate a master key + starter config
bun run src/main.ts init            # copy CUKI_MASTER_KEY into your env / .env
export CUKI_DATABASE_URL=postgresql://user:pass@localhost:5432/cuki
export CUKI_MASTER_KEY=...           # from `init`

bun run src/main.ts migrate         # apply migrations
bun run src/main.ts serve           # API + dashboard on :8787
```

Open `http://localhost:8787` for the dashboard, or `http://localhost:8787/docs` for the
OpenAPI (Scalar) reference. Dashboard dev with hot reload: `cd web && bun run dev` (proxies
`/v1` to `:8787`).

## Using a service (client)

```bash
# create a service in the dashboard → download cuki.svc (shown once)
cuki get DATABASE_URL --creds cuki.svc         # print one secret
cuki env --creds cuki.svc                      # dotenv format
cuki run --creds cuki.svc -- node server.js    # inject granted keys into the process
```

Or in code:

```ts
import { Cuki } from "cuki/client"
const cuki = Cuki.fromEnv()                      // CUKI_URL / CUKI_SERVICE_ID / CUKI_PRIVATE_KEY
const dbUrl = await cuki.getSecret("DATABASE_URL")
await cuki.intoEnv()                             // assign granted keys into process.env
```

## Build the single binary

```bash
bun run build          # build + embed the dashboard, then bun build --compile → dist/cuki
./dist/cuki serve
```

The dashboard is built (`web/`), embedded into `src/http/assets.gen.ts`, and baked into the
binary; migrations are embedded the same way, so the executable carries the app, UI, and
schema — it only needs a Postgres URL.

## Configuration

Precedence: CLI flags > env > config file > defaults. Secrets are loaded redacted.

| Env | Default | Notes |
|---|---|---|
| `CUKI_DATABASE_URL` | — (required) | Postgres URL (falls back to `DATABASE_URL`) |
| `CUKI_MASTER_KEY` | — | base64(32 bytes); or `_FILE` / `_PASSPHRASE` (+`_SALT`) |
| `CUKI_ADDR` | `0.0.0.0:8787` | listen address |
| `CUKI_TOKEN_TTL` | `600s` | access-token TTL |
| `CUKI_CHALLENGE_TTL` | `30s` | challenge TTL |
| `CUKI_SESSION_TTL` | `7d` | dashboard session TTL |
| `CUKI_LOG` | `info` | log level |

**Back up the KEK separately from the database.** A DB backup without the KEK cannot reveal
sensitive values (by design); losing the KEK is unrecoverable.

### KEK rotation

```bash
CUKI_MASTER_KEY=<new> CUKI_MASTER_KEY_OLD=<current> cuki kek rotate
```

## Commands

```
cuki init | migrate | serve | kek rotate         # server / admin
cuki get [NAME] [--json] | env | run -- <cmd>    # client (--creds cuki.svc)
```

## Testing

```bash
bun run typecheck
bun run test           # crypto known-answer + round-trip vectors
```

## Layout

```
src/crypto   envelope enc, KEK provider, HPKE seal, Ed25519↔X25519
src/db       Drizzle schema, embedded migrations, SQL layer
src/repo     repositories (only place that touches SQL)
src/domain   auth/RBAC, tokens, keys, services, audit, management
src/http     HttpApi, handlers, middleware, static SPA serving
src/client   SDK + Effect surface
src/main.ts  CLI entry
web/         Vite React dashboard
```

See [`design/`](./design) for the full architecture spec.
