import { SqlClient } from "@effect/sql"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** KEK version registry (metadata only). Powers the boot fingerprint guard + rotation. */
export class KekVersionRepo extends Effect.Service<KekVersionRepo>()("KekVersionRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database
    const sql = yield* SqlClient.SqlClient

    return {
      all: () => db.select().from(s.kekVersions),

      active: () =>
        db
          .select()
          .from(s.kekVersions)
          .where(eq(s.kekVersions.status, "active"))
          .pipe(Effect.map(head)),

      byVersion: (version: number) =>
        db
          .select()
          .from(s.kekVersions)
          .where(eq(s.kekVersions.version, version))
          .pipe(Effect.map(head)),

      seed: (version: number, fingerprint: string) =>
        db.insert(s.kekVersions).values({ version, fingerprint, status: "active" }),

      /** Atomically retire the current active version and install the new active one. */
      rotate: (newVersion: number, newFingerprint: string) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* db
              .update(s.kekVersions)
              .set({ status: "retired" })
              .where(eq(s.kekVersions.status, "active"))
            yield* db
              .insert(s.kekVersions)
              .values({ version: newVersion, fingerprint: newFingerprint, status: "active" })
          }),
        ),

      setStatus: (version: number, status: "active" | "retired") =>
        db
          .update(s.kekVersions)
          .set({ status })
          .where(and(eq(s.kekVersions.version, version))),
    }
  }),
}) {}
