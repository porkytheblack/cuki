import { Effect } from "effect"
import { CryptoError } from "../errors"
import { concatBytes, u32be, utf8ToBytes, zeroize } from "../util/bytes"
import { aeadDecrypt, aeadEncrypt, type AeadAlg, DEFAULT_AEAD } from "./aead"
import { sealToRecipient, type SealedBytes } from "./hpke"
import { randomKey } from "./aead"
import { KekProvider } from "./kek"

/**
 * An encrypted-at-rest value: everything persisted in a sensitive `key_versions` row except
 * the AAD, which is reconstructed from the row's context at decrypt time (design 03).
 */
export interface EncryptedValue {
  readonly ciphertext: Uint8Array
  readonly nonce: Uint8Array
  readonly wrappedDek: Uint8Array
  readonly dekNonce: Uint8Array
  readonly kekVersion: number
  readonly aead: AeadAlg
}

/**
 * AAD binds a ciphertext to its context so a row can't be swapped to another key/env:
 *   aad = keyId ∥ environmentId ∥ version
 */
export const valueAad = (keyId: string, environmentId: string, version: number): Uint8Array =>
  concatBytes(utf8ToBytes(keyId), utf8ToBytes(environmentId), u32be(version))

/**
 * The crypto core as an Effect service (design 06). Envelope encryption at rest under the
 * KEK, plus HPKE seal-to-service on delivery. No DB or HTTP coupling.
 */
export class CryptoService extends Effect.Service<CryptoService>()("CryptoService", {
  effect: Effect.gen(function* () {
    const kek = yield* KekProvider

    return {
      /** Envelope-encrypt a plaintext value: fresh DEK, AEAD the value, wrap the DEK. */
      encrypt: (
        plaintext: Uint8Array,
        aad: Uint8Array,
        alg: AeadAlg = DEFAULT_AEAD,
      ): Effect.Effect<EncryptedValue, CryptoError> =>
        Effect.gen(function* () {
          const dek = randomKey()
          const value = yield* Effect.try({
            try: () => aeadEncrypt(alg, dek, plaintext, aad),
            catch: (e) => new CryptoError({ message: `encrypt failed: ${String(e)}` }),
          })
          const wrapped = yield* kek.wrapDek(dek, aad, alg)
          zeroize(dek)
          return {
            ciphertext: value.ciphertext,
            nonce: value.nonce,
            wrappedDek: wrapped.wrapped,
            dekNonce: wrapped.nonce,
            kekVersion: wrapped.kekVersion,
            aead: alg,
          }
        }),

      /** Reverse the envelope: unwrap the DEK, then AEAD-open the value. Fails closed. */
      decrypt: (v: EncryptedValue, aad: Uint8Array): Effect.Effect<Uint8Array, CryptoError> =>
        Effect.gen(function* () {
          const dek = yield* kek.unwrapDek(
            { wrapped: v.wrappedDek, nonce: v.dekNonce, kekVersion: v.kekVersion, aead: v.aead },
            aad,
          )
          const plaintext = yield* Effect.try({
            try: () => aeadDecrypt(v.aead, dek, v.nonce, v.ciphertext, aad),
            catch: () => new CryptoError({ message: "decrypt failed" }),
          })
          zeroize(dek)
          return plaintext
        }),

      /** Re-wrap an existing DEK old→new KEK for rotation (value ciphertext untouched). */
      rewrapDek: (v: EncryptedValue, aad: Uint8Array): Effect.Effect<WrappedRewrap, CryptoError> =>
        Effect.gen(function* () {
          const dek = yield* kek.unwrapDek(
            { wrapped: v.wrappedDek, nonce: v.dekNonce, kekVersion: v.kekVersion, aead: v.aead },
            aad,
          )
          const wrapped = yield* kek.wrapDek(dek, aad, v.aead)
          zeroize(dek)
          return {
            wrappedDek: wrapped.wrapped,
            dekNonce: wrapped.nonce,
            kekVersion: wrapped.kekVersion,
          }
        }),

      /** HPKE-seal a payload to a service's X25519 recipient key. */
      sealToService: (
        recipientX25519Pub: Uint8Array,
        info: Uint8Array,
        aad: Uint8Array,
        payload: Uint8Array,
      ): Effect.Effect<SealedBytes, CryptoError> =>
        Effect.tryPromise({
          try: () => sealToRecipient(recipientX25519Pub, info, aad, payload),
          catch: (e) => new CryptoError({ message: `seal failed: ${String(e)}` }),
        }),
    }
  }),
  dependencies: [],
}) {}

export interface WrappedRewrap {
  readonly wrappedDek: Uint8Array
  readonly dekNonce: Uint8Array
  readonly kekVersion: number
}
