import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../db/sql"
import * as s from "../db/schema"
import { head } from "./util"

/** Projects + environments, plus the joins that resolve a resource's owning org for RBAC. */
export class HierarchyRepo extends Effect.Service<HierarchyRepo>()("HierarchyRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database

    return {
      // ── projects ──
      createProject: (row: typeof s.projects.$inferInsert) =>
        db.insert(s.projects).values(row).returning().pipe(Effect.map(head)),

      listProjectsByOrg: (orgId: string) =>
        db.select().from(s.projects).where(eq(s.projects.orgId, orgId)),

      findProjectById: (id: string) =>
        db.select().from(s.projects).where(eq(s.projects.id, id)).pipe(Effect.map(head)),

      deleteProject: (id: string) => db.delete(s.projects).where(eq(s.projects.id, id)),

      // ── environments ──
      createEnvironment: (row: typeof s.environments.$inferInsert) =>
        db.insert(s.environments).values(row).returning().pipe(Effect.map(head)),

      listEnvironmentsByProject: (projectId: string) =>
        db.select().from(s.environments).where(eq(s.environments.projectId, projectId)),

      findEnvironmentById: (id: string) =>
        db.select().from(s.environments).where(eq(s.environments.id, id)).pipe(Effect.map(head)),

      deleteEnvironment: (id: string) =>
        db.delete(s.environments).where(eq(s.environments.id, id)),

      // ── RBAC resolvers (owning org of a resource) ──
      orgIdForProject: (projectId: string) =>
        db
          .select({ orgId: s.projects.orgId })
          .from(s.projects)
          .where(eq(s.projects.id, projectId))
          .pipe(Effect.map(head)),

      orgIdForEnvironment: (environmentId: string) =>
        db
          .select({ orgId: s.projects.orgId, projectId: s.projects.id })
          .from(s.environments)
          .innerJoin(s.projects, eq(s.environments.projectId, s.projects.id))
          .where(eq(s.environments.id, environmentId))
          .pipe(Effect.map(head)),
    }
  }),
}) {}
