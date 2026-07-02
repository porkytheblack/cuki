import { PgClient } from "@effect/sql-pg"
import * as Drizzle from "@effect/sql-drizzle/Pg"
import { Effect, Layer } from "effect"
import { AppConfig } from "../config"

/**
 * Datastore layers (design 06): Postgres via `@effect/sql-pg`, wrapped by
 * `@effect/sql-drizzle` so Drizzle queries run inside the Effect `SqlClient` (transactions,
 * tracing, error channel) rather than raw promises. Repos are the only place that touch SQL.
 */

/** The raw `SqlClient` (Postgres), configured from `AppConfig`. */
export const SqlLive = Layer.unwrapEffect(
  AppConfig.pipe(
    Effect.map((cfg) =>
      PgClient.layer({
        url: cfg.db.url,
        maxConnections: cfg.db.poolSize,
      }),
    ),
  ),
)

/** The Drizzle client (`PgDrizzle`) over the `SqlClient`, plus the `SqlClient` itself. */
export const DatabaseLive = Drizzle.layer.pipe(Layer.provideMerge(SqlLive))

/** Re-export the Drizzle service tag for repositories. */
export const Database = Drizzle.PgDrizzle
export type Database = Drizzle.PgDrizzle
