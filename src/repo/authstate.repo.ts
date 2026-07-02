import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** Retrieval-plane auth state: single-use challenges and short-lived access tokens. */
export class AuthStateRepo extends Effect.Service<AuthStateRepo>()("AuthStateRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database

    return {
      // ── challenges ──
      createChallenge: (row: typeof s.challenges.$inferInsert) =>
        db.insert(s.challenges).values(row),

      findChallenge: (id: string) =>
        db.select().from(s.challenges).where(eq(s.challenges.id, id)).pipe(Effect.map(head)),

      /**
       * Atomically mark a challenge consumed iff it is unconsumed and unexpired. Returns the
       * row on success, `none` if it was already consumed/expired (defeats replay races).
       */
      consumeChallenge: (id: string, now: Date) =>
        db
          .update(s.challenges)
          .set({ consumedAt: now })
          .where(
            and(
              eq(s.challenges.id, id),
              isNull(s.challenges.consumedAt),
              gt(s.challenges.expiresAt, now),
            ),
          )
          .returning()
          .pipe(Effect.map(head)),

      deleteExpiredChallenges: (now: Date) =>
        db.delete(s.challenges).where(lt(s.challenges.expiresAt, now)),

      // ── access tokens ──
      createToken: (row: typeof s.accessTokens.$inferInsert) =>
        db.insert(s.accessTokens).values(row),

      /** Resolve a bearer token hash to the token row + its service, in one query. */
      findTokenByHash: (tokenHash: Uint8Array) =>
        db
          .select({ token: s.accessTokens, service: s.services })
          .from(s.accessTokens)
          .innerJoin(s.services, eq(s.accessTokens.serviceId, s.services.id))
          .where(eq(s.accessTokens.tokenHash, tokenHash))
          .pipe(Effect.map(head)),

      revokeToken: (id: string, now: Date) =>
        db.update(s.accessTokens).set({ revokedAt: now }).where(eq(s.accessTokens.id, id)),

      revokeAllForService: (serviceId: string, now: Date) =>
        db
          .update(s.accessTokens)
          .set({ revokedAt: now })
          .where(and(eq(s.accessTokens.serviceId, serviceId), isNull(s.accessTokens.revokedAt))),

      deleteExpiredTokens: (now: Date) =>
        db.delete(s.accessTokens).where(lt(s.accessTokens.expiresAt, now)),
    }
  }),
}) {}
