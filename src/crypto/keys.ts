import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto"
import { ed25519 } from "@noble/curves/ed25519.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { randomBytes } from "@noble/hashes/utils.js"
import { toHex } from "../util/bytes"

/**
 * Key + hash primitives (design 03/04). One Ed25519 keypair per service does two jobs:
 * signs challenge nonces (Ed25519 directly) and decrypts sealed responses (via its derived
 * X25519 form). The server only ever stores public keys.
 */

export interface ServiceKeypair {
  /** Ed25519 private key (32 bytes) — shown to the operator once, never persisted by cuki. */
  readonly privateKey: Uint8Array
  /** Ed25519 public verify key (32 bytes) — stored in `services.public_key`. */
  readonly publicKey: Uint8Array
  /** X25519 public key derived from the Ed25519 key — stored in `services.enc_public_key`. */
  readonly encPublicKey: Uint8Array
}

export const generateServiceKeypair = (): ServiceKeypair => {
  const privateKey = ed25519.utils.randomSecretKey()
  const publicKey = ed25519.getPublicKey(privateKey)
  const encPublicKey = ed25519.utils.toMontgomery(publicKey)
  return { privateKey, publicKey, encPublicKey }
}

export const ed25519PublicKey = (privateKey: Uint8Array): Uint8Array =>
  ed25519.getPublicKey(privateKey)

export const ed25519Sign = (privateKey: Uint8Array, message: Uint8Array): Uint8Array =>
  ed25519.sign(message, privateKey)

/** Verify a signature; returns false on any malformed input rather than throwing. */
export const ed25519Verify = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean => {
  try {
    return ed25519.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

/** Edwards→Montgomery public key (recipient key for HPKE seal). */
export const toX25519Public = (ed25519Pub: Uint8Array): Uint8Array =>
  ed25519.utils.toMontgomery(ed25519Pub)

/** Edwards→Montgomery private key (client-side, to open sealed responses). */
export const toX25519Private = (ed25519Priv: Uint8Array): Uint8Array =>
  ed25519.utils.toMontgomerySecret(ed25519Priv)

export const sha256Hash = (data: Uint8Array): Uint8Array => sha256(data)

/** `SHA-256(x)[:8]` as 16 hex chars — used for KEK fingerprints and misconfig detection. */
export const fingerprint8 = (data: Uint8Array): string => toHex(sha256(data).slice(0, 8))

/** Constant-time byte equality (token/nonce/hash comparison). Length is compared first. */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && nodeTimingSafeEqual(a, b)

/** N random bytes from the platform CSPRNG. */
export const random = (n: number): Uint8Array => randomBytes(n)
