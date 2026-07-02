import { Effect, Schedule } from "effect"
import { AppConfig } from "../config"
import { AccountRepo } from "../repo/account.repo"
import { AuthStateRepo } from "../repo/authstate.repo"

/**
 * Background sweeper (design 02/06): periodically delete expired challenges, access tokens,
 * and sessions. Fork as a daemon/scoped fiber in the serve program.
 */
export const sweepLoop = Effect.gen(function* () {
  const authState = yield* AuthStateRepo
  const accounts = yield* AccountRepo
  const cfg = yield* AppConfig

  const sweepOnce = Effect.gen(function* () {
    const now = new Date()
    yield* authState.deleteExpiredChallenges(now).pipe(Effect.ignore)
    yield* authState.deleteExpiredTokens(now).pipe(Effect.ignore)
    yield* accounts.deleteExpiredSessions(now).pipe(Effect.ignore)
  }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("sweep failed", cause)))

  yield* sweepOnce.pipe(Effect.repeat(Schedule.spaced(cfg.sweepInterval)))
})
