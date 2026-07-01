# 07 — Dashboard

A Vite SPA (React) built to a static bundle and embedded in the binary ([`08`](./08-deployment.md)).
It talks only to the management plane using the derived `HttpApi` client, so types never
drift from the server. No secret plaintext is fetched for normal views — sensitive values
are masked and only `reveal` (audited, admin-gated) fetches them on demand.

## Goals

Developers should understand the hierarchy in seconds, set/rotate keys without friction,
wire up a service in one flow, and see exactly which service read which key. Clean,
branded, fast.

## Design system

Match the house aesthetic. Hand-rolled CSS with tokens — no CSS/component framework.

- **Mode:** dark, minimal. One surface, quiet chrome, content-forward.
- **Radius:** `0` everywhere. Sharp edges.
- **Accent:** a single accent color per surface. Reuse cuki brand accent; don't scatter
  colors — status uses tint of one hue, not a rainbow.
- **Type:** UI in a clean grotesk (e.g. Space Grotesk / Inter). **All numeric and data
  content in JetBrains Mono** — key names, values, ids, tokens, timestamps, counts, log
  rows, analytics figures. Monospace is the data voice of the product.
- **Density:** tabular, compact rows; generous but not airy. Keyboard-navigable tables.
- **Motion:** minimal, functional (focus/hover/state), no decorative animation.

Tokens (CSS custom properties): `--bg`, `--surface`, `--border`, `--fg`, `--fg-muted`,
`--accent`, `--danger`, `--mono`, `--sans`, spacing scale, one elevation. Keep the set
small and enforce it.

## Information architecture

```
Sidebar: Org switcher → Projects
Project → Environments (tabs: development / staging / production / …)
Environment view:
  ├─ Keys tab      — table of keys (name · type · version · updated · updated_by)
  ├─ Services tab  — table of services (name · service_id · status · last auth · #grants)
  └─ Activity tab  — access log scoped to this environment
Org-level:
  ├─ Audit         — full org access/audit log with filters
  ├─ Analytics     — access aggregates
  └─ Members       — RBAC management
```

## Key screens

### Keys table (environment)

- Columns (mono where data): `name` · `type` (`sensitive`/`public` chip) · `version` ·
  `updated_at` · `updated_by`. Value column shows `••••••` for sensitive, actual value
  (mono, truncated) for public.
- Inline **create/edit** drawer: name, type toggle, value (masked input for sensitive),
  description. Setting a value on an existing key creates a new version.
- Row actions: **Reveal** (sensitive; admin+; confirms + audits), **Rotate/Set value**,
  **Rollback** (version picker), **Delete**. Reveal shows the value transiently with a
  copy button and an explicit "this was logged" note.
- Bulk import/export of a whole environment (dotenv-style) for public keys; sensitive
  import accepts values but they're immediately encrypted server-side.

### Service setup flow

1. Create service (name, optional IP allowlist) → **copy-once modal**: shows
   `service_id` + `private_key`, download `cuki.svc`, plus ready-to-paste snippets
   (env vars, SDK init, `cuki run` command). Big, unmistakable "you won't see this again".
2. **Grant keys**: multiselect of the environment's keys → creates grants. Show current
   grants as removable chips.
3. **Verify**: a "test retrieval" panel that shows the exact challenge→token→secrets
   sequence the service will perform (educational; helps developers trust the flow).

### Activity / audit

- Reverse-chronological table (mono): time · actor (user/service, with icon) · action ·
  target (key/service/env) · result (success/denied) · ip.
- Filters: actor type, action, environment, date range, result. Cursor pagination.
- Row expands to full metadata (which key ids were read, fail reason code, user agent).
- Failures (`auth.fail`, `denied`) visually distinct (danger tint) — this doubles as a
  security view.

### Analytics

Aggregates over `audit_logs` (all figures in JetBrains Mono):

- Reads over time (line/area), grouped by day.
- Top services by read volume; top keys by read volume.
- Per-service: last auth, reads (24h/7d), grant count, status.
- Per-key: last read, distinct services reading it, read count — the "who's using this
  secret" answer, useful before rotating or deleting a key.

## Data & state

- Fetching via the typed `HttpApi` client; React Query (or Effect-based fetching) for
  cache/invalidation. No secrets cached beyond a reveal's transient display.
- Auth = session cookie; the app bootstraps from `GET /v1/auth/me`.
- Route-level RBAC: hide/disable actions the current role can't perform; the server still
  enforces — the UI just avoids dead ends.

## Non-goals (v1)

No theming beyond dark, no per-user dashboards, no in-app secret editing history diff view
(the version list + audit covers it). Keep it tight.
