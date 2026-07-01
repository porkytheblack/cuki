import { Duration, Effect, Option } from "effect"
import { AppConfig } from "../config"
import { random, sha256Hash } from "../crypto/keys"
import { hashPassword, verifyPassword } from "../crypto/password"
import { catchConflict } from "../db/errors"
import { Forbidden, Unauthorized, type Role } from "../errors"
import { AccountRepo } from "../repo/account.repo"
import { newId } from "../util/id"
import { fromBase64Url, toBase64Url } from "../util/bytes"
import { dieSqlApi } from "../util/effect"
import { CurrentUser, type CurrentUserData } from "./context"

/** RBAC ordering: viewer < member < admin < owner. */
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

const SESSION_TOKEN_BYTES = 32

/**
 * User auth for the management plane (design 04): password hashing, session create/validate,
 * and the `authorize(orgId, minRole)` RBAC guard used by every management handler.
 */
export class AuthService extends Effect.Service<AuthService>()("AuthService", {
  effect: Effect.gen(function* () {
    const accounts = yield* AccountRepo
    const cfg = yield* AppConfig

    const membershipsFor = (userId: string) =>
      accounts
        .listOrgsForUser(userId)
        .pipe(Effect.map((rows) => rows.map((r) => ({ orgId: r.org.id, role: r.role }))))

    return dieSqlApi({
      hashPassword: (pw: string) => Effect.sync(() => hashPassword(pw)),

      /** Create a user (Argon2id hash); `Conflict` if the email is taken. */
      register: (email: string, name: string, password: string) =>
        Effect.gen(function* () {
          const passwordHash = hashPassword(password)
          const created = yield* accounts
            .createUser({ id: newId(), email, name, passwordHash })
            .pipe(catchConflict("email already registered"))
          return Option.getOrThrow(created)
        }),

      /** Verify email+password; returns the user or `Unauthorized` (generic, no user probing). */
      verifyCredentials: (email: string, password: string) =>
        Effect.gen(function* () {
          const found = yield* accounts.findUserByEmail(email)
          if (Option.isNone(found) || found.value.passwordHash === null) {
            // Do a dummy verify to keep timing similar regardless of user existence.
            verifyPassword(password, "argon2id$19456$3$1$AAAA$AAAA")
            return yield* Effect.fail(new Unauthorized({ message: "invalid credentials" }))
          }
          const ok = verifyPassword(password, found.value.passwordHash)
          if (!ok) return yield* Effect.fail(new Unauthorized({ message: "invalid credentials" }))
          return found.value
        }),

      /** Create a session; returns the raw token (for the cookie) and its expiry. */
      createSession: (userId: string) =>
        Effect.gen(function* () {
          const raw = random(SESSION_TOKEN_BYTES)
          const token = toBase64Url(raw)
          const tokenHash = sha256Hash(raw)
          const expiresAt = new Date(Date.now() + Duration.toMillis(cfg.ttl.session))
          yield* accounts.createSession({ id: newId(), userId, tokenHash, expiresAt })
          return { token, expiresAt }
        }),

      /** Resolve a raw session token to the current user + memberships, or `Unauthorized`. */
      validateSession: (token: string): Effect.Effect<CurrentUserData, Unauthorized> =>
        Effect.gen(function* () {
          const tokenHash = sha256Hash(fromBase64Url(token))
          const found = yield* accounts.findSessionByHash(tokenHash).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          if (Option.isNone(found)) return yield* Effect.fail(new Unauthorized({}))
          const { session, user } = found.value
          if (session.expiresAt.getTime() <= Date.now()) {
            return yield* Effect.fail(new Unauthorized({ message: "session expired" }))
          }
          const memberships = yield* membershipsFor(user.id).pipe(
            Effect.catchAll(() => Effect.succeed([] as CurrentUserData["memberships"])),
          )
          return { user, memberships }
        }),

      logout: (token: string) =>
        accounts
          .deleteSessionByHash(sha256Hash(fromBase64Url(token)))
          .pipe(Effect.catchAll(() => Effect.void)),

      membershipsFor,

      /** RBAC guard: require at least `minRole` in `orgId` for the current user. */
      authorize: (orgId: string, minRole: Role): Effect.Effect<void, Forbidden, CurrentUser> =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser
          const m = cu.memberships.find((x) => x.orgId === orgId)
          if (!m || RANK[m.role] < RANK[minRole]) {
            return yield* Effect.fail(new Forbidden({ need: minRole }))
          }
        }),
    })
  }),
}) {}
