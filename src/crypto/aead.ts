import { gcm } from "@noble/ciphers/aes.js"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { randomBytes } from "@noble/hashes/utils.js"

/**
 * Pure AEAD primitives (design 03). These may throw on authentication failure (noble's
 * behaviour); callers in the crypto service wrap them in `Effect.try` → `CryptoError`.
 *
 * - XChaCha20-Poly1305 (default): 24-byte random nonce → safe to generate randomly, no
 *   counter state. AES-256-GCM is the FIPS-ish alternative; the choice is recorded per row
 *   in `key_versions.aead` for algorithm agility.
 */

export type AeadAlg = "xchacha20poly1305" | "aes256gcm"

export const DEFAULT_AEAD: AeadAlg = "xchacha20poly1305"

export const KEY_LENGTH = 32

export const NONCE_LENGTHS: Record<AeadAlg, number> = {
  xchacha20poly1305: 24,
  aes256gcm: 12,
}

const cipherFor = (alg: AeadAlg, key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) =>
  alg === "xchacha20poly1305"
    ? xchacha20poly1305(key, nonce, aad)
    : gcm(key, nonce, aad)

export interface AeadOutput {
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
}

/** Encrypt with a fresh random nonce; ciphertext includes the Poly1305/GCM tag. */
export const aeadEncrypt = (
  alg: AeadAlg,
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): AeadOutput => {
  const nonce = randomBytes(NONCE_LENGTHS[alg])
  const ciphertext = cipherFor(alg, key, nonce, aad).encrypt(plaintext)
  return { nonce, ciphertext }
}

/** Decrypt; throws if the tag or AAD does not verify (fails closed). */
export const aeadDecrypt = (
  alg: AeadAlg,
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array => cipherFor(alg, key, nonce, aad).decrypt(ciphertext)

/** A fresh 32-byte symmetric key (DEK). */
export const randomKey = (): Uint8Array => randomBytes(KEY_LENGTH)
