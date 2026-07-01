import { Effect, Option } from "effect"
import { CryptoError } from "../errors"
import { KekVersionRepo } from "../repo/kek.repo"
import { KekProvider } from "./kek"

/**
 * Boot-time KEK reconciliation (design 03/08). Runs after migrations, before serving:
 *
 * - First boot: seed `kek_versions` v1 with the loaded KEK's fingerprint.
 * - Normal boot: verify the loaded KEK matches the active version's fingerprint — abort loud
 *   on mismatch (booting with the wrong key would silently fail per-row and look like data
 *   corruption). Map any loaded old KEK to its retired version for rotation unwrapping.
 */
export const bootstrapKek = Effect.gen(function* () {
  const kek = yield* KekProvider
  const repo = yield* KekVersionRepo

  const activeRow = yield* repo.active()

  if (Option.isNone(activeRow)) {
    yield* repo.seed(1, kek.activeFingerprint)
    yield* kek.configure({ activeVersion: 1, oldVersion: Option.none() })
    yield* Effect.logInfo(`KEK initialised at version 1 (fingerprint ${kek.activeFingerprint})`)
    return kek.activeFingerprint
  }

  const row = activeRow.value
  if (row.fingerprint !== kek.activeFingerprint) {
    return yield* Effect.fail(
      new CryptoError({
        message:
          `KEK fingerprint mismatch: active version ${row.version} expects ${row.fingerprint}, ` +
          `loaded key fingerprints as ${kek.activeFingerprint}. Refusing to start.`,
      }),
    )
  }

  // Map a loaded old KEK (rotation) to its retired version, if it matches a known one.
  let oldVersion = Option.none<number>()
  if (kek.hasOld && Option.isSome(kek.oldFingerprint)) {
    const oldFp = kek.oldFingerprint.value
    const all = yield* repo.all()
    const match = all.find((r) => r.fingerprint === oldFp)
    if (match) oldVersion = Option.some(match.version)
  }

  yield* kek.configure({ activeVersion: row.version, oldVersion })
  yield* Effect.logInfo(`KEK verified at version ${row.version} (fingerprint ${row.fingerprint})`)
  return row.fingerprint
})
