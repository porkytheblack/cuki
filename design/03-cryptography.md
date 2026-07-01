# 03 — Cryptography

This is the security core. Implement it first (phase P1), test it with known-answer
vectors, and keep it free of DB/HTTP coupling — it's pure functions plus a KEK provider.

## Primitives

- **AEAD (value & DEK encryption):** XChaCha20-Poly1305 (default) via `@noble/ciphers`.
  24-byte random nonce → collision-safe to generate randomly, no counter state needed.
  AES-256-GCM is supported as an alternative for environments that mandate FIPS-ish
  AES; record the choice per row in `key_versions.aead` for algorithm agility.
- **Signatures (service auth):** Ed25519 via `@noble/curves`. See [`04`](./04-auth.md).
- **Delivery encryption (encrypt-to-client):** HPKE base mode (RFC 9180) —
  DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305. The service's X25519
  recipient key is *derived from its Ed25519 key*, so a service still holds exactly one
  private key. See "End-to-end delivery encryption" below.
- **Hashing:** SHA-256 via `@noble/hashes` (token hashes, fingerprints).
- **Password hashing (users):** Argon2id.
- **Randomness:** the platform CSPRNG (`crypto.getRandomValues`). Never `Math.random`.

All chosen for pure-JS implementations so the single binary needs no native modules.

## Envelope encryption

Never encrypt secret values directly under the KEK. Use per-value DEKs wrapped by the KEK.

```
DEK      = random(32)                       # fresh per key_version
ct, n1   = AEAD_encrypt(DEK, plaintext, aad)
wDEK, n2 = AEAD_encrypt(KEK[version], DEK, aad)
store    { ciphertext: ct, nonce: n1,
           wrappedDek: wDEK, dekNonce: n2,
           kekVersion: version, aead: "xchacha20poly1305" }
zeroize(DEK, plaintext)                      # best-effort; see note
```

Decrypt reverses it:

```
DEK       = AEAD_decrypt(KEK[kekVersion], wrappedDek, dekNonce, aad)
plaintext = AEAD_decrypt(DEK, ciphertext, nonce, aad)
```

### Why envelope, not direct

- **KEK rotation is cheap:** re-wrap DEKs (small, fast) instead of re-encrypting every
  secret value. See rotation below.
- **Crypto isolation:** each value has an independent DEK; compromise of one DEK doesn't
  cascade.
- **KMS-friendly:** if the KEK moves to AWS/GCP KMS or Vault Transit, you make one small
  `wrap`/`unwrap` call per DEK, not a KMS call per byte of secret.

### Associated data (AAD)

Bind ciphertext to its context so a ciphertext can't be moved to another key/env. Set
`aad = keyId ∥ environmentId ∥ version`. If someone swaps ciphertext rows in the DB,
decryption fails. Store nothing extra — AAD is reconstructed from the row at decrypt time.

## The KEK

A single 32-byte instance master key. It lives **outside** the datastore and is loaded
once at boot into a redacted config value.

### Sourcing (pluggable `KekProvider`)

Precedence and options:

1. **Raw key from env:** `CUKI_MASTER_KEY` = base64(32 bytes). Load via
   `Config.redacted` so it can never be logged or serialized.
2. **Key file:** `CUKI_MASTER_KEY_FILE` = path to a file containing the base64 key
   (for Docker/systemd secret mounts).
3. **Passphrase:** `CUKI_MASTER_PASSPHRASE` → derive the KEK with Argon2id and a fixed,
   stored salt (in `settings`). Lower assurance; document the tradeoff.
4. **External KMS:** `aws-kms` | `gcp-kms` | `vault-transit`. cuki holds no KEK; it calls
   the KMS to wrap/unwrap DEKs. Same envelope shape, `KekProvider` swaps the wrap/unwrap
   implementation. Optional, off by default.

The `KekProvider` interface (Effect service) exposes just:

```ts
interface KekProvider {
  readonly wrapDek:   (dek: Uint8Array, aad: Uint8Array) => Effect<WrappedDek, CryptoError>
  readonly unwrapDek: (w: WrappedDek, aad: Uint8Array)   => Effect<Uint8Array, CryptoError>
  readonly activeVersion: number
}
```

Local providers implement wrap/unwrap with AEAD under the in-memory KEK; KMS providers
delegate. The rest of the crypto core never sees the raw KEK for KMS mode.

### Boot-time safety check

On startup, compute `SHA-256(KEK)[:8]` and compare against `kek_versions.fingerprint`
for the active version. If it mismatches (someone booted with the wrong key), **refuse to
start** — decrypting with the wrong KEK would silently fail per-row and looks like
corruption. Fail loud instead. On first boot, seed `kek_versions` with the current
fingerprint.

## KEK rotation

Goal: replace the master key without re-encrypting secret values.

1. Operator provides `CUKI_MASTER_KEY` (new) and `CUKI_MASTER_KEY_OLD` (current), runs
   `cuki kek rotate`.
2. Insert a new `kek_versions` row (`version = max+1`, `status=active`), mark the old
   `retired`.
3. For each `key_versions` row where `kekVersion = old`: `unwrap` the DEK with the old
   KEK, `wrap` it with the new KEK, update `wrappedDek/dekNonce/kekVersion` in a
   transaction. The value ciphertext is untouched.
4. Both KEKs must be available during rotation; retire the old one afterward.

Because only DEKs are re-wrapped, rotation over a large vault is fast and never exposes
plaintext values.

## Secret value rotation (different thing)

Changing a *value* creates a new `key_versions` row with a fresh DEK and bumps
`keys.currentVersion`. Old versions stay for rollback and audit. Never mutate an existing
version's ciphertext in place.

## End-to-end delivery encryption (encrypt-to-client)

At-rest encryption (above) protects the DB. **Delivery encryption** protects values on the
wire: every retrieval response is sealed to the *specific requesting service* so that only
that service's private key can open it. TLS still wraps the transport, but this is
defense-in-depth that does not depend on it — a terminating proxy, a mirrored log, or a
compromised TLS endpoint sees only ciphertext it cannot decrypt.

### One service key, two jobs

A service holds a single Ed25519 private key (issued once at creation). It is used for:

- **Signing** challenge nonces (auth) — Ed25519 directly.
- **Decrypting** retrieval responses — via its **X25519** form, obtained by the standard
  Edwards→Montgomery birational map (`edwardsToMontgomery` in `@noble/curves/ed25519`;
  the libsodium `crypto_sign_ed25519_*_to_curve25519` construction). The server stores the
  derived X25519 **public** key (`services.encPublicKey`); the client derives the matching
  X25519 **private** key from its Ed25519 private key on demand. Neither side transmits it.

Deriving both roles from one key keeps the "service_id + one secret" ergonomics. (If you
prefer strict key separation, issue two keypairs at creation and store both public keys —
the rest of the design is unchanged. Single-key derivation is the default.)

### Sealing a response (server)

```
recipientPk = X25519(service.encPublicKey)
info        = "cuki-secrets-v1" ∥ 0x00 ∥ service_id
aad         = access_token_id ∥ environment_id
payload     = utf8( JSON { keys: [ {name, type, value}, ... ] } )   # value = plaintext, post at-rest decrypt
enc, ct     = HPKE.SealBase(recipientPk, info, aad, payload)        # enc = encapsulated ephemeral key
zeroize(payload)
respond { enc: base64(enc), ciphertext: base64(ct), suite: {...} }
```

The whole batch (public and sensitive keys alike) is sealed in one HPKE operation — one
encapsulation, one AEAD pass — so nothing readable leaves the process.

### Opening a response (client)

```
skR       = edwardsToMontgomeryPriv(service_ed25519_private)
payload   = HPKE.OpenBase(enc, skR, info, aad, ct)
{ keys }  = JSON.parse(payload)
```

The client SDK does this transparently ([`09`](./09-sdk-cli.md)). HPKE is standardized with
implementations in every major language, so non-TS service clients are straightforward.

### What this does and does not guarantee

- **Does:** values are readable in transit only by the holder of the service private key —
  independent of TLS, proxies, or response logging. A stolen access token still can't yield
  plaintext without the service private key, tightening the blast radius further.
- **Does not (in this default design):** make the server zero-knowledge. cuki is the
  custodian — it holds the KEK, decrypts the value at rest, and re-seals it to the client,
  so plaintext exists transiently in server memory at delivery (and during dashboard
  reveal). This is inherent to a dashboard-managed store where keys are defined before, and
  independently of, the services that consume them.

### Optional: zero-knowledge variant (server never sees plaintext)

If you later want the server to never handle plaintext, encrypt values **to reader keys at
write time** instead of under the KEK: when a value is set or a grant is added, the writer
(dashboard client or an admin CLI) HPKE-seals the value to each granted service's X25519
key and uploads only ciphertexts; the server stores and forwards them blindly. Costs and
constraints to accept before choosing this:

- Granting a new service to an existing key requires access to the plaintext to seal a new
  copy (the dashboard must hold or re-derive it) — you cannot grant "server-side only".
- The dashboard can't display/reveal values without client-side key material (a
  user-held master key, password-manager style).
- Rotation and multi-reader fan-out get more complex.

Keep the default (custodian + delivery encryption) unless a threat model specifically
requires the server to be blind; the two can also coexist per-key if needed.

## Operational rules

- **Never log plaintext or the KEK.** `Config.redacted` and a logging filter that drops
  `key_versions.plaintext`/decrypted buffers. Add a lint check for accidental logging of
  crypto types.
- **Zeroization is best-effort in JS.** `Uint8Array.fill(0)` after use reduces exposure
  window but GC/immutability of strings limits guarantees. Prefer `Uint8Array` over
  `string` for plaintext handling; convert to string as late as possible.
- **Constant-time comparisons** for token/nonce/hash equality (`@noble/hashes/utils`
  `equalBytes` or `crypto.timingSafeEqual`).
- **Public keys are not encrypted.** `type: "public"` values live in
  `key_versions.plaintext`. This is by design (config, dashboard-visible). Enforce in the
  UI/docs that secrets must be `sensitive`.
- **Backups:** a DB backup is useless without the KEK — which is the point. Document that
  operators must back up the KEK separately and securely; losing it means losing every
  sensitive value irrecoverably.

## Test vectors (P1 acceptance)

- Round-trip: `decrypt(encrypt(x)) == x` for empty, unicode, 1 MiB inputs.
- AAD binding: decrypting a row with a tampered `keyId` in AAD fails closed.
- Wrong KEK: decrypt under a different KEK fails (no partial/garbage plaintext).
- Rotation: after `kek rotate`, all values still decrypt; `kekVersion` updated; ciphertext
  bytes unchanged.
- Fingerprint guard: booting with a mismatched KEK aborts startup.
