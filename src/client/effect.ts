import { Effect } from "effect"
import { Cuki } from "./sdk"
import { CukiError } from "./errors"

const wrap = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => (e instanceof CukiError ? e : new CukiError("Network", String(e))),
  })

/**
 * Effect-native client surface (design 09) for apps already on Effect.
 *
 *   const value = yield* CukiClient.getSecret("DATABASE_URL")
 */
export class CukiClient extends Effect.Service<CukiClient>()("CukiClient", {
  effect: Effect.gen(function* () {
    const cuki = yield* Effect.try({
      try: () => Cuki.fromEnv(),
      catch: (e) => (e instanceof CukiError ? e : new CukiError("Config", String(e))),
    })
    return {
      getSecret: (name: string) => wrap(() => cuki.getSecret(name)),
      getAll: () => wrap(() => cuki.getAll()),
      intoEnv: (options?: { only?: string[] }) => wrap(() => cuki.intoEnv(options)),
    }
  }),
}) {}
