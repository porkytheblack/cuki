import type { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import { dieOnSql } from "../db/errors"

type WrapErr<T> = T extends (...args: infer A) => Effect.Effect<infer R, infer E, infer Req>
  ? (...args: A) => Effect.Effect<R, Exclude<E, SqlError>, Req>
  : T

export type Wrapped<O> = { [K in keyof O]: WrapErr<O[K]> }

/**
 * Wrap every Effect-returning method of a service object so a `SqlError` becomes a defect
 * (→ 500), keeping the service's public error channel to meaningful domain errors. Non-Effect
 * members pass through unchanged. Applied once at each service's `return`.
 */
export const dieSqlApi = <O extends Record<string, unknown>>(api: O): Wrapped<O> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(api)) {
    const value = api[key]
    out[key] =
      typeof value === "function"
        ? (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown)(...args)
            return Effect.isEffect(result) ? dieOnSql(result as Effect.Effect<unknown, unknown>) : result
          }
        : value
  }
  return out as Wrapped<O>
}
