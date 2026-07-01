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
 * Translate a unique-constraint violation into a domain `Conflict`; other SQL errors pass
 * through unchanged (mapped to 500 at the HTTP edge).
 */
export const catchConflict =
  (reason: string) =>
  <A, R>(self: Effect.Effect<A, SqlError, R>): Effect.Effect<A, SqlError | Conflict, R> =>
    Effect.catchIf(self, isUniqueViolation, () => Effect.fail(new Conflict({ reason })))
