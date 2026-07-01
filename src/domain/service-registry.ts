import { Effect, Option } from "effect"
import { generateServiceKeypair } from "../crypto/keys"
import { Conflict, NotFound } from "../errors"
import { AuthStateRepo } from "../repo/authstate.repo"
import { ServiceRepo } from "../repo/service.repo"
import type { Service } from "../db/schema"
import { toBase64 } from "../util/bytes"
import { dieSqlApi } from "../util/effect"
import { newHandle, newId } from "../util/id"

/**
 * Service identities + grants (design 04/05). Generates the Ed25519 keypair, stores only the
 * public keys, and returns the private key exactly once. Enforces the grant env-match
 * invariant: a service can only be granted keys in its own environment.
 */
export class ServiceRegistry extends Effect.Service<ServiceRegistry>()("ServiceRegistry", {
  effect: Effect.gen(function* () {
    const services = yield* ServiceRepo
    const authState = yield* AuthStateRepo

    const getServiceOrFail = (id: string) =>
      services.findById(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ resource: `service:${id}` })),
            onSome: Effect.succeed,
          }),
        ),
      )

    return dieSqlApi({
      getServiceOrFail,

      /** Owning org (+ env + protected flag) for RBAC on a service. */
      orgForServiceOrFail: (serviceId: string) =>
        services.orgAndEnvForService(serviceId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ resource: `service:${serviceId}` })),
              onSome: Effect.succeed,
            }),
          ),
        ),

      listForEnvironment: (environmentId: string) =>
        Effect.gen(function* () {
          const rows = yield* services.listByEnvironment(environmentId)
          return yield* Effect.forEach(rows, (svc) =>
            services.countGrants(svc.id).pipe(Effect.map((grants) => ({ ...svc, grants }))),
          )
        }),

      /** Create a service; returns it plus the one-time private key (base64). */
      create: (
        environmentId: string,
        name: string,
        ipAllowlist: ReadonlyArray<string> | null,
      ) =>
        Effect.gen(function* () {
          const kp = generateServiceKeypair()
          const created = yield* services.create({
            id: newId(),
            environmentId,
            name,
            serviceId: newHandle("svc"),
            publicKey: kp.publicKey,
            encPublicKey: kp.encPublicKey,
            ipAllowlist: ipAllowlist ? [...ipAllowlist] : null,
          })
          if (Option.isNone(created)) {
            return yield* Effect.fail(new NotFound({ resource: "service" }))
          }
          return { service: created.value, privateKey: toBase64(kp.privateKey) }
        }),

      /** Rotate the keypair; returns the new private key once. Existing tokens live out TTL. */
      rotateKey: (serviceId: string) =>
        Effect.gen(function* () {
          const svc = yield* getServiceOrFail(serviceId)
          const kp = generateServiceKeypair()
          yield* services.updateKeys(svc.id, kp.publicKey, kp.encPublicKey)
          return { privateKey: toBase64(kp.privateKey) }
        }),

      /** Revoke: mark the service revoked and revoke all its outstanding access tokens. */
      revoke: (serviceId: string) =>
        Effect.gen(function* () {
          const svc = yield* getServiceOrFail(serviceId)
          yield* services.updateStatus(svc.id, "revoked")
          yield* authState.revokeAllForService(svc.id, new Date()).pipe(Effect.ignore)
          const grants = yield* services.countGrants(svc.id)
          return { ...svc, status: "revoked" as const, grants }
        }),

      /** Owning org (+ env + protected) of a grant's service, for RBAC on grant deletion. */
      orgForGrantOrFail: (grantId: string) =>
        Effect.gen(function* () {
          const grant = yield* services.findGrantById(grantId)
          if (Option.isNone(grant)) {
            return yield* Effect.fail(new NotFound({ resource: `grant:${grantId}` }))
          }
          const oe = yield* services.orgAndEnvForService(grant.value.serviceId)
          if (Option.isNone(oe)) {
            return yield* Effect.fail(new NotFound({ resource: `grant:${grantId}` }))
          }
          return oe.value
        }),

      delete: (serviceId: string) => Effect.as(services.delete(serviceId), undefined),

      listGrants: (serviceId: string) => services.listGrants(serviceId),

      /** Add grants, enforcing env-match and skipping keys already granted. */
      addGrants: (serviceId: string, keyIds: ReadonlyArray<string>, userId: string | null) =>
        Effect.gen(function* () {
          const svc = yield* getServiceOrFail(serviceId)
          const validKeyIds = yield* services.keyIdsInEnvironment(svc.environmentId, keyIds)
          const validSet = new Set(validKeyIds)
          const invalid = keyIds.filter((k) => !validSet.has(k))
          if (invalid.length > 0) {
            return yield* Effect.fail(
              new Conflict({ reason: `keys not in service environment: ${invalid.join(", ")}` }),
            )
          }
          const existing = new Set(yield* services.keyIdsForService(svc.id))
          const toAdd = validKeyIds.filter((k) => !existing.has(k))
          yield* services.addGrants(
            toAdd.map((keyId) => ({ id: newId(), serviceId: svc.id, keyId, createdBy: userId })),
          )
          return yield* services.listGrants(svc.id)
        }),

      deleteGrant: (grantId: string) =>
        Effect.gen(function* () {
          const grant = yield* services.findGrantById(grantId)
          if (Option.isNone(grant)) {
            return yield* Effect.fail(new NotFound({ resource: `grant:${grantId}` }))
          }
          yield* services.deleteGrant(grantId)
        }),
    })
  }),
}) {}
