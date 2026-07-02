import { Option } from "effect"

/** First row as an Option (with `noUncheckedIndexedAccess` safety). */
export const head = <A>(rows: ReadonlyArray<A>): Option.Option<A> =>
  rows.length > 0 ? Option.some(rows[0] as A) : Option.none()
