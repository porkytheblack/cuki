import { SqlClient } from "@effect/sql"
import { and, eq, inArray, max } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** The joined shape returned for retrieval + reveal: key metadata + its current value row. */
export interface KeyWithVersion {
  readonly id: string
  readonly environmentId: string
  readonly name: string
  readonly type: "sensitive" | "public"
  readonly version: number
  readonly plaintext: string | null
  readonly ciphertext: Uint8Array | null
  readonly nonce: Uint8Array | null
  readonly wrappedDek: Uint8Array | null
  readonly dekNonce: Uint8Array | null
  readonly kekVersion: number | null
  readonly aead: "xchacha20poly1305" | "aes256gcm" | null
}

const currentVersionColumns = {
  id: s.keys.id,
  environmentId: s.keys.environmentId,
  name: s.keys.name,
  type: s.keys.type,
  version: s.keyVersions.version,
  plaintext: s.keyVersions.plaintext,
  ciphertext: s.keyVersions.ciphertext,
  nonce: s.keyVersions.nonce,
  wrappedDek: s.keyVersions.wrappedDek,
  dekNonce: s.keyVersions.dekNonce,
  kekVersion: s.keyVersions.kekVersion,
  aead: s.keyVersions.aead,
}

export class KeyRepo extends Effect.Service<KeyRepo>()("KeyRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database
    const sql = yield* SqlClient.SqlClient

    return {
      /** Create a key and its first version atomically. */
      createWithVersion: (
        key: typeof s.keys.$inferInsert,
        version: typeof s.keyVersions.$inferInsert,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* db.insert(s.keys).values(key)
            yield* db.insert(s.keyVersions).values(version)
          }),
        ),

      listByEnvironment: (environmentId: string) =>
        db.select().from(s.keys).where(eq(s.keys.environmentId, environmentId)),

      /** Keys in an env joined to their current version (public value shown, sensitive null). */
      listWithCurrentByEnvironment: (environmentId: string) =>
        db
          .select({
            id: s.keys.id,
            name: s.keys.name,
            type: s.keys.type,
            currentVersion: s.keys.currentVersion,
            description: s.keys.description,
            updatedAt: s.keys.updatedAt,
            createdBy: s.keyVersions.createdBy,
            plaintext: s.keyVersions.plaintext,
          })
          .from(s.keys)
          .innerJoin(
            s.keyVersions,
            and(eq(s.keyVersions.keyId, s.keys.id), eq(s.keyVersions.version, s.keys.currentVersion)),
          )
          .where(eq(s.keys.environmentId, environmentId)),

      /** Highest version number for a key (safe next-version after a rollback). */
      maxVersion: (keyId: string) =>
        db
          .select({ v: max(s.keyVersions.version) })
          .from(s.keyVersions)
          .where(eq(s.keyVersions.keyId, keyId))
          .pipe(Effect.map((rows) => rows[0]?.v ?? 0)),

      findById: (id: string) =>
        db.select().from(s.keys).where(eq(s.keys.id, id)).pipe(Effect.map(head)),

      findByEnvAndName: (environmentId: string, name: string) =>
        db
          .select()
          .from(s.keys)
          .where(and(eq(s.keys.environmentId, environmentId), eq(s.keys.name, name)))
          .pipe(Effect.map(head)),

      /** The value row at `keys.currentVersion` for one key. */
      currentVersion: (keyId: string) =>
        db
          .select(currentVersionColumns)
          .from(s.keys)
          .innerJoin(
            s.keyVersions,
            and(eq(s.keyVersions.keyId, s.keys.id), eq(s.keyVersions.version, s.keys.currentVersion)),
          )
          .where(eq(s.keys.id, keyId))
          .pipe(Effect.map((rows) => head(rows as KeyWithVersion[]))),

      /** Batch: current-version rows for a set of key ids (retrieval hot path). */
      currentVersionsForKeys: (keyIds: ReadonlyArray<string>) =>
        keyIds.length === 0
          ? Effect.succeed([] as KeyWithVersion[])
          : db
              .select(currentVersionColumns)
              .from(s.keys)
              .innerJoin(
                s.keyVersions,
                and(
                  eq(s.keyVersions.keyId, s.keys.id),
                  eq(s.keyVersions.version, s.keys.currentVersion),
                ),
              )
              .where(inArray(s.keys.id, [...keyIds]))
              .pipe(Effect.map((rows) => rows as KeyWithVersion[])),

      versionsOf: (keyId: string) =>
        db.select().from(s.keyVersions).where(eq(s.keyVersions.keyId, keyId)),

      versionAt: (keyId: string, version: number) =>
        db
          .select()
          .from(s.keyVersions)
          .where(and(eq(s.keyVersions.keyId, keyId), eq(s.keyVersions.version, version)))
          .pipe(Effect.map(head)),

      /** Append a new version and point `currentVersion` at it, atomically. */
      addVersion: (
        keyId: string,
        version: typeof s.keyVersions.$inferInsert,
        newVersionNumber: number,
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* db.insert(s.keyVersions).values(version)
            yield* db
              .update(s.keys)
              .set({ currentVersion: newVersionNumber, updatedAt: new Date() })
              .where(eq(s.keys.id, keyId))
          }),
        ),

      /** Rollback: point `currentVersion` at an existing version. */
      setCurrentVersion: (keyId: string, version: number) =>
        db
          .update(s.keys)
          .set({ currentVersion: version, updatedAt: new Date() })
          .where(eq(s.keys.id, keyId)),

      delete: (id: string) => db.delete(s.keys).where(eq(s.keys.id, id)),

      /** Owning org + environment (+ protected flag) for RBAC on a key. */
      orgAndEnvForKey: (keyId: string) =>
        db
          .select({
            orgId: s.projects.orgId,
            environmentId: s.environments.id,
            protected: s.environments.protected,
          })
          .from(s.keys)
          .innerJoin(s.environments, eq(s.keys.environmentId, s.environments.id))
          .innerJoin(s.projects, eq(s.environments.projectId, s.projects.id))
          .where(eq(s.keys.id, keyId))
          .pipe(Effect.map(head)),

      /** All key ids in an environment (used to validate grant env-match). */
      idsInEnvironment: (environmentId: string) =>
        db
          .select({ id: s.keys.id })
          .from(s.keys)
          .where(eq(s.keys.environmentId, environmentId)),

      // ── KEK rotation ──

      /** Sensitive versions wrapped by a given KEK version, with fields for re-wrapping. */
      sensitiveVersionsByKek: (kekVersion: number) =>
        db
          .select({
            versionId: s.keyVersions.id,
            keyId: s.keyVersions.keyId,
            environmentId: s.keys.environmentId,
            version: s.keyVersions.version,
            ciphertext: s.keyVersions.ciphertext,
            nonce: s.keyVersions.nonce,
            wrappedDek: s.keyVersions.wrappedDek,
            dekNonce: s.keyVersions.dekNonce,
            kekVersion: s.keyVersions.kekVersion,
            aead: s.keyVersions.aead,
          })
          .from(s.keyVersions)
          .innerJoin(s.keys, eq(s.keyVersions.keyId, s.keys.id))
          .where(eq(s.keyVersions.kekVersion, kekVersion)),

      updateWrap: (versionId: string, wrappedDek: Uint8Array, dekNonce: Uint8Array, kekVersion: number) =>
        db
          .update(s.keyVersions)
          .set({ wrappedDek, dekNonce, kekVersion })
          .where(eq(s.keyVersions.id, versionId)),
    }
  }),
}) {}
