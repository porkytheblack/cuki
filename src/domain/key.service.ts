import { Effect, Option } from "effect"
import { buildSecretsInfo } from "../crypto/constants"
import { CryptoService, valueAad, type EncryptedValue } from "../crypto/crypto.service"
import { SUITE_DESCRIPTOR } from "../crypto/hpke"
import { CryptoError, NotFound } from "../errors"
import { KeyRepo, type KeyWithVersion } from "../repo/key.repo"
import { catchConflict } from "../db/errors"
import type { Key } from "../db/schema"
import { bytesToUtf8, toBase64, utf8ToBytes } from "../util/bytes"
import { dieSqlApi } from "../util/effect"
import { newId } from "../util/id"

export interface CreateKeyInput {
  readonly name: string
  readonly type: "sensitive" | "public"
  readonly value: string
  readonly description?: string | null
}

export interface SealedEnvelope {
  readonly enc: string
  readonly ciphertext: string
  readonly suite: typeof SUITE_DESCRIPTOR
}

/**
 * The key lifecycle (design 05/06): create/rotate/reveal/rollback plus the retrieval read
 * that decrypts at rest and HPKE-seals to the requesting service.
 *
 * Delivery-encryption note: the HPKE `info` binds the payload to the specific service
 * (`cuki-secrets-v1 ∥ 0x00 ∥ service_id`), which the client can reconstruct independently.
 * AAD is left empty because the design's suggested `access_token_id ∥ environment_id` AAD is
 * not known to the client and cannot be reconstructed without transmitting it; the `info`
 * binding already guarantees only the target service can open the payload.
 */
export class KeyService extends Effect.Service<KeyService>()("KeyService", {
  effect: Effect.gen(function* () {
    const keys = yield* KeyRepo
    const crypto = yield* CryptoService

    const getKeyOrFail = (id: string) =>
      keys.findById(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ resource: `key:${id}` })),
            onSome: Effect.succeed,
          }),
        ),
      )

    const encryptedFieldsFor = (row: KeyWithVersion): EncryptedValue | null =>
      row.ciphertext && row.nonce && row.wrappedDek && row.dekNonce && row.kekVersion !== null && row.aead
        ? {
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            wrappedDek: row.wrappedDek,
            dekNonce: row.dekNonce,
            kekVersion: row.kekVersion,
            aead: row.aead,
          }
        : null

    const decryptRow = (row: KeyWithVersion): Effect.Effect<string, CryptoError> => {
      if (row.type === "public") return Effect.succeed(row.plaintext ?? "")
      const enc = encryptedFieldsFor(row)
      if (!enc) return Effect.fail(new CryptoError({ message: "missing ciphertext for sensitive key" }))
      const aad = valueAad(row.id, row.environmentId, row.version)
      return crypto.decrypt(enc, aad).pipe(Effect.map(bytesToUtf8))
    }

    const versionRowFor = (
      keyId: string,
      environmentId: string,
      version: number,
      type: "sensitive" | "public",
      value: string,
      userId: string | null,
    ) =>
      type === "public"
        ? Effect.succeed({ id: newId(), keyId, version, plaintext: value, createdBy: userId })
        : crypto.encrypt(utf8ToBytes(value), valueAad(keyId, environmentId, version)).pipe(
            Effect.map((enc) => ({
              id: newId(),
              keyId,
              version,
              ciphertext: enc.ciphertext,
              nonce: enc.nonce,
              wrappedDek: enc.wrappedDek,
              dekNonce: enc.dekNonce,
              kekVersion: enc.kekVersion,
              aead: enc.aead,
              createdBy: userId,
            })),
          )

    return dieSqlApi({
      listForEnvironment: (environmentId: string) => keys.listWithCurrentByEnvironment(environmentId),

      get: (keyId: string) =>
        Effect.gen(function* () {
          const key = yield* getKeyOrFail(keyId)
          const versions = yield* keys.versionsOf(keyId)
          return {
            key,
            versions: versions
              .map((v) => ({ version: v.version, createdBy: v.createdBy, createdAt: v.createdAt }))
              .sort((a, b) => b.version - a.version),
          }
        }),

      create: (environmentId: string, input: CreateKeyInput, userId: string | null) =>
        Effect.gen(function* () {
          const keyId = newId()
          const version = yield* versionRowFor(
            keyId,
            environmentId,
            1,
            input.type,
            input.value,
            userId,
          )
          yield* keys
            .createWithVersion(
              {
                id: keyId,
                environmentId,
                name: input.name,
                type: input.type,
                description: input.description ?? null,
              },
              version,
            )
            .pipe(catchConflict("a key with this name already exists in the environment"))
          return yield* getKeyOrFail(keyId)
        }),

      setValue: (keyId: string, value: string, userId: string | null) =>
        Effect.gen(function* () {
          const key = yield* getKeyOrFail(keyId)
          const next = (yield* keys.maxVersion(keyId)) + 1
          const version = yield* versionRowFor(
            keyId,
            key.environmentId,
            next,
            key.type,
            value,
            userId,
          )
          yield* keys.addVersion(keyId, version, next)
          return yield* getKeyOrFail(keyId)
        }),

      reveal: (keyId: string) =>
        Effect.gen(function* () {
          const cur = yield* keys.currentVersion(keyId)
          if (Option.isNone(cur)) {
            return yield* Effect.fail(new NotFound({ resource: `key:${keyId}` }))
          }
          return yield* decryptRow(cur.value)
        }),

      rollback: (keyId: string, version: number) =>
        Effect.gen(function* () {
          const key = yield* getKeyOrFail(keyId)
          const target = yield* keys.versionAt(keyId, version)
          if (Option.isNone(target)) {
            return yield* Effect.fail(new NotFound({ resource: `key:${keyId}:v${version}` }))
          }
          yield* keys.setCurrentVersion(keyId, version)
          return yield* getKeyOrFail(keyId)
        }),

      delete: (keyId: string) => Effect.as(keys.delete(keyId), undefined),

      /**
       * Retrieval read: decrypt scoped keys at rest, seal the batch to the service. Returns
       * the sealed envelope + the key ids read (for the audit log).
       */
      readForService: (
        serviceHandle: string,
        recipientX25519Pub: Uint8Array,
        scopeKeyIds: ReadonlyArray<string>,
        filterName?: string,
      ) =>
        Effect.gen(function* () {
          const rows = yield* keys
            .currentVersionsForKeys(scopeKeyIds)
            .pipe(Effect.catchAll(() => Effect.succeed([] as KeyWithVersion[])))
          const selected = filterName ? rows.filter((r) => r.name === filterName) : rows
          if (filterName && selected.length === 0) {
            return yield* Effect.fail(new NotFound({ resource: `key:${filterName}` }))
          }
          const out: Array<{ name: string; type: string; value: string }> = []
          for (const r of selected) {
            const value = yield* decryptRow(r)
            out.push({ name: r.name, type: r.type, value })
          }
          const payloadObj = filterName ? out[0] : { keys: out }
          const info = buildSecretsInfo(serviceHandle)
          const payload = utf8ToBytes(JSON.stringify(payloadObj))
          const sealed = yield* crypto.sealToService(
            recipientX25519Pub,
            info,
            new Uint8Array(0),
            payload,
          )
          return {
            envelope: {
              enc: toBase64(sealed.enc),
              ciphertext: toBase64(sealed.ciphertext),
              suite: SUITE_DESCRIPTOR,
            },
            keyIds: selected.map((r) => r.id),
          }
        }),
    })
  }),
}) {}
