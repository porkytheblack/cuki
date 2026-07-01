# 02 — Data model

Postgres is the datastore. One dialect, no embedded-engine story to maintain — an external
Postgres is the single operational dependency (see [`08`](./08-deployment.md)) and buys you
stateless, horizontally-scalable cuki instances for free. IDs are ULIDs (`text`), sortable
and URL-safe. Timestamps are `timestamptz`. Binary columns are `bytea`. JSON is `jsonb`.

Define a `bytea` helper once (Drizzle `customType`) and reuse it:

```ts
import { customType } from "drizzle-orm/pg-core"
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
})
```

## ER model

```mermaid
erDiagram
  organizations ||--o{ memberships : has
  users ||--o{ memberships : in
  organizations ||--o{ projects : owns
  projects ||--o{ environments : contains
  environments ||--o{ keys : holds
  environments ||--o{ services : holds
  keys ||--o{ key_versions : versions
  services ||--o{ grants : granted
  keys ||--o{ grants : to
  services ||--o{ challenges : requests
  services ||--o{ access_tokens : issued
  organizations ||--o{ audit_logs : records

  organizations { text id PK }
  users { text id PK }
  memberships { text id PK }
  projects { text id PK }
  environments { text id PK }
  keys { text id PK }
  key_versions { text id PK }
  services { text id PK }
  grants { text id PK }
  challenges { text id PK }
  access_tokens { text id PK }
  audit_logs { text id PK }
```

## Entities

### Tenancy: organizations, users, memberships

Multi-tenant from day one — you cannot retrofit access control into a secrets store. A
solo user just has a personal org. `memberships.role` drives RBAC ([`04`](./04-auth.md)).

```ts
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),        // argon2id; null if SSO-only
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId) }))
```

### Hierarchy: projects, environments

```ts
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug) }))

export const environments = pgTable("environments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                // "development" | "staging" | "production" | custom
  slug: text("slug").notNull(),
  protected: boolean("protected").notNull().default(false), // extra guard on prod writes
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("environments_project_slug_uq").on(t.projectId, t.slug) }))
```

### The main object: keys + key_versions

`keys` is metadata; `key_versions` carries values. Splitting them gives free versioning,
rollback, value-change history, and an audit trail of *what a value was*, without ever
storing plaintext for sensitive keys.

```ts
export const keys = pgTable("keys", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                // e.g. DATABASE_URL
  type: text("type", { enum: ["sensitive", "public"] }).notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("keys_env_name_uq").on(t.environmentId, t.name) }))

export const keyVersions = pgTable("key_versions", {
  id: text("id").primaryKey(),
  keyId: text("key_id").notNull().references(() => keys.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  // exactly one representation is populated, per keys.type:
  plaintext: text("plaintext"),                // PUBLIC keys only
  ciphertext: bytea("ciphertext"),             // SENSITIVE: AEAD(DEK, value)
  nonce: bytea("nonce"),                        // AEAD nonce for the value
  wrappedDek: bytea("wrapped_dek"),             // AEAD(KEK, DEK)
  dekNonce: bytea("dek_nonce"),                 // AEAD nonce for the DEK wrap
  kekVersion: integer("kek_version"),          // which KEK generation wrapped the DEK
  aead: text("aead"),                          // "xchacha20poly1305" | "aes256gcm"
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("key_versions_key_version_uq").on(t.keyId, t.version) }))
```

This encryption is **at rest**, under the instance KEK. It is independent of the
**delivery** encryption applied when a value leaves the server toward a service (HPKE seal
to the service's key — see [`03`](./03-cryptography.md)). Retrieval reads the row at
`keys.currentVersion`; rotation inserts a new version and bumps `currentVersion` in one
transaction.

### Machine identities: services + grants

`serviceId` is the public handle a service presents. `publicKey` is the Ed25519 verify key
used for challenge signatures. `encPublicKey` is the X25519 public key used to **encrypt
retrieval responses to this service** — it is derived from the Ed25519 key at creation and
stored denormalized so the server doesn't re-derive per request. **No secret material for
the service is stored**; the single private key (which serves both signing and decryption)
is shown to the operator once at creation and never persisted by cuki.

```ts
export const services = pgTable("services", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  serviceId: text("service_id").notNull().unique(),   // public handle, e.g. svc_01H...
  publicKey: bytea("public_key").notNull(),           // Ed25519 verify key (32 bytes)
  encPublicKey: bytea("enc_public_key").notNull(),    // X25519 pub, derived from publicKey; recipient key for HPKE seal
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  ipAllowlist: jsonb("ip_allowlist"),                 // optional string[] of CIDRs
  lastAuthAt: timestamp("last_auth_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const grants = pgTable("grants", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull().references(() => keys.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: uniqueIndex("grants_service_key_uq").on(t.serviceId, t.keyId) }))
```

Integrity rule (enforce in the service layer, not just FKs): a `grant` is only valid when
`services.environmentId === keys.environmentId`.

### Auth state: challenges + access_tokens

```ts
export const challenges = pgTable("challenges", {
  id: text("id").primaryKey(),                 // challenge_id
  serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  nonce: bytea("nonce").notNull(),             // 32 random bytes
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),   // ≈ now + 30s
  consumedAt: timestamp("consumed_at", { withTimezone: true }),            // single-use
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const accessTokens = pgTable("access_tokens", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  tokenHash: bytea("token_hash").notNull().unique(),  // SHA-256 of the opaque token; raw token never stored
  scopeKeyIds: jsonb("scope_key_ids").notNull(),      // string[] snapshot of granted key ids at issue time
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),    // ≈ now + 10m
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  issuedIp: text("issued_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
```

Both tables need a periodic sweep (delete expired rows) — a background Effect fiber on a
`Schedule`. Look tokens up by `tokenHash`; never store or log the raw token.

### Audit: audit_logs

Append-only. The dashboard's "who read what" and analytics come entirely from here.

```ts
export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ["user", "service", "system"] }).notNull(),
  actorId: text("actor_id"),                   // user id or service id
  action: text("action").notNull(),           // "secret.read", "key.write", "service.create", "auth.fail", ...
  environmentId: text("environment_id"),
  targetType: text("target_type"),            // "key" | "service" | "environment" | ...
  targetId: text("target_id"),
  metadata: jsonb("metadata"),                // key ids read, reason codes, etc.
  ip: text("ip"),
  userAgent: text("user_agent"),
  result: text("result", { enum: ["success", "denied", "error"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrgTime: index("audit_org_time_idx").on(t.orgId, t.createdAt),
  byActor: index("audit_actor_idx").on(t.actorType, t.actorId),
}))
```

### User sessions (management plane)

```ts
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: bytea("token_hash").notNull().unique(),   // hash of the session cookie value
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
```

### KEK registry (metadata only — never the key itself)

```ts
export const kekVersions = pgTable("kek_versions", {
  version: integer("version").primaryKey(),
  fingerprint: text("fingerprint").notNull(),  // SHA-256(KEK)[:8] to detect misconfiguration at boot
  status: text("status", { enum: ["active", "retired"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
```

## Indexing summary

Beyond the unique indexes above: `key_versions(key_id)`, `grants(service_id)`,
`grants(key_id)`, `access_tokens(token_hash)`, `challenges(service_id, expires_at)`,
`audit_logs(org_id, created_at)`. These cover retrieval-hot paths and dashboard queries.
