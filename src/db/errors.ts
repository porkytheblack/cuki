import type { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import { Conflict } from "../errors"

/** Postgres `unique_violation`. postgres.js surfaces the pg code on the error `cause`. */
export const isUniqueViolation = (e: unknown): boolean => {
  const cause = (e as { cause?: { code?: string } })?.cause
  const code = cause?.code ?? (e as { code?: string })?.code
  return code === "23505"
}

/**
 * Translate a unique-constraint violation into a domain `Conflict`; other errors pass through
 * unchanged. Apply before `dieOnSql` so genuine conflicts survive and other SQL errors die.
 */
export const catchConflict =
  (reason: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | Conflict, R> =>
    Effect.catchIf(self, isUniqueViolation, () => Effect.fail(new Conflict({ reason })))

/**
 * DB errors are infra failures — turn any `SqlError` into a defect (→ 500 at the HTTP edge)
 * so domain services keep clean, meaningful typed error channels.
 */
export const dieOnSql = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError>, R> =>
  Effect.catchIf(
    self,
    (e): e is E & SqlError => (e as { _tag?: string })?._tag === "SqlError",
    (e) => Effect.die(e),
  ) as Effect.Effect<A, Exclude<E, SqlError>, R>
