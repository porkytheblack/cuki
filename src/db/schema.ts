import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

/**
 * Drizzle schema — the single source of truth for the datastore (design 02).
 * IDs are ULIDs (`text`), sortable + URL-safe. Timestamps are `timestamptz`.
 * Binary columns are `bytea`; JSON is `jsonb`.
 */

/** Reusable bytea helper: app sees `Uint8Array`, driver sees `Buffer`. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
})

const ts = (name: string) => timestamp(name, { withTimezone: true })

// ── Tenancy ──────────────────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
})

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"), // argon2id; null if SSO-only
  createdAt: ts("created_at").notNull().defaultNow(),
})

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId)],
)

// ── Hierarchy ──────────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug)],
)

export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    protected: boolean("protected").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("environments_project_slug_uq").on(t.projectId, t.slug)],
)

// ── The main object: keys + key_versions ───────────────────────────────────────

export const keys = pgTable(
  "keys",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["sensitive", "public"] }).notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    description: text("description"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("keys_env_name_uq").on(t.environmentId, t.name)],
)

export const keyVersions = pgTable(
  "key_versions",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // exactly one representation is populated, per keys.type:
    plaintext: text("plaintext"), // PUBLIC keys only
    ciphertext: bytea("ciphertext"), // SENSITIVE: AEAD(DEK, value)
    nonce: bytea("nonce"),
    wrappedDek: bytea("wrapped_dek"), // AEAD(KEK, DEK)
    dekNonce: bytea("dek_nonce"),
    kekVersion: integer("kek_version"),
    aead: text("aead", { enum: ["xchacha20poly1305", "aes256gcm"] }),
    createdBy: text("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("key_versions_key_version_uq").on(t.keyId, t.version),
    index("key_versions_key_idx").on(t.keyId),
  ],
)

// ── Machine identities: services + grants ──────────────────────────────────────

export const services = pgTable("services", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id")
    .notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  serviceId: text("service_id").notNull().unique(), // public handle, e.g. svc_01H...
  publicKey: bytea("public_key").notNull(), // Ed25519 verify key (32 bytes)
  encPublicKey: bytea("enc_public_key").notNull(), // X25519 pub, HPKE recipient key
  status: text("status", { enum: ["active", "revoked"] })
    .notNull()
    .default("active"),
  ipAllowlist: jsonb("ip_allowlist").$type<string[]>(), // optional string[] of CIDRs
  lastAuthAt: ts("last_auth_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
})

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    keyId: text("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grants_service_key_uq").on(t.serviceId, t.keyId),
    index("grants_service_idx").on(t.serviceId),
    index("grants_key_idx").on(t.keyId),
  ],
)

// ── Auth state: challenges + access_tokens ─────────────────────────────────────

export const challenges = pgTable(
  "challenges",
  {
    id: text("id").primaryKey(), // challenge_id
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    nonce: bytea("nonce").notNull(), // 32 random bytes
    expiresAt: ts("expires_at").notNull(), // ≈ now + 30s
    consumedAt: ts("consumed_at"), // single-use
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("challenges_service_exp_idx").on(t.serviceId, t.expiresAt)],
)

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull().unique(), // SHA-256(opaque token)
    scopeKeyIds: jsonb("scope_key_ids").$type<string[]>().notNull(), // snapshot at issue
    expiresAt: ts("expires_at").notNull(), // ≈ now + 10m
    revokedAt: ts("revoked_at"),
    issuedIp: text("issued_ip"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("access_tokens_service_idx").on(t.serviceId)],
)

// ── Audit ──────────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type", { enum: ["user", "service", "system"] }).notNull(),
    actorId: text("actor_id"), // user id or service id
    action: text("action").notNull(), // "secret.read", "key.write", ...
    environmentId: text("environment_id"),
    targetType: text("target_type"), // "key" | "service" | "environment" | ...
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    result: text("result", { enum: ["success", "denied", "error"] }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_org_time_idx").on(t.orgId, t.createdAt),
    index("audit_actor_idx").on(t.actorType, t.actorId),
  ],
)

// ── User sessions (management plane) ───────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: bytea("token_hash").notNull().unique(), // hash of the session cookie value
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
})

// ── KEK registry (metadata only — never the key itself) ────────────────────────

export const kekVersions = pgTable("kek_versions", {
  version: integer("version").primaryKey(),
  fingerprint: text("fingerprint").notNull(), // SHA-256(KEK)[:8] misconfig guard
  status: text("status", { enum: ["active", "retired"] }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
})

// ── Inferred row types ─────────────────────────────────────────────────────────

export type Organization = typeof organizations.$inferSelect
export type User = typeof users.$inferSelect
export type Membership = typeof memberships.$inferSelect
export type Project = typeof projects.$inferSelect
export type Environment = typeof environments.$inferSelect
export type Key = typeof keys.$inferSelect
export type KeyVersion = typeof keyVersions.$inferSelect
export type Service = typeof services.$inferSelect
export type Grant = typeof grants.$inferSelect
export type Challenge = typeof challenges.$inferSelect
export type AccessToken = typeof accessTokens.$inferSelect
export type AuditLog = typeof auditLogs.$inferSelect
export type Session = typeof sessions.$inferSelect
export type KekVersionRow = typeof kekVersions.$inferSelect
