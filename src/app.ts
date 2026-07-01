import { Effect, Layer, LogLevel } from "effect"
import { AppConfig } from "./config"
import { bootstrapKek } from "./crypto/bootstrap"
import { runMigrations } from "./db/migrator"
import { DomainLive } from "./domain"
import { sweepLoop } from "./domain/sweeper"
import { HttpLive } from "./http/server"

/** The application context: domain services, crypto, repos, datastore, and config. */
export const AppLayer = DomainLive.pipe(Layer.provideMerge(AppConfig.Default))

export const logLevelFor = (s: string): LogLevel.LogLevel => {
  switch (s.toLowerCase()) {
    case "trace":
      return LogLevel.Trace
    case "debug":
      return LogLevel.Debug
    case "warn":
    case "warning":
      return LogLevel.Warning
    case "error":
      return LogLevel.Error
    case "none":
    case "off":
      return LogLevel.None
    default:
      return LogLevel.Info
  }
}

/**
 * `cuki serve` (design 08): migrate (unless disabled) → load + verify KEK → start the
 * background sweeper → bind the HTTP server. Never returns until shutdown.
 */
export const serveProgram = (opts: { readonly migrate: boolean }) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfig
    if (opts.migrate) yield* runMigrations
    const fingerprint = yield* bootstrapKek
    yield* Effect.forkDaemon(sweepLoop)
    const d = cfg.describe()
    yield* Effect.logInfo(
      `cuki ready — addr=${d.addr} db=${d.dbUrl} kek=${d.kekProvider} fingerprint=${fingerprint} ` +
        `tokenTtl=${d.tokenTtl} challengeTtl=${d.challengeTtl}`,
    )
    yield* Layer.launch(HttpLive)
  })

/** `cuki migrate` — apply migrations and exit. */
export const migrateProgram = runMigrations.pipe(Effect.andThen(Effect.logInfo("migrations complete")))
