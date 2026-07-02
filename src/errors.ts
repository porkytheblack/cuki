import { Schema } from "effect"
import { HttpApiSchema } from "@effect/platform"

/**
 * Tagged domain errors. Every failure that can cross a service boundary is a value here,
 * never a thrown exception (design 05 + 06). Errors that surface on the HTTP API are
 * `Schema.TaggedError`s annotated with their HTTP status so `HttpApi` maps them directly.
 *
 * Wire shape (idiomatic HttpApi): `{ "_tag": "Forbidden", "message": "...", "need": "admin" }`.
 * Retrieval-plane auth failures are collapsed to a generic `Unauthorized` at the HTTP
 * boundary — the specific `ChallengeInvalid.code` goes to the audit log only, never the client.
 */

// ── RBAC role, shared across errors + auth ───────────────────────────────────
export const Role = Schema.Literal("owner", "admin", "member", "viewer")
export type Role = typeof Role.Type

// ── Retrieval-plane challenge failure reason codes (audit only) ───────────────
export const ChallengeFailCode = Schema.Literal(
  "unknown_service",
  "revoked",
  "challenge_expired",
  "challenge_consumed",
  "bad_signature",
  "ip_denied",
  "rate_limited",
)
export type ChallengeFailCode = typeof ChallengeFailCode.Type

// ── HTTP-facing errors ───────────────────────────────────────────────────────

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.optionalWith(Schema.String, { default: () => "unauthorized" }) },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    need: Role,
    message: Schema.optionalWith(Schema.String, { default: () => "insufficient role" }),
  },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { resource: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 409 }),
) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  { issues: Schema.Array(Schema.String) },
  HttpApiSchema.annotations({ status: 422 }),
) {}

/**
 * Retrieval-plane auth failure. `code` is for the audit log only; at the HTTP boundary the
 * retrieval handlers translate this into a generic `Unauthorized` so the client cannot
 * distinguish "unknown service" from "bad signature".
 */
export class ChallengeInvalid extends Schema.TaggedError<ChallengeInvalid>()(
  "ChallengeInvalid",
  { code: ChallengeFailCode },
  HttpApiSchema.annotations({ status: 401 }),
) {}

/** Opaque by design — crypto failures never leak detail to the client. */
export class CryptoError extends Schema.TaggedError<CryptoError>()(
  "CryptoError",
  { message: Schema.optionalWith(Schema.String, { default: () => "crypto error" }) },
  HttpApiSchema.annotations({ status: 500 }),
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfter: Schema.Number },
  HttpApiSchema.annotations({ status: 429 }),
) {}

/** Persistence-layer failure. Never returned raw to a client; mapped to 500 at the edge. */
export class RepoError extends Schema.TaggedError<RepoError>()(
  "RepoError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}
