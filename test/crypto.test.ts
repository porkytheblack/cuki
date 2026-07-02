import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { AppConfig } from "../src/config"
import { CryptoService, valueAad } from "../src/crypto/crypto.service"
import { buildAuthMessage, buildSecretsInfo } from "../src/crypto/constants"
import { openFromRecipient } from "../src/crypto/hpke"
import { configureFresh, KekProvider } from "../src/crypto/kek"
import {
  ed25519Sign,
  ed25519Verify,
  fingerprint8,
  generateServiceKeypair,
  toX25519Private,
} from "../src/crypto/keys"
import { fromBase64, toBase64, bytesToUtf8, utf8ToBytes } from "../src/util/bytes"

const KEY_A = toBase64(new Uint8Array(32).fill(7))
const KEY_B = toBase64(new Uint8Array(32).fill(9))

/** A self-contained layer exposing both CryptoService and KekProvider for one KEK. */
const layerFor = (activeKey: string, oldKey?: string) => {
  const map = new Map<string, string>([
    ["CUKI_DATABASE_URL", "postgres://ignored"],
    ["CUKI_MASTER_KEY", activeKey],
  ])
  if (oldKey) map.set("CUKI_MASTER_KEY_OLD", oldKey)
  return CryptoService.Default.pipe(
    Layer.provideMerge(KekProvider.Default),
    Layer.provide(AppConfig.Default),
    Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(map))),
  )
}

const provideFresh = <A, E>(
  eff: Effect.Effect<A, E, CryptoService | KekProvider>,
  key = KEY_A,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    yield* configureFresh
    return yield* eff
  }).pipe(Effect.provide(layerFor(key)))

describe("envelope encryption (at rest)", () => {
  it.effect("round-trips empty, unicode, and 1 MiB inputs", () =>
    provideFresh(
      Effect.gen(function* () {
        const crypto = yield* CryptoService
        const aad = valueAad("key_1", "env_1", 1)
        const inputs = [
          new Uint8Array(0),
          utf8ToBytes("héllo · 秘密 · 🔐"),
          new Uint8Array(1024 * 1024).fill(0xab),
        ]
        for (const pt of inputs) {
          const enc = yield* crypto.encrypt(pt, aad)
          const out = yield* crypto.decrypt(enc, aad)
          expect(bytesToUtf8(out)).toEqual(bytesToUtf8(pt))
          expect(out.length).toEqual(pt.length)
        }
      }),
    ),
  )

  it.effect("fails closed when the AAD (keyId) is tampered", () =>
    provideFresh(
      Effect.gen(function* () {
        const crypto = yield* CryptoService
        const enc = yield* crypto.encrypt(utf8ToBytes("secret"), valueAad("key_1", "env_1", 1))
        const wrongAad = valueAad("key_2", "env_1", 1)
        const res = yield* Effect.either(crypto.decrypt(enc, wrongAad))
        expect(res._tag).toEqual("Left")
      }),
    ),
  )

  it.effect("wrong KEK fails to decrypt (no garbage plaintext)", () =>
    Effect.gen(function* () {
      const aad = valueAad("key_1", "env_1", 1)
      // Encrypt under KEK A.
      const enc = yield* Effect.gen(function* () {
        yield* configureFresh
        return yield* (yield* CryptoService).encrypt(utf8ToBytes("top secret"), aad)
      }).pipe(Effect.provide(layerFor(KEY_A)))
      // Attempt decrypt under KEK B.
      const res = yield* Effect.gen(function* () {
        yield* configureFresh
        return yield* Effect.either((yield* CryptoService).decrypt(enc, aad))
      }).pipe(Effect.provide(layerFor(KEY_B)))
      expect(res._tag).toEqual("Left")
    }),
  )

  it.effect("KEK rotation re-wraps DEK; value ciphertext unchanged; still decrypts", () =>
    Effect.gen(function* () {
      const aad = valueAad("key_1", "env_1", 1)
      // Encrypt under KEK A at version 1.
      const enc = yield* Effect.gen(function* () {
        yield* configureFresh
        return yield* (yield* CryptoService).encrypt(utf8ToBytes("rotate me"), aad)
      }).pipe(Effect.provide(layerFor(KEY_A)))
      expect(enc.kekVersion).toEqual(1)

      // Rotate: new active KEK B (v2), old KEK A (v1) available for unwrap.
      const rewrapped = yield* Effect.gen(function* () {
        const kek = yield* KekProvider
        yield* kek.configure({ activeVersion: 2, oldVersion: Option.some(1) })
        return yield* (yield* CryptoService).rewrapDek(enc, aad)
      }).pipe(Effect.provide(layerFor(KEY_B, KEY_A)))
      expect(rewrapped.kekVersion).toEqual(2)

      // Value ciphertext bytes are untouched by rotation.
      const rotated = { ...enc, ...rewrapped }
      expect(toBase64(rotated.ciphertext)).toEqual(toBase64(enc.ciphertext))

      // Decrypts under the new KEK alone (only v2 present).
      const out = yield* Effect.gen(function* () {
        const kek = yield* KekProvider
        yield* kek.configure({ activeVersion: 2, oldVersion: Option.none() })
        return yield* (yield* CryptoService).decrypt(rotated, aad)
      }).pipe(Effect.provide(layerFor(KEY_B)))
      expect(bytesToUtf8(out)).toEqual("rotate me")
    }),
  )
})

describe("service keys + auth", () => {
  it("ed25519 sign/verify over the domain-separated auth message", () => {
    const kp = generateServiceKeypair()
    const nonce = new Uint8Array(32).fill(1)
    const msg = buildAuthMessage("svc_abc", nonce)
    const sig = ed25519Sign(kp.privateKey, msg)
    expect(ed25519Verify(sig, msg, kp.publicKey)).toBe(true)
    // Wrong service_id → different message → verify fails.
    expect(ed25519Verify(sig, buildAuthMessage("svc_xyz", nonce), kp.publicKey)).toBe(false)
    // Tampered signature fails.
    const bad = sig.slice()
    bad[0] = (bad[0] ?? 0) ^ 0xff
    expect(ed25519Verify(bad, msg, kp.publicKey)).toBe(false)
  })

  it("fingerprint is stable and 16 hex chars", () => {
    const fp = fingerprint8(fromBase64(KEY_A))
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint8(fromBase64(KEY_A))).toEqual(fp)
    expect(fingerprint8(fromBase64(KEY_B))).not.toEqual(fp)
  })
})

describe("HPKE delivery encryption (seal-to-service)", () => {
  it.effect("seals to a service and only its private key opens it", () =>
    provideFresh(
      Effect.gen(function* () {
        const crypto = yield* CryptoService
        const svc = generateServiceKeypair()
        const info = buildSecretsInfo("svc_abc")
        const aad = utf8ToBytes("tok_1|env_1")
        const payload = utf8ToBytes(JSON.stringify({ keys: [{ name: "DATABASE_URL", value: "pg://x" }] }))

        const sealed = yield* crypto.sealToService(svc.encPublicKey, info, aad, payload)

        // Correct private key opens it.
        const skR = toX25519Private(svc.privateKey)
        const opened = yield* Effect.promise(() =>
          openFromRecipient(sealed.enc, skR, info, aad, sealed.ciphertext),
        )
        const parsed = JSON.parse(bytesToUtf8(opened)) as { keys: Array<{ name: string }> }
        expect(parsed.keys[0]?.name).toEqual("DATABASE_URL")

        // A different service's key cannot open it.
        const other = toX25519Private(generateServiceKeypair().privateKey)
        const res = yield* Effect.either(
          Effect.tryPromise(() => openFromRecipient(sealed.enc, other, info, aad, sealed.ciphertext)),
        )
        expect(res._tag).toEqual("Left")
      }),
    ),
  )
})
