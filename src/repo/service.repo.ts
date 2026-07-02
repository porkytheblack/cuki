import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** Machine identities (services) and their key grants. */
export class ServiceRepo extends Effect.Service<ServiceRepo>()("ServiceRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database

    return {
      // ── services ──
      create: (row: typeof s.services.$inferInsert) =>
        db.insert(s.services).values(row).returning().pipe(Effect.map(head)),

      findById: (id: string) =>
        db.select().from(s.services).where(eq(s.services.id, id)).pipe(Effect.map(head)),

      /** By public handle (`serviceId`, e.g. svc_01H...) — the challenge lookup. */
      findByHandle: (serviceId: string) =>
        db.select().from(s.services).where(eq(s.services.serviceId, serviceId)).pipe(Effect.map(head)),

      listByEnvironment: (environmentId: string) =>
        db.select().from(s.services).where(eq(s.services.environmentId, environmentId)),

      updateStatus: (id: string, status: "active" | "revoked") =>
        db.update(s.services).set({ status }).where(eq(s.services.id, id)),

      updateKeys: (id: string, publicKey: Uint8Array, encPublicKey: Uint8Array) =>
        db.update(s.services).set({ publicKey, encPublicKey }).where(eq(s.services.id, id)),

      updateLastAuth: (id: string, when: Date) =>
        db.update(s.services).set({ lastAuthAt: when }).where(eq(s.services.id, id)),

      delete: (id: string) => db.delete(s.services).where(eq(s.services.id, id)),

      countGrants: (serviceId: string) =>
        db
          .select({ keyId: s.grants.keyId })
          .from(s.grants)
          .where(eq(s.grants.serviceId, serviceId))
          .pipe(Effect.map((rows) => rows.length)),

      // ── grants ──
      addGrants: (rows: ReadonlyArray<typeof s.grants.$inferInsert>) =>
        rows.length === 0
          ? Effect.succeed([])
          : db.insert(s.grants).values([...rows]).returning(),

      listGrants: (serviceId: string) =>
        db
          .select({
            id: s.grants.id,
            keyId: s.grants.keyId,
            keyName: s.keys.name,
            keyType: s.keys.type,
            createdAt: s.grants.createdAt,
          })
          .from(s.grants)
          .innerJoin(s.keys, eq(s.grants.keyId, s.keys.id))
          .where(eq(s.grants.serviceId, serviceId)),

      /** The scope snapshot: key ids currently granted to a service. */
      keyIdsForService: (serviceId: string) =>
        db
          .select({ keyId: s.grants.keyId })
          .from(s.grants)
          .where(eq(s.grants.serviceId, serviceId))
          .pipe(Effect.map((rows) => rows.map((r) => r.keyId))),

      findGrantById: (id: string) =>
        db.select().from(s.grants).where(eq(s.grants.id, id)).pipe(Effect.map(head)),

      deleteGrant: (id: string) => db.delete(s.grants).where(eq(s.grants.id, id)),

      /** Which of these key ids exist in the given environment (env-match invariant). */
      keyIdsInEnvironment: (environmentId: string, keyIds: ReadonlyArray<string>) =>
        keyIds.length === 0
          ? Effect.succeed([] as string[])
          : db
              .select({ id: s.keys.id })
              .from(s.keys)
              .where(and(eq(s.keys.environmentId, environmentId), inArray(s.keys.id, [...keyIds])))
              .pipe(Effect.map((rows) => rows.map((r) => r.id))),

      /** Owning org + environment for RBAC on a service. */
      orgAndEnvForService: (serviceId: string) =>
        db
          .select({
            orgId: s.projects.orgId,
            environmentId: s.environments.id,
            protected: s.environments.protected,
          })
          .from(s.services)
          .innerJoin(s.environments, eq(s.services.environmentId, s.environments.id))
          .innerJoin(s.projects, eq(s.environments.projectId, s.projects.id))
          .where(eq(s.services.id, serviceId))
          .pipe(Effect.map(head)),
    }
  }),
}) {}
