import { Duration, Effect, Option } from "effect"
import { AppConfig } from "../config"
import { buildAuthMessage } from "../crypto/constants"
import { ed25519Verify, random, sha256Hash } from "../crypto/keys"
import { ChallengeInvalid, Unauthorized } from "../errors"
import type { Service } from "../db/schema"
import { AuthStateRepo } from "../repo/authstate.repo"
import { ServiceRepo } from "../repo/service.repo"
import { fromBase64, fromBase64Url, toBase64Url } from "../util/bytes"
import { ipInCidrs } from "../util/cidr"
import { dieSqlApi } from "../util/effect"
import { newId } from "../util/id"
import { AuditService } from "./audit.service"
import type { CurrentServiceData } from "./context"
import { RateLimiter } from "./ratelimit"

const CHALLENGE_NONCE_BYTES = 32
const TOKEN_BYTES = 32

export interface IssuedChallenge {
  readonly challengeId: string
  readonly nonce: Uint8Array
  readonly expiresAt: Date
}

export interface IssuedToken {
  readonly accessToken: string
  readonly tokenId: string
  readonly expiresAt: Date
  readonly expiresIn: number
  readonly scopeKeyIds: ReadonlyArray<string>
}

export interface AuthMeta {
  readonly ip: string | null
  readonly userAgent: string | null
}

/**
 * Retrieval-plane service auth (design 04). Ed25519 challenge–response → short-lived,
 * scoped, opaque access token. Rate-limited per IP + service; repeated credential failures
 * trigger exponential-backoff lockout. Failure reasons are carried as `ChallengeInvalid.code`
 * for the audit log; the HTTP boundary collapses them to a generic 401 (rate limits → 429).
 */
export class TokenService extends Effect.Service<TokenService>()("TokenService", {
  effect: Effect.gen(function* () {
    const services = yield* ServiceRepo
    const authState = yield* AuthStateRepo
    const audit = yield* AuditService
    const rl = yield* RateLimiter
    const cfg = yield* AppConfig

    /** Audit a service auth failure to its org; unknown/pre-service failures are only logged
     * (they have no org to attribute to, and DB rows for unknown probes would be an
     * amplification vector — rate limiting bounds them instead). */
    const auditFail = (svc: Service | null, code: ChallengeInvalid["code"], meta: AuthMeta) =>
      svc
        ? services.orgAndEnvForService(svc.id).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
            Effect.flatMap((oe) =>
              Option.isSome(oe)
                ? audit.record({
                    orgId: oe.value.orgId,
                    actorType: "service",
                    actorId: svc.serviceId,
                    action: "auth.fail",
                    environmentId: oe.value.environmentId,
                    targetType: "service",
                    targetId: svc.id,
                    result: "denied",
                    ip: meta.ip,
                    userAgent: meta.userAgent,
                    metadata: { code },
                  })
                : Effect.logWarning(`auth.fail (${code}) service=${svc.serviceId} ip=${meta.ip ?? "?"}`),
            ),
          )
        : Effect.logWarning(`auth.fail (${code}) ip=${meta.ip ?? "?"}`)

    /** Record a failure: audit + (optionally) count toward lockout, then fail. */
    const failWith = (
      code: ChallengeInvalid["code"],
      meta: AuthMeta,
      opts: { svc: Service | null; handle: string | null; count: boolean },
    ) =>
      Effect.gen(function* () {
        if (opts.count) yield* rl.recordFailure(meta.ip, opts.svc?.serviceId ?? opts.handle ?? null)
        yield* auditFail(opts.svc, code, meta)
        return yield* Effect.fail(new ChallengeInvalid({ code }))
      })

    return dieSqlApi({
      /** Issue a single-use challenge nonce for a service handle. */
      issueChallenge: (serviceHandle: string, meta: AuthMeta) =>
        Effect.gen(function* () {
          yield* rl.challengeGuard(meta.ip, serviceHandle)
          const found = yield* services.findByHandle(serviceHandle)
          if (Option.isNone(found)) {
            return yield* failWith("unknown_service", meta, { svc: null, handle: serviceHandle, count: true })
          }
          const svc = found.value
          if (svc.status !== "active") {
            return yield* failWith("revoked", meta, { svc, handle: serviceHandle, count: true })
          }
          if (svc.ipAllowlist && svc.ipAllowlist.length > 0) {
            if (meta.ip === null || !ipInCidrs(meta.ip, svc.ipAllowlist)) {
              return yield* failWith("ip_denied", meta, { svc, handle: serviceHandle, count: true })
            }
          }
          const nonce = random(CHALLENGE_NONCE_BYTES)
          const challengeId = newId()
          const expiresAt = new Date(Date.now() + Duration.toMillis(cfg.ttl.challenge))
          // A DB write failure here is infra — surface as 500 (dieSqlApi), not a fake 401.
          yield* authState.createChallenge({ id: challengeId, serviceId: svc.id, nonce, expiresAt })
          return { challengeId, nonce, expiresAt } satisfies IssuedChallenge
        }),

      /** Verify a challenge signature and issue a scoped access token. */
      verifyAndIssue: (challengeId: string, signatureB64: string, meta: AuthMeta) =>
        Effect.gen(function* () {
          yield* rl.tokenGuard(meta.ip)
          const chFound = yield* authState.findChallenge(challengeId).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          // Expired/consumed/missing challenges are not credential failures — don't count
          // them toward lockout (avoids locking out slow-but-legit clients on benign races).
          if (Option.isNone(chFound)) {
            return yield* failWith("challenge_expired", meta, { svc: null, handle: null, count: false })
          }
          const ch = chFound.value
          if (ch.consumedAt !== null) {
            return yield* failWith("challenge_consumed", meta, { svc: null, handle: null, count: false })
          }
          if (ch.expiresAt.getTime() <= Date.now()) {
            return yield* failWith("challenge_expired", meta, { svc: null, handle: null, count: false })
          }

          const svcFound = yield* services.findById(ch.serviceId).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(svcFound)) {
            return yield* failWith("unknown_service", meta, { svc: null, handle: null, count: false })
          }
          const svc = svcFound.value
          if (svc.status !== "active") {
            return yield* failWith("revoked", meta, { svc, handle: svc.serviceId, count: true })
          }

          // Reconstruct the message from stored service_id + nonce; never trust the client's.
          const message = buildAuthMessage(svc.serviceId, ch.nonce)
          const signature = yield* Effect.try({
            try: () => fromBase64(signatureB64),
            catch: () => new ChallengeInvalid({ code: "bad_signature" }),
          }).pipe(
            Effect.catchTag("ChallengeInvalid", () =>
              failWith("bad_signature", meta, { svc, handle: svc.serviceId, count: true }),
            ),
          )
          if (!ed25519Verify(signature, message, svc.publicKey)) {
            return yield* failWith("bad_signature", meta, { svc, handle: svc.serviceId, count: true })
          }

          // Single-use: atomically consume. A lost race means already-consumed.
          const consumed = yield* authState
            .consumeChallenge(challengeId, new Date())
            .pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(consumed)) {
            return yield* failWith("challenge_consumed", meta, { svc, handle: svc.serviceId, count: false })
          }

          // Fail closed: a DB error here aborts issuance (500) rather than an empty-scope token.
          const scopeKeyIds = yield* services.keyIdsForService(svc.id)

          const raw = random(TOKEN_BYTES)
          const accessToken = toBase64Url(raw)
          const tokenHash = sha256Hash(raw)
          const tokenId = newId()
          const expiresAt = new Date(Date.now() + Duration.toMillis(cfg.ttl.token))
          yield* authState.createToken({
            id: tokenId,
            serviceId: svc.id,
            tokenHash,
            scopeKeyIds: [...scopeKeyIds],
            expiresAt,
            issuedIp: meta.ip,
          })
          yield* services.updateLastAuth(svc.id, new Date()).pipe(Effect.ignore)
          yield* rl.recordSuccess(meta.ip, svc.serviceId)

          return {
            accessToken,
            tokenId,
            expiresAt,
            expiresIn: Math.floor(Duration.toMillis(cfg.ttl.token) / 1000),
            scopeKeyIds,
          } satisfies IssuedToken
        }),

      /** Resolve a bearer access token to the current service + scope, or `Unauthorized`. */
      resolve: (bearer: string) =>
        Effect.gen(function* () {
          const tokenHash = sha256Hash(fromBase64Url(bearer))
          const found = yield* authState.findTokenByHash(tokenHash).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(found)) return yield* Effect.fail(new Unauthorized({}))
          const { token, service } = found.value
          if (token.revokedAt !== null) return yield* Effect.fail(new Unauthorized({}))
          if (token.expiresAt.getTime() <= Date.now()) {
            return yield* Effect.fail(new Unauthorized({}))
          }
          if (service.status !== "active") return yield* Effect.fail(new Unauthorized({}))

          const oe = yield* services.orgAndEnvForService(service.id).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(oe)) return yield* Effect.fail(new Unauthorized({}))

          return {
            service,
            scopeKeyIds: token.scopeKeyIds,
            tokenId: token.id,
            orgId: oe.value.orgId,
          } satisfies CurrentServiceData
        }),
    })
  }),
}) {}
