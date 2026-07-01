import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { AuthService } from "../../domain/auth.service"
import { ManagementService } from "../../domain/management.service"
import { TokenService } from "../../domain/token.service"
import { CurrentUser } from "../../domain/context"
import { Unauthorized } from "../../errors"
import { toBase64 } from "../../util/bytes"
import { api, sessionCookie } from "../api"
import { clientMeta } from "../req"

const cookieOptions = {
  httpOnly: true,
  // NOTE: over plain HTTP (dev) the browser drops Secure cookies; a TLS deployment should
  // set this true (e.g. via a reverse proxy terminating TLS or CUKI_TLS_*).
  secure: false,
  sameSite: "lax" as const,
  path: "/",
}

/** Auth group: user register/login/logout/me + service challenge/token (design 05). */
export const AuthGroupLive = HttpApiBuilder.group(api, "auth", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const mgmt = yield* ManagementService
    const tokens = yield* TokenService

    const setSession = (userId: string) =>
      Effect.gen(function* () {
        const { token } = yield* auth.createSession(userId)
        yield* HttpApiBuilder.securitySetCookie(sessionCookie, token, cookieOptions)
      })

    const me = (userId: string, user: { id: string; email: string; name: string; createdAt: Date }) =>
      auth.membershipsFor(userId).pipe(Effect.map((memberships) => ({ user, memberships })))

    return handlers
      .handle("register", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* auth.register(payload.email, payload.name, payload.password)
          yield* mgmt.createOrg(user.id, `${payload.name}'s Org`)
          yield* setSession(user.id)
          return yield* me(user.id, user)
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* auth.verifyCredentials(payload.email, payload.password)
          yield* setSession(user.id)
          return yield* me(user.id, user)
        }),
      )
      .handle("logout", () =>
        Effect.gen(function* () {
          yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", { ...cookieOptions, maxAge: 0 })
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
          const ch = yield* tokens
            .issueChallenge(payload.service_id, meta.ip)
            .pipe(Effect.mapError(() => new Unauthorized({})))
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
            .verifyAndIssue(payload.challenge_id, payload.signature, meta.ip)
            .pipe(Effect.mapError(() => new Unauthorized({})))
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
