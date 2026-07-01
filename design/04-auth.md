# 04 — Authentication & authorization

Two independent mechanisms. Do not let them bleed into each other.

- **Management plane** → **user sessions** + **RBAC**. Humans, via the dashboard.
- **Retrieval plane** → **Ed25519 challenge–response** → **short-lived access token**.
  Machines, via the SDK/CLI.

---

## Part A — User auth (management plane)

### Login

- Email + password. `passwordHash` = Argon2id (memory ≥ 19 MiB, iterations tuned).
- On success, create a `sessions` row: random 32-byte token, store `SHA-256(token)`,
  set `expiresAt` (e.g. 7 days, sliding). Return the raw token as an `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie (dashboard) — or as a bearer for API clients.
- SSO/OIDC is a later add: same `sessions` outcome, `passwordHash` null.

### Session validation

Every management request: read cookie/bearer → `SHA-256` → look up unexpired session →
load user + memberships. Attach `{ user, memberships }` to the request context as an
Effect service (`CurrentUser`). Missing/expired → `401`.

### RBAC

Authorization is per **organization**, via `memberships.role`:

| Role | Read keys/config | Write keys | Manage services/grants | Manage members | Delete project/org |
|------|------------------|-----------|------------------------|----------------|--------------------|
| `viewer` | ✓ (public values; sensitive metadata only, never plaintext) | ✗ | ✗ | ✗ | ✗ |
| `member` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `admin`  | ✓ | ✓ | ✓ | ✓ | ✗ |
| `owner`  | ✓ | ✓ | ✓ | ✓ | ✓ |

Key rules:

- **No one reads a sensitive value's plaintext through the management plane.** The
  dashboard shows sensitive keys as `••••••` with metadata (name, version, updated_at,
  who set it). A `reveal` action is a separate, audited, admin-gated endpoint
  (`POST /v1/keys/:id/reveal`) that decrypts on demand and logs `secret.reveal`. This
  keeps day-to-day dashboard use free of plaintext and makes reveals conspicuous.
- Every resource access resolves the owning org and checks the caller's role there.
  Implement as an Effect `authorize(org, minRole)` guard used by every management handler.
- `protected` environments (prod) require `admin`+ for writes even for `member`s — a
  belt-and-suspenders guard; configurable.

---

## Part B — Service auth (retrieval plane)

The design goal: a service proves possession of its private key without ever sending it,
the proof can't be replayed, and success yields a narrowly-scoped, short-lived token.

### Service creation (one-time secret handoff)

When a user creates a service:

1. cuki generates an Ed25519 keypair.
2. Derives the matching X25519 public key (Edwards→Montgomery) and stores both
   `services.publicKey` (Ed25519, verifies signatures) and `services.encPublicKey` (X25519,
   the recipient key for sealed retrieval responses) — plus `serviceId`, env, name.
   **Discards the private key.**
3. Returns `{ service_id, private_key }` to the operator **once**, in the API response,
   never retrievable again. The dashboard shows a copy-once modal and a download of a
   `cuki.svc` credential file. This mirrors the AWS "secret access key shown once" model.

The single private key *is* the "service secret" from the original spec. It signs
challenges (Ed25519) and decrypts sealed secret payloads (via its derived X25519 form) —
one secret, two jobs ([`03`](./03-cryptography.md)). cuki never holds anything that can
impersonate the service or open its payloads.

### The challenge–response flow

```mermaid
sequenceDiagram
  participant S as Service
  participant R as cuki retrieval API
  S->>R: POST /v1/auth/challenge {service_id}
  Note over R: service active? ip allowed?<br/>rate-limit ok?
  R->>R: nonce = random(32)<br/>store challenge {exp = now+30s, single-use}
  R-->>S: {challenge_id, nonce, algorithm:"ed25519", expires_at}
  S->>S: msg = DS ∥ 0x00 ∥ service_id ∥ 0x00 ∥ nonce<br/>sig = Ed25519_sign(priv, msg)
  S->>R: POST /v1/auth/token {challenge_id, signature}
  R->>R: load challenge (unexpired, unconsumed)<br/>reconstruct msg with stored service_id + nonce<br/>verify sig vs services.publicKey<br/>mark consumed (single-use)
  R->>R: token = random(32); store SHA-256(token)<br/>scope = current grant key ids; exp = now+10m
  R-->>S: {access_token, token_type:"Bearer", expires_in, expires_at}
```

**Signing message** (`DS` = domain-separation tag, the ASCII bytes `cuki-auth-v1`):

```
msg = "cuki-auth-v1" ∥ 0x00 ∥ service_id ∥ 0x00 ∥ nonce
```

Domain separation + binding `service_id` prevents the signature being reused in any other
context or for another service. The server reconstructs `msg` from its own stored
`service_id` and `nonce` — it never trusts a client-supplied message.

### Why challenge–response (not just "sign a timestamp")

A server-issued nonce guarantees freshness and single use without the server having to
remember every signature it's ever seen. Marking the `challenge` consumed makes replay
impossible even within clock skew, and there's no shared clock dependency. This is why the
original spec's instinct is correct.

### Retrieval

```
GET /v1/secrets               → all granted keys for the service's environment
GET /v1/secrets/:name         → one granted key by name
Authorization: Bearer <access_token>
```

Handler: hash the bearer → look up unexpired, unrevoked `access_tokens` → read
`scopeKeyIds` (snapshot at issue time) → load those `keys` + `currentVersion` rows →
decrypt sensitive values at rest ([`03`](./03-cryptography.md)) → assemble the plaintext
batch → **HPKE-seal the batch to the service's `encPublicKey`** → return the sealed
envelope. Append one `audit_logs` row (`secret.read`, the key ids, ip, ua, result).

Response shape — sealed, opaque to anyone but this service:

```json
{
  "enc": "base64(hpke_encapsulated_key)",
  "ciphertext": "base64(aead(JSON{keys:[...]}))",
  "suite": { "kem": "x25519-hkdf-sha256", "kdf": "hkdf-sha256", "aead": "chacha20poly1305" }
}
```

The client opens it with the X25519 private key derived from its service key, yielding:

```json
{ "keys": [
  { "name": "DATABASE_URL", "type": "sensitive", "value": "postgres://..." },
  { "name": "LOG_LEVEL",    "type": "public",    "value": "info" }
] }
```

### Token lifecycle & revocation

- TTL ~10 min (configurable). Client re-runs challenge→token when expired (SDK does this
  transparently, [`09`](./09-sdk-cli.md)).
- **Scope is a snapshot** taken at issue time. Changing grants doesn't retroactively widen
  an existing token; the next token reflects the change. Narrowing takes effect within one
  token TTL — or immediately via revocation.
- **Revocation:** revoking a service sets `status=revoked` and marks all its
  `access_tokens.revokedAt = now`; subsequent reads 401. Individual token revoke also
  supported. Opaque server-side tokens (vs. JWT) are chosen precisely for this instant
  revocability — worth the one indexed DB lookup per read.

### Abuse controls (retrieval plane)

- **Rate limit** `challenge` and `token` per `service_id` and per source IP; exponential
  backoff / temporary lockout after repeated `auth.fail`.
- **Optional IP allowlist** per service (`services.ipAllowlist`, CIDRs) — reject at
  `challenge`.
- **Audit every failure** (`auth.fail` with a reason code: `unknown_service`,
  `revoked`, `challenge_expired`, `challenge_consumed`, `bad_signature`, `ip_denied`).
  These power the dashboard's security view and alerting.
- Constant-time comparison on token-hash lookups; generic error messages (don't leak
  whether a `service_id` exists vs. signature was wrong — return the same `401` shape).
