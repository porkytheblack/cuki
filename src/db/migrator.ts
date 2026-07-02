import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { migrations } from "./migrations.gen"

/**
 * Applies embedded migrations idempotently (design 08). Tracks applied tags in
 * `_cuki_migrations`; each migration's statements run in a single transaction. Run by
 * `cuki migrate` and (by default) at the start of `cuki serve`.
 */
export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE IF NOT EXISTS _cuki_migrations (
    tag text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`

  const appliedRows = yield* sql<{ tag: string }>`SELECT tag FROM _cuki_migrations`
  const applied = new Set(appliedRows.map((r) => r.tag))

  let count = 0
  for (const m of migrations) {
    if (applied.has(m.tag)) continue
    yield* Effect.logInfo(`applying migration ${m.tag} (${m.statements.length} statements)`)
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const stmt of m.statements) {
            yield* sql.unsafe(stmt)
          }
          yield* sql`INSERT INTO _cuki_migrations ${sql.insert({ tag: m.tag })}`
        }),
      )
      .pipe(Effect.orDie)
    count++
  }

  yield* Effect.logInfo(
    count === 0
      ? `migrations up to date (${migrations.length} total)`
      : `applied ${count} migration(s); ${migrations.length} total`,
  )
})
