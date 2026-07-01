import { CipherSuite } from "@hpke/core"
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305"
import { DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/dhkem-x25519"

/**
 * HPKE base-mode delivery encryption (design 03): DHKEM(X25519, HKDF-SHA256) +
 * HKDF-SHA256 + ChaCha20-Poly1305. The X25519 KEM is the noble-backed implementation so it
 * works without runtime WebCrypto X25519 support (keeps the pure-JS single-binary story).
 *
 * Every retrieval response is sealed to the requesting service's X25519 key; only that
 * service's private key can open it, independent of TLS.
 */

export const SUITE_DESCRIPTOR = {
  kem: "x25519-hkdf-sha256",
  kdf: "hkdf-sha256",
  aead: "chacha20poly1305",
} as const

export type SuiteDescriptor = typeof SUITE_DESCRIPTOR

const makeSuite = () =>
  new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  })

export interface SealedBytes {
  readonly enc: Uint8Array
  readonly ciphertext: Uint8Array
}

const copy = (b: Uint8Array): Uint8Array => b.slice()

/** A standalone ArrayBuffer copy — `importKey("raw", ...)` requires an ArrayBuffer. */
const toArrayBuffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer

/** Seal a payload to a recipient's X25519 public key. Returns encapsulated key + ciphertext. */
export const sealToRecipient = async (
  recipientX25519Pub: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  payload: Uint8Array,
): Promise<SealedBytes> => {
  const suite = makeSuite()
  const rpk = await suite.kem.importKey("raw", toArrayBuffer(recipientX25519Pub), true)
  const sender = await suite.createSenderContext({ recipientPublicKey: rpk, info })
  const ciphertext = await sender.seal(payload, aad)
  return { enc: new Uint8Array(sender.enc), ciphertext: new Uint8Array(ciphertext) }
}

/** Open a sealed payload with a recipient's X25519 private key (client-side / tests). */
export const openFromRecipient = async (
  enc: Uint8Array,
  recipientX25519Priv: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> => {
  const suite = makeSuite()
  const rsk = await suite.kem.importKey("raw", toArrayBuffer(recipientX25519Priv), false)
  const recipient = await suite.createRecipientContext({ recipientKey: rsk, enc: copy(enc), info })
  const opened = await recipient.open(copy(ciphertext), aad)
  return new Uint8Array(opened)
}
