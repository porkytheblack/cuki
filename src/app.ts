import { SqlClient } from "@effect/sql"
import { Console, Effect, Layer, LogLevel, Option } from "effect"
import { AppConfig } from "./config"
import { bootstrapKek } from "./crypto/bootstrap"
import { valueAad } from "./crypto/crypto.service"
import { random } from "./crypto/keys"
import { runMigrations } from "./db/migrator"
import { CryptoService, DomainLive, KekProvider } from "./domain"
import { sweepLoop } from "./domain/sweeper"
import { HttpLive } from "./http/server"
import { KekVersionRepo, KeyRepo } from "./repo"
import { toBase64 } from "./util/bytes"

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

/** `cuki init` — generate a master key + print config scaffolding (design 08). */
export const initProgram = Effect.gen(function* () {
  const key = toBase64(random(32))
  yield* Console.log(
    [
      "# cuki configuration — keep the master key secret and backed up separately from the DB.",
      "# Losing the KEK means every sensitive value is irrecoverable.",
      "",
      `CUKI_MASTER_KEY=${key}`,
      "CUKI_DATABASE_URL=postgresql://user:pass@localhost:5432/cuki",
      "CUKI_ADDR=0.0.0.0:8787",
      "",
      "# Then:  cuki migrate  &&  cuki serve",
    ].join("\n"),
  )
})

/**
 * `cuki kek rotate` — re-wrap every DEK from the old KEK to the new one (design 03).
 * Requires CUKI_MASTER_KEY (new, active) and CUKI_MASTER_KEY_OLD (previous). Value
 * ciphertext is never touched; only DEK wraps + `kek_versions` change.
 */
export const kekRotateProgram = Effect.gen(function* () {
  const kek = yield* KekProvider
  const kekRepo = yield* KekVersionRepo
  const keyRepo = yield* KeyRepo
  const crypto = yield* CryptoService
  const sql = yield* SqlClient.SqlClient

  if (!kek.hasOld) {
    return yield* Effect.dieMessage(
      "rotation requires CUKI_MASTER_KEY_OLD (previous key) and CUKI_MASTER_KEY (new key)",
    )
  }
  const activeRow = yield* kekRepo.active()
  if (Option.isNone(activeRow)) {
    return yield* Effect.dieMessage("no active KEK version; run `cuki serve` once first")
  }
  const oldVersion = activeRow.value.version
  if (Option.isNone(kek.oldFingerprint) || kek.oldFingerprint.value !== activeRow.value.fingerprint) {
    return yield* Effect.dieMessage(
      `CUKI_MASTER_KEY_OLD does not match active KEK v${oldVersion} (fingerprint ${activeRow.value.fingerprint})`,
    )
  }
  const newVersion = oldVersion + 1
  yield* kek.configure({ activeVersion: newVersion, oldVersion: Option.some(oldVersion) })

  const rows = yield* keyRepo.sensitiveVersionsByKek(oldVersion)
  yield* Effect.logInfo(`re-wrapping ${rows.length} secret version(s): KEK v${oldVersion} → v${newVersion}`)
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const r of rows) {
        const aad = valueAad(r.keyId, r.environmentId, r.version)
        const rewrap = yield* crypto.rewrapDek(
          {
            ciphertext: r.ciphertext!,
            nonce: r.nonce!,
            wrappedDek: r.wrappedDek!,
            dekNonce: r.dekNonce!,
            kekVersion: r.kekVersion!,
            aead: r.aead!,
          },
          aad,
        )
        yield* keyRepo.updateWrap(r.versionId, rewrap.wrappedDek, rewrap.dekNonce, rewrap.kekVersion)
      }
      yield* kekRepo.rotate(newVersion, kek.activeFingerprint)
    }),
  )
  yield* Effect.logInfo(`KEK rotation complete: active version ${newVersion} (${kek.activeFingerprint})`)
})
