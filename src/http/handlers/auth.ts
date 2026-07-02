import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { AppConfig } from "../../config"
import { AuthService } from "../../domain/auth.service"
import { ManagementService } from "../../domain/management.service"
import { TokenService } from "../../domain/token.service"
import { CurrentUser } from "../../domain/context"
import { random } from "../../crypto/keys"
import { Unauthorized } from "../../errors"
import { toBase64, toBase64Url } from "../../util/bytes"
import { api, csrfCookie, sessionCookie } from "../api"
import { clientMeta } from "../req"

/** Auth group: user register/login/logout/me + service challenge/token (design 05). */
export const AuthGroupLive = HttpApiBuilder.group(api, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const mgmt = yield* ManagementService
    const tokens = yield* TokenService
    const cfg = yield* AppConfig

    // Secure by default (HTTPS-only); CUKI_COOKIE_INSECURE=true relaxes it for local HTTP.
    const secure = cfg.security.cookieSecure
    const sessionOpts = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" }
    // CSRF cookie is deliberately readable by JS so the SPA can echo it in X-CSRF-Token.
    const csrfOpts = { httpOnly: false, secure, sameSite: "lax" as const, path: "/" }

    const startSession = (userId: string) =>
      Effect.gen(function* () {
        const { token } = yield* auth.createSession(userId)
        yield* HttpApiBuilder.securitySetCookie(sessionCookie, token, sessionOpts)
        if (cfg.security.csrfEnabled) {
          yield* HttpApiBuilder.securitySetCookie(csrfCookie, toBase64Url(random(32)), csrfOpts)
        }
      })

    const me = (userId: string, user: { id: string; email: string; name: string; createdAt: Date }) =>
      auth.membershipsFor(userId).pipe(Effect.map((memberships) => ({ user, memberships })))

    return handlers
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* auth.register(payload.email, payload.name, payload.password)
          yield* mgmt.createOrg(user.id, `${payload.name}'s Org`)
          yield* startSession(user.id)
          return yield* me(user.id, user)
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* auth.verifyCredentials(payload.email, payload.password)
          yield* startSession(user.id)
          return yield* me(user.id, user)
        }),
      )
      .handle("logout", () =>
        Effect.gen(function* () {
          yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", { ...sessionOpts, maxAge: 0 })
          yield* HttpApiBuilder.securitySetCookie(csrfCookie, "", { ...csrfOpts, maxAge: 0 })
        }),
      )
      .handle("me", () =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser
          return { user: cu.user, memberships: cu.memberships }
        }),
      )
      .handle("challenge", ({ payload }) =>
        Effect.gen(function* () {
          const meta = yield* clientMeta
          // ChallengeInvalid → generic 401 (no info leak); RateLimited passes through → 429.
          const ch = yield* tokens
            .issueChallenge(payload.service_id, meta)
            .pipe(Effect.catchTag("ChallengeInvalid", () => Effect.fail(new Unauthorized({}))))
          return {
            challenge_id: ch.challengeId,
            nonce: toBase64(ch.nonce),
            algorithm: "ed25519",
            expires_at: ch.expiresAt.toISOString(),
          }
        }),
      )
      .handle("token", ({ payload }) =>
        Effect.gen(function* () {
          const meta = yield* clientMeta
          const tok = yield* tokens
            .verifyAndIssue(payload.challenge_id, payload.signature, meta)
            .pipe(Effect.catchTag("ChallengeInvalid", () => Effect.fail(new Unauthorized({}))))
          return {
            access_token: tok.accessToken,
            token_type: "Bearer",
            expires_in: tok.expiresIn,
            expires_at: tok.expiresAt.toISOString(),
          }
        }),
      )
  }),
)
