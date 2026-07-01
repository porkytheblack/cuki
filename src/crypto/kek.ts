import { readFileSync } from "node:fs"
import { argon2id } from "@noble/hashes/argon2.js"
import { Effect, Option, Redacted, Ref } from "effect"
import { AppConfig } from "../config"
import { CryptoError } from "../errors"
import { fromBase64, utf8ToBytes, zeroize } from "../util/bytes"
import { aeadDecrypt, aeadEncrypt, type AeadAlg, DEFAULT_AEAD } from "./aead"
import { fingerprint8 } from "./keys"

/**
 * The KEK (Key Encryption Key) — the instance master key (design 03). It lives outside the
 * datastore and is loaded once at boot into this provider. It only ever wraps/unwraps DEKs;
 * the rest of the crypto core never sees the raw KEK. KMS providers would swap the
 * wrap/unwrap implementation while keeping the same envelope shape.
 *
 * Version reconciliation with `kek_versions` happens at boot via `configure` (the boot
 * sequence has DB access; this provider deliberately does not — it sits below the SQL layer).
 */

export interface WrappedDek {
  readonly wrapped: Uint8Array
  readonly nonce: Uint8Array
  readonly kekVersion: number
  readonly aead: AeadAlg
}

const KEY_BYTES = 32

const decodeKey = (b64: string, label: string): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => {
      const k = fromBase64(b64.trim())
      if (k.length !== KEY_BYTES) {
        throw new Error(`${label} must decode to ${KEY_BYTES} bytes, got ${k.length}`)
      }
      return k
    },
    catch: (e) => new CryptoError({ message: `KEK load failed: ${String(e)}` }),
  })

const deriveFromPassphrase = (
  passphrase: string,
  saltB64: Option.Option<string>,
): Effect.Effect<Uint8Array, CryptoError> =>
  Effect.try({
    try: () => {
      const salt = Option.match(saltB64, {
        onNone: () => {
          throw new Error("CUKI_MASTER_SALT (base64) is required for passphrase-derived KEK")
        },
        onSome: (s) => fromBase64(s),
      })
      // Argon2id, tuned per design 03/04 (memory ≥ 19 MiB).
      return argon2id(utf8ToBytes(passphrase), salt, { t: 3, m: 65536, p: 1, dkLen: KEY_BYTES })
    },
    catch: (e) => new CryptoError({ message: `passphrase KEK derivation failed: ${String(e)}` }),
  })

type KekConfig = AppConfig["kek"]

/** Resolve the active KEK bytes from config, honouring precedence: raw > file > passphrase. */
const loadActiveKey = (kek: KekConfig): Effect.Effect<Uint8Array, CryptoError> => {
  if (kek.provider !== "local") {
    return Effect.fail(
      new CryptoError({ message: `KEK provider "${kek.provider}" is not implemented yet` }),
    )
  }
  if (Option.isSome(kek.masterKey)) {
    return decodeKey(Redacted.value(kek.masterKey.value), "CUKI_MASTER_KEY")
  }
  if (Option.isSome(kek.masterKeyFile)) {
    const path = kek.masterKeyFile.value
    return Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (e) => new CryptoError({ message: `cannot read CUKI_MASTER_KEY_FILE: ${String(e)}` }),
    }).pipe(Effect.flatMap((raw) => decodeKey(raw, "CUKI_MASTER_KEY_FILE")))
  }
  if (Option.isSome(kek.masterPassphrase)) {
    return deriveFromPassphrase(Redacted.value(kek.masterPassphrase.value), kek.masterSalt)
  }
  return Effect.fail(
    new CryptoError({
      message: "no master key configured (set CUKI_MASTER_KEY, _FILE, or _PASSPHRASE)",
    }),
  )
}

/** The previous KEK, if provided (rotation only). */
const loadOldKey = (kek: KekConfig): Effect.Effect<Option.Option<Uint8Array>, CryptoError> =>
  Option.match(kek.masterKeyOld, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (r) => decodeKey(Redacted.value(r), "CUKI_MASTER_KEY_OLD").pipe(Effect.map(Option.some)),
  })

export interface KekConfigureInput {
  readonly activeVersion: number
  readonly oldVersion: Option.Option<number>
}

interface KekState {
  readonly keys: Map<number, Uint8Array>
  readonly active: number
}

export class KekProvider extends Effect.Service<KekProvider>()("KekProvider", {
  effect: Effect.gen(function* () {
    const cfg = yield* AppConfig
    const active = yield* loadActiveKey(cfg.kek)
    const oldOpt = yield* loadOldKey(cfg.kek)

    const activeFingerprint = fingerprint8(active)
    const oldFingerprint = Option.map(oldOpt, fingerprint8)

    // Filled in by the boot sequence once it has reconciled versions against `kek_versions`.
    const state = yield* Ref.make<KekState>({ keys: new Map(), active: 0 })

    const keyForVersion = (version: number): Effect.Effect<Uint8Array, CryptoError> =>
      Ref.get(state).pipe(
        Effect.flatMap((s) => {
          const k = s.keys.get(version)
          return k
            ? Effect.succeed(k)
            : Effect.fail(new CryptoError({ message: `no KEK loaded for version ${version}` }))
        }),
      )

    return {
      activeFingerprint,
      oldFingerprint,
      hasOld: Option.isSome(oldOpt),

      activeVersion: Ref.get(state).pipe(Effect.map((s) => s.active)),

      /** Register version→key mappings and set the active version (boot-time). */
      configure: ({ activeVersion, oldVersion }: KekConfigureInput) =>
        Ref.set(state, {
          keys: new Map<number, Uint8Array>([
            [activeVersion, active],
            ...(Option.isSome(oldVersion) && Option.isSome(oldOpt)
              ? [[oldVersion.value, oldOpt.value] as [number, Uint8Array]]
              : []),
          ]),
          active: activeVersion,
        }),

      wrapDek: (
        dek: Uint8Array,
        aad: Uint8Array,
        alg: AeadAlg = DEFAULT_AEAD,
      ): Effect.Effect<WrappedDek, CryptoError> =>
        Effect.gen(function* () {
          const s = yield* Ref.get(state)
          if (s.active === 0) {
            return yield* Effect.fail(new CryptoError({ message: "KEK not initialised" }))
          }
          const key = yield* keyForVersion(s.active)
          const out = yield* Effect.try({
            try: () => aeadEncrypt(alg, key, dek, aad),
            catch: (e) => new CryptoError({ message: `wrap failed: ${String(e)}` }),
          })
          return { wrapped: out.ciphertext, nonce: out.nonce, kekVersion: s.active, aead: alg }
        }),

      unwrapDek: (w: WrappedDek, aad: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
        keyForVersion(w.kekVersion).pipe(
          Effect.flatMap((key) =>
            Effect.try({
              try: () => aeadDecrypt(w.aead, key, w.nonce, w.wrapped, aad),
              // Never leak detail — wrong KEK / tampered wrap both look the same.
              catch: () => new CryptoError({ message: "unwrap failed" }),
            }),
          ),
        ),
    }
  }),
}) {}

/** Convenience: configure the provider as a fresh instance (active version 1, no old KEK). */
export const configureFresh: Effect.Effect<void, never, KekProvider> = Effect.gen(function* () {
  const kek = yield* KekProvider
  yield* kek.configure({ activeVersion: 1, oldVersion: Option.none() })
})

export { zeroize }
