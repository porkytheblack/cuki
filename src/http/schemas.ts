import { Schema } from "effect"
import { Role } from "../errors"

/**
 * HTTP request/response schemas (design 05). `HttpApi` derives handlers, OpenAPI, and the
 * typed client from these. The management plane (dashboard-only) uses camelCase; the
 * service-auth + retrieval plane uses the documented snake_case protocol for third-party
 * client interop.
 */

const Timestamp = Schema.Date
const NullableString = Schema.NullOr(Schema.String)

// ── Users / auth ──
export const UserDto = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.String,
  createdAt: Timestamp,
})
export const MembershipDto = Schema.Struct({ orgId: Schema.String, role: Role })
export const MeDto = Schema.Struct({ user: UserDto, memberships: Schema.Array(MembershipDto) })

export const LoginRequest = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
})
export const RegisterRequest = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
  password: Schema.String.pipe(Schema.minLength(8)),
})

// ── Orgs / members ──
export const OrgDto = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  role: Role,
  createdAt: Timestamp,
})
export const CreateOrgRequest = Schema.Struct({ name: Schema.String })
export const MemberDto = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Role,
  createdAt: Timestamp,
})
export const AddMemberRequest = Schema.Struct({ email: Schema.String, role: Role })
export const UpdateMemberRequest = Schema.Struct({ role: Role })

// ── Projects / environments ──
export const ProjectDto = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  createdAt: Timestamp,
})
export const CreateProjectRequest = Schema.Struct({ name: Schema.String })
export const EnvironmentDto = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  protected: Schema.Boolean,
  createdAt: Timestamp,
})
export const CreateEnvironmentRequest = Schema.Struct({
  name: Schema.String,
  protected: Schema.optional(Schema.Boolean),
})

// ── Keys ──
export const KeyType = Schema.Literal("sensitive", "public")
export const KeyMetaDto = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: KeyType,
  currentVersion: Schema.Number,
  description: NullableString,
  updatedAt: Timestamp,
  updatedBy: NullableString,
  /** Present (plaintext) for public keys; null for sensitive (use reveal). */
  value: NullableString,
})
export const KeyVersionDto = Schema.Struct({
  version: Schema.Number,
  createdBy: NullableString,
  createdAt: Timestamp,
})
export const KeyDetailDto = Schema.Struct({
  key: KeyMetaDto,
  versions: Schema.Array(KeyVersionDto),
})
export const CreateKeyRequest = Schema.Struct({
  name: Schema.String,
  type: KeyType,
  value: Schema.String,
  description: Schema.optional(Schema.String),
})
export const SetKeyValueRequest = Schema.Struct({ value: Schema.String })
export const RollbackRequest = Schema.Struct({ version: Schema.Number })
export const RevealDto = Schema.Struct({ value: Schema.String })

// ── Services / grants ──
export const ServiceDto = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  serviceId: Schema.String,
  status: Schema.Literal("active", "revoked"),
  ipAllowlist: Schema.NullOr(Schema.Array(Schema.String)),
  lastAuthAt: Schema.NullOr(Timestamp),
  grants: Schema.Number,
  createdAt: Timestamp,
})
export const ServiceCreatedDto = Schema.Struct({
  service: ServiceDto,
  privateKey: Schema.String,
})
export const PrivateKeyDto = Schema.Struct({ privateKey: Schema.String })
export const CreateServiceRequest = Schema.Struct({
  name: Schema.String,
  ipAllowlist: Schema.optional(Schema.Array(Schema.String)),
})
export const GrantDto = Schema.Struct({
  id: Schema.String,
  keyId: Schema.String,
  keyName: Schema.String,
  keyType: KeyType,
  createdAt: Timestamp,
})
export const AddGrantsRequest = Schema.Struct({ keyIds: Schema.Array(Schema.String) })

// ── Audit / analytics ──
export const AuditLogDto = Schema.Struct({
  id: Schema.String,
  actorType: Schema.Literal("user", "service", "system"),
  actorId: NullableString,
  action: Schema.String,
  environmentId: NullableString,
  targetType: NullableString,
  targetId: NullableString,
  metadata: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  ip: NullableString,
  userAgent: NullableString,
  result: Schema.Literal("success", "denied", "error"),
  createdAt: Timestamp,
})
export const PaginatedAuditDto = Schema.Struct({
  items: Schema.Array(AuditLogDto),
  nextCursor: NullableString,
})
export const AnalyticsDto = Schema.Struct({
  readsPerDay: Schema.Array(Schema.Struct({ day: Schema.String, count: Schema.Number })),
  topServices: Schema.Array(
    Schema.Struct({ actorId: NullableString, count: Schema.Number }),
  ),
  topKeys: Schema.Array(Schema.Struct({ keyId: Schema.String, count: Schema.Number })),
})
export const ServiceActivityDto = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    action: Schema.String,
    result: Schema.String,
    ip: NullableString,
    createdAt: Timestamp,
  }),
)
export const KeyAccessDto = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    actorType: Schema.String,
    actorId: NullableString,
    result: Schema.String,
    ip: NullableString,
    createdAt: Timestamp,
  }),
)

// ── Service auth (retrieval plane) — documented snake_case protocol ──
export const ChallengeRequest = Schema.Struct({ service_id: Schema.String })
export const ChallengeDto = Schema.Struct({
  challenge_id: Schema.String,
  nonce: Schema.String,
  algorithm: Schema.String,
  expires_at: Schema.String,
})
export const TokenRequest = Schema.Struct({
  challenge_id: Schema.String,
  signature: Schema.String,
})
export const TokenDto = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  expires_at: Schema.String,
})
export const SuiteDto = Schema.Struct({
  kem: Schema.String,
  kdf: Schema.String,
  aead: Schema.String,
})
export const SealedEnvelopeDto = Schema.Struct({
  enc: Schema.String,
  ciphertext: Schema.String,
  suite: SuiteDto,
})

// ── Query params ──
export const AuditQuery = Schema.Struct({
  actorType: Schema.optional(Schema.Literal("user", "service", "system")),
  action: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Literal("success", "denied", "error")),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const AnalyticsQuery = Schema.Struct({
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
})
