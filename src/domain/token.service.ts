import { Duration, Effect, Option } from "effect"
import { AppConfig } from "../config"
import { buildAuthMessage } from "../crypto/constants"
import { ed25519Verify, random, sha256Hash } from "../crypto/keys"
import { ChallengeInvalid, Unauthorized } from "../errors"
import { AuthStateRepo } from "../repo/authstate.repo"
import { ServiceRepo } from "../repo/service.repo"
import { fromBase64, fromBase64Url, toBase64Url } from "../util/bytes"
import { ipInCidrs } from "../util/cidr"
import { dieSqlApi } from "../util/effect"
import { newId } from "../util/id"
import type { CurrentServiceData } from "./context"

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

/**
 * Retrieval-plane service auth (design 04). Ed25519 challenge–response → short-lived,
 * scoped, opaque access token. Failure reasons are carried as `ChallengeInvalid.code` for
 * the audit log; the HTTP boundary collapses them to a generic 401.
 */
export class TokenService extends Effect.Service<TokenService>()("TokenService", {
  effect: Effect.gen(function* () {
    const services = yield* ServiceRepo
    const authState = yield* AuthStateRepo
    const cfg = yield* AppConfig

    const fail = (code: ChallengeInvalid["code"]) => Effect.fail(new ChallengeInvalid({ code }))

    return dieSqlApi({
      /** Issue a single-use challenge nonce for a service handle. */
      issueChallenge: (serviceHandle: string, ip: string | null) =>
        Effect.gen(function* () {
          const found = yield* services.findByHandle(serviceHandle)
          if (Option.isNone(found)) return yield* fail("unknown_service")
          const svc = found.value
          if (svc.status !== "active") return yield* fail("revoked")
          if (svc.ipAllowlist && svc.ipAllowlist.length > 0) {
            if (ip === null || !ipInCidrs(ip, svc.ipAllowlist)) return yield* fail("ip_denied")
          }
          const nonce = random(CHALLENGE_NONCE_BYTES)
          const challengeId = newId()
          const expiresAt = new Date(Date.now() + Duration.toMillis(cfg.ttl.challenge))
          // A DB write failure here is infra, not an auth failure — let it surface as 500
          // (dieSqlApi) rather than a misleading "unknown_service" 401.
          yield* authState.createChallenge({ id: challengeId, serviceId: svc.id, nonce, expiresAt })
          return { challengeId, nonce, expiresAt }
        }),

      /** Verify a challenge signature and issue a scoped access token. */
      verifyAndIssue: (challengeId: string, signatureB64: string, ip: string | null) =>
        Effect.gen(function* () {
          const chFound = yield* authState.findChallenge(challengeId).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(chFound)) return yield* fail("challenge_expired")
          const ch = chFound.value
          if (ch.consumedAt !== null) return yield* fail("challenge_consumed")
          if (ch.expiresAt.getTime() <= Date.now()) return yield* fail("challenge_expired")

          const svcFound = yield* services.findById(ch.serviceId).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(svcFound)) return yield* fail("unknown_service")
          const svc = svcFound.value
          if (svc.status !== "active") return yield* fail("revoked")

          // Reconstruct the message from stored service_id + nonce; never trust the client's.
          const message = buildAuthMessage(svc.serviceId, ch.nonce)
          const signature = yield* Effect.try({
            try: () => fromBase64(signatureB64),
            catch: () => new ChallengeInvalid({ code: "bad_signature" }),
          })
          if (!ed25519Verify(signature, message, svc.publicKey)) return yield* fail("bad_signature")

          // Single-use: atomically consume. A lost race means already-consumed.
          const consumed = yield* authState
            .consumeChallenge(challengeId, new Date())
            .pipe(Effect.catchAll(() => Effect.succeed(Option.none())))
          if (Option.isNone(consumed)) return yield* fail("challenge_consumed")

          // Fail closed: a DB error here must abort issuance (dieSqlApi -> 500), not mint a
          // useless empty-scope token. A genuinely grant-less service still yields [].
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
            issuedIp: ip,
          })
          yield* services.updateLastAuth(svc.id, new Date()).pipe(Effect.ignore)

          return {
            accessToken,
            tokenId,
            expiresAt,
            expiresIn: Math.floor(Duration.toMillis(cfg.ttl.token) / 1000),
            scopeKeyIds,
          }
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
          }
        }),
    })
  }),
}) {}
