import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import { AuditService } from "../../domain/audit.service"
import { AuthService } from "../../domain/auth.service"
import { CurrentUser } from "../../domain/context"
import { KeyService } from "../../domain/key.service"
import { ManagementService } from "../../domain/management.service"
import { ServiceRegistry } from "../../domain/service-registry"
import { Conflict, NotFound } from "../../errors"
import type { Key, Membership, Service } from "../../db/schema"
import { api } from "../api"
import { clientMeta } from "../req"

const keyRowToMeta = (k: Key) => ({
  id: k.id,
  name: k.name,
  type: k.type,
  currentVersion: k.currentVersion,
  description: k.description,
  updatedAt: k.updatedAt,
  updatedBy: null as string | null,
  value: null as string | null,
})

const serviceToDto = (s: Service, grants: number) => ({
  id: s.id,
  environmentId: s.environmentId,
  name: s.name,
  serviceId: s.serviceId,
  status: s.status,
  ipAllowlist: s.ipAllowlist ?? null,
  lastAuthAt: s.lastAuthAt,
  grants,
  createdAt: s.createdAt,
})

const parseDate = (s: string | undefined, fallback: Date): Date => {
  if (!s) return fallback
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? fallback : d
}

/** Management group: full hierarchy CRUD with RBAC + audit (design 05). */
export const ManagementGroupLive = HttpApiBuilder.group(api, "management", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* AuthService
    const mgmt = yield* ManagementService
    const keys = yield* KeyService
    const registry = yield* ServiceRegistry
    const audit = yield* AuditService

    const authorizeWrite = (orgId: string, isProtected: boolean) =>
      auth.authorize(orgId, isProtected ? "admin" : "member")

    const recordWrite = (
      orgId: string,
      action: string,
      targetType: string | null,
      targetId: string | null,
      environmentId: string | null,
    ) =>
      Effect.gen(function* () {
        const cu = yield* CurrentUser
        const meta = yield* clientMeta
        yield* audit.record({
          orgId,
          actorType: "user",
          actorId: cu.user.id,
          action,
          environmentId,
          targetType,
          targetId,
          result: "success",
          ip: meta.ip,
          userAgent: meta.userAgent,
        })
      })

    return handlers
      // ── orgs ──
      .handle("listOrgs", () =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser
          return yield* mgmt.listOrgs(cu.user.id)
        }),
      )
      .handle("createOrg", ({ payload }) =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser
          return yield* mgmt.createOrg(cu.user.id, payload.name)
        }),
      )
      // ── members ──
      .handle("listMembers", ({ path }) =>
        auth.authorize(path.orgId, "viewer").pipe(Effect.andThen(mgmt.listMembers(path.orgId))),
      )
      .handle("addMember", ({ path, payload }) =>
        Effect.gen(function* () {
          yield* auth.authorize(path.orgId, "admin")
          // Only an owner may grant the owner role (prevents admin self-escalation).
          if (payload.role === "owner") yield* auth.authorize(path.orgId, "owner")
          return yield* mgmt.addMember(path.orgId, payload.email, payload.role)
        }),
      )
      .handle("updateMember", ({ path, payload }) =>
        Effect.gen(function* () {
          yield* auth.authorize(path.orgId, "admin")
          const target = yield* memberInOrg(mgmt, path.orgId, path.id)
          // Touching an owner (promoting to, or changing) requires owner.
          if (target.role === "owner" || payload.role === "owner") {
            yield* auth.authorize(path.orgId, "owner")
          }
          // Never demote the last owner.
          if (target.role === "owner" && payload.role !== "owner") {
            yield* assertNotLastOwner(mgmt, path.orgId)
          }
          return yield* mgmt.updateMember(path.id, payload.role)
        }),
      )
      .handle("removeMember", ({ path }) =>
        Effect.gen(function* () {
          yield* auth.authorize(path.orgId, "admin")
          const target = yield* memberInOrg(mgmt, path.orgId, path.id)
          if (target.role === "owner") {
            yield* auth.authorize(path.orgId, "owner")
            yield* assertNotLastOwner(mgmt, path.orgId)
          }
          yield* mgmt.removeMember(path.id)
        }),
      )
      // ── projects ──
      .handle("listProjects", ({ path }) =>
        auth.authorize(path.orgId, "viewer").pipe(Effect.andThen(mgmt.listProjects(path.orgId))),
      )
      .handle("createProject", ({ path, payload }) =>
        auth
          .authorize(path.orgId, "member")
          .pipe(Effect.andThen(mgmt.createProject(path.orgId, payload.name))),
      )
      .handle("deleteProject", ({ path }) =>
        Effect.gen(function* () {
          const orgId = yield* mgmt.orgForProjectOrFail(path.id)
          yield* auth.authorize(orgId, "owner")
          yield* mgmt.deleteProject(path.id)
        }),
      )
      // ── environments ──
      .handle("listEnvironments", ({ path }) =>
        Effect.gen(function* () {
          const orgId = yield* mgmt.orgForProjectOrFail(path.id)
          yield* auth.authorize(orgId, "viewer")
          return yield* mgmt.listEnvironments(path.id)
        }),
      )
      .handle("createEnvironment", ({ path, payload }) =>
        Effect.gen(function* () {
          const orgId = yield* mgmt.orgForProjectOrFail(path.id)
          yield* auth.authorize(orgId, "member")
          return yield* mgmt.createEnvironment(path.id, payload.name, payload.protected ?? false)
        }),
      )
      .handle("deleteEnvironment", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* mgmt.orgForEnvironmentOrFail(path.id)
          yield* auth.authorize(oe.orgId, "admin")
          yield* mgmt.deleteEnvironment(path.id)
        }),
      )
      // ── keys ──
      .handle("listKeys", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* mgmt.orgForEnvironmentOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          const rows = yield* keys.listForEnvironment(path.id)
          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            type: r.type,
            currentVersion: r.currentVersion,
            description: r.description,
            updatedAt: r.updatedAt,
            updatedBy: r.createdBy,
            value: r.type === "public" ? r.plaintext : null,
          }))
        }),
      )
      .handle("createKey", ({ path, payload }) =>
        Effect.gen(function* () {
          const env = yield* mgmt.environmentOrFail(path.id)
          const oe = yield* mgmt.orgForEnvironmentOrFail(path.id)
          yield* authorizeWrite(oe.orgId, env.protected)
          const cu = yield* CurrentUser
          const key = yield* keys
            .create(
              path.id,
              { name: payload.name, type: payload.type, value: payload.value, description: payload.description },
              cu.user.id,
            )
            .pipe(Effect.catchTag("CryptoError", (e) => Effect.die(e)))
          yield* recordWrite(oe.orgId, "key.write", "key", key.id, path.id)
          return keyRowToMeta(key)
        }),
      )
      .handle("getKey", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          const detail = yield* keys.get(path.id)
          return { key: keyRowToMeta(detail.key), versions: detail.versions }
        }),
      )
      .handle("setKeyValue", ({ path, payload }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* authorizeWrite(oe.orgId, oe.protected)
          const cu = yield* CurrentUser
          const key = yield* keys
            .setValue(path.id, payload.value, cu.user.id)
            .pipe(Effect.catchTag("CryptoError", (e) => Effect.die(e)))
          yield* recordWrite(oe.orgId, "key.write", "key", key.id, oe.environmentId)
          return keyRowToMeta(key)
        }),
      )
      .handle("deleteKey", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* authorizeWrite(oe.orgId, oe.protected)
          yield* keys.delete(path.id)
          yield* recordWrite(oe.orgId, "key.delete", "key", path.id, oe.environmentId)
        }),
      )
      .handle("revealKey", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* auth.authorize(oe.orgId, "admin")
          const value = yield* keys
            .reveal(path.id)
            .pipe(Effect.catchTag("CryptoError", (e) => Effect.die(e)))
          yield* recordWrite(oe.orgId, "secret.reveal", "key", path.id, oe.environmentId)
          return { value }
        }),
      )
      .handle("rollbackKey", ({ path, payload }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* authorizeWrite(oe.orgId, oe.protected)
          const key = yield* keys.rollback(path.id, payload.version)
          yield* recordWrite(oe.orgId, "key.rollback", "key", path.id, oe.environmentId)
          return keyRowToMeta(key)
        }),
      )
      .handle("keyAccess", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* keys.orgForKeyOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          return yield* audit.keyAccess(oe.orgId, path.id)
        }),
      )
      // ── services ──
      .handle("listServices", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* mgmt.orgForEnvironmentOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          const rows = yield* registry.listForEnvironment(path.id)
          return rows.map((r) => serviceToDto(r, r.grants))
        }),
      )
      .handle("createService", ({ path, payload }) =>
        Effect.gen(function* () {
          const oe = yield* mgmt.orgForEnvironmentOrFail(path.id)
          yield* auth.authorize(oe.orgId, "member")
          const { service, privateKey } = yield* registry.create(
            path.id,
            payload.name,
            payload.ipAllowlist ?? null,
          )
          yield* recordWrite(oe.orgId, "service.create", "service", service.id, path.id)
          return { service: serviceToDto(service, 0), privateKey }
        }),
      )
      .handle("rotateServiceKey", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          yield* auth.authorize(oe.orgId, "admin")
          const result = yield* registry.rotateKey(path.id)
          yield* recordWrite(oe.orgId, "service.rotate_key", "service", path.id, oe.environmentId)
          return result
        }),
      )
      .handle("revokeService", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          yield* auth.authorize(oe.orgId, "admin")
          const svc = yield* registry.revoke(path.id)
          yield* recordWrite(oe.orgId, "service.revoke", "service", path.id, oe.environmentId)
          return serviceToDto(svc, svc.grants)
        }),
      )
      .handle("deleteService", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          yield* auth.authorize(oe.orgId, "admin")
          yield* registry.delete(path.id)
          yield* recordWrite(oe.orgId, "service.delete", "service", path.id, oe.environmentId)
        }),
      )
      .handle("listGrants", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          return yield* registry.listGrants(path.id)
        }),
      )
      .handle("addGrants", ({ path, payload }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          // Granting a service access to a protected env's secrets is a protected-env write.
          yield* authorizeWrite(oe.orgId, oe.protected)
          const cu = yield* CurrentUser
          const grants = yield* registry.addGrants(path.id, payload.keyIds, cu.user.id)
          yield* recordWrite(oe.orgId, "grant.add", "service", path.id, oe.environmentId)
          return grants
        }),
      )
      .handle("deleteGrant", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForGrantOrFail(path.id)
          yield* auth.authorize(oe.orgId, "member")
          yield* registry.deleteGrant(path.id)
          yield* recordWrite(oe.orgId, "grant.remove", "grant", path.id, oe.environmentId)
        }),
      )
      .handle("serviceActivity", ({ path }) =>
        Effect.gen(function* () {
          const oe = yield* registry.orgForServiceOrFail(path.id)
          yield* auth.authorize(oe.orgId, "viewer")
          const svc = yield* registry.getServiceOrFail(path.id)
          return yield* audit.serviceActivity(oe.orgId, svc.serviceId)
        }),
      )
      // ── audit + analytics ──
      .handle("audit", ({ path, urlParams }) =>
        Effect.gen(function* () {
          yield* auth.authorize(path.orgId, "viewer")
          const result = yield* audit.query(path.orgId, {
            actorType: urlParams.actorType,
            action: urlParams.action,
            environmentId: urlParams.environmentId,
            result: urlParams.result,
            from: urlParams.from ? new Date(urlParams.from) : undefined,
            to: urlParams.to ? new Date(urlParams.to) : undefined,
            cursor: urlParams.cursor,
            limit: urlParams.limit,
          })
          return { items: result.items, nextCursor: Option.getOrNull(result.nextCursor) }
        }),
      )
      .handle("analytics", ({ path, urlParams }) =>
        Effect.gen(function* () {
          yield* auth.authorize(path.orgId, "viewer")
          const now = new Date()
          const from = parseDate(urlParams.from, new Date(now.getTime() - 30 * 86400_000))
          const to = parseDate(urlParams.to, now)
          const [readsPerDay, topServices, topKeys] = yield* Effect.all([
            audit.readsPerDay(path.orgId, from, to),
            audit.topServices(path.orgId, from, to),
            audit.topKeys(path.orgId, from, to),
          ])
          return { readsPerDay, topServices, topKeys }
        }),
      )
  }),
)

/** Guard: resolve a member that must belong to the org in the path (prevents cross-org edits). */
const memberInOrg = (
  mgmt: ManagementService,
  orgId: string,
  memberId: string,
): Effect.Effect<Membership, NotFound> =>
  mgmt.getMembership(memberId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new NotFound({ resource: `member:${memberId}` })),
        onSome: (m) =>
          m.orgId === orgId ? Effect.succeed(m) : Effect.fail(new NotFound({ resource: `member:${memberId}` })),
      }),
    ),
  )

/** Guard: refuse an operation that would leave the org with zero owners. */
const assertNotLastOwner = (mgmt: ManagementService, orgId: string): Effect.Effect<void, Conflict> =>
  mgmt.countOwners(orgId).pipe(
    Effect.flatMap((n) =>
      n <= 1 ? Effect.fail(new Conflict({ reason: "cannot remove or demote the last owner" })) : Effect.void,
    ),
  )
