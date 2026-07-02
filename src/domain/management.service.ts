import { Effect, Option } from "effect"
import { catchConflict } from "../db/errors"
import { NotFound } from "../errors"
import type { Role } from "../errors"
import { AccountRepo } from "../repo/account.repo"
import { HierarchyRepo } from "../repo/hierarchy.repo"
import { toBase64 } from "../util/bytes"
import { dieSqlApi } from "../util/effect"
import { newId } from "../util/id"
import { random } from "../crypto/keys"
import { slugify } from "../util/slug"

/**
 * Tenancy + hierarchy CRUD for the management plane (orgs, members, projects, environments)
 * and the org-resolvers RBAC guards depend on. RBAC itself is enforced in handlers, which
 * have `CurrentUser`; this service just does clean, conflict-aware data operations.
 */
export class ManagementService extends Effect.Service<ManagementService>()("ManagementService", {
  effect: Effect.gen(function* () {
    const accounts = yield* AccountRepo
    const hier = yield* HierarchyRepo

    const shortRand = () => toBase64(random(3)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toLowerCase()

    return dieSqlApi({
      // ── orgs ──
      listOrgs: (userId: string) =>
        accounts
          .listOrgsForUser(userId)
          .pipe(Effect.map((rows) => rows.map((r) => ({ ...r.org, role: r.role })))),

      createOrg: (userId: string, name: string) =>
        Effect.gen(function* () {
          const orgId = newId()
          const org = {
            id: orgId,
            name,
            slug: `${slugify(name)}-${shortRand()}`,
            createdAt: new Date(),
          }
          yield* accounts
            .createOrgWithOwner(org, { id: newId(), orgId, userId, role: "owner" })
            .pipe(catchConflict("organization slug already taken"))
          return { ...org, role: "owner" as Role }
        }),

      // ── members ──
      listMembers: (orgId: string) => accounts.listMembers(orgId),

      addMember: (orgId: string, email: string, role: Role) =>
        Effect.gen(function* () {
          const user = yield* accounts.findUserByEmail(email)
          if (Option.isNone(user)) {
            return yield* Effect.fail(new NotFound({ resource: `user:${email}` }))
          }
          const created = yield* accounts
            .createMembership({ id: newId(), orgId, userId: user.value.id, role })
            .pipe(catchConflict("user is already a member"))
          const m = Option.getOrThrow(created)
          return {
            id: m.id,
            userId: user.value.id,
            email: user.value.email,
            name: user.value.name,
            role: m.role,
            createdAt: m.createdAt,
          }
        }),

      updateMember: (memberId: string, role: Role) =>
        Effect.gen(function* () {
          const updated = yield* accounts.updateMemberRole(memberId, role)
          if (Option.isNone(updated)) {
            return yield* Effect.fail(new NotFound({ resource: `member:${memberId}` }))
          }
          const m = updated.value
          const user = yield* accounts.findUserById(m.userId)
          return {
            id: m.id,
            userId: m.userId,
            email: Option.match(user, { onNone: () => "", onSome: (u) => u.email }),
            name: Option.match(user, { onNone: () => "", onSome: (u) => u.name }),
            role: m.role,
            createdAt: m.createdAt,
          }
        }),

      removeMember: (memberId: string) => Effect.as(accounts.deleteMembership(memberId), undefined),

      memberOrgId: (memberId: string) =>
        accounts.findMembershipById(memberId).pipe(Effect.map(Option.map((m) => m.orgId))),

      /** The full membership row (for cross-org + owner-protection checks in handlers). */
      getMembership: (memberId: string) => accounts.findMembershipById(memberId),

      countOwners: (orgId: string) => accounts.countOwners(orgId),

      // ── projects ──
      listProjects: (orgId: string) => hier.listProjectsByOrg(orgId),

      createProject: (orgId: string, name: string) =>
        Effect.gen(function* () {
          const project = {
            id: newId(),
            orgId,
            name,
            slug: slugify(name),
            createdAt: new Date(),
          }
          yield* hier
            .createProject(project)
            .pipe(catchConflict("a project with this name already exists"))
          return project
        }),

      deleteProject: (projectId: string) => Effect.as(hier.deleteProject(projectId), undefined),

      orgForProjectOrFail: (projectId: string) =>
        hier.orgIdForProject(projectId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ resource: `project:${projectId}` })),
              onSome: (r) => Effect.succeed(r.orgId),
            }),
          ),
        ),

      // ── environments ──
      listEnvironments: (projectId: string) => hier.listEnvironmentsByProject(projectId),

      createEnvironment: (projectId: string, name: string, isProtected: boolean) =>
        Effect.gen(function* () {
          const environment = {
            id: newId(),
            projectId,
            name,
            slug: slugify(name),
            protected: isProtected,
            createdAt: new Date(),
          }
          yield* hier
            .createEnvironment(environment)
            .pipe(catchConflict("an environment with this name already exists"))
          return environment
        }),

      deleteEnvironment: (environmentId: string) =>
        Effect.as(hier.deleteEnvironment(environmentId), undefined),

      orgForEnvironmentOrFail: (environmentId: string) =>
        hier.orgIdForEnvironment(environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ resource: `environment:${environmentId}` })),
              onSome: Effect.succeed,
            }),
          ),
        ),

      environmentOrFail: (environmentId: string) =>
        hier.findEnvironmentById(environmentId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ resource: `environment:${environmentId}` })),
              onSome: Effect.succeed,
            }),
          ),
        ),
    })
  }),
}) {}
